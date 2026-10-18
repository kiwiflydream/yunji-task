import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { app } from '../src/app'
import { getRun, listRuns, type RunMessage } from '../src/domain/runs-repo'
import { getTask } from '../src/domain/tasks-repo'
import { processRun } from '../src/executor/consumer'
import { effectiveMode, executionMode, WORKER_MAX_TIMEOUT_MS } from '../src/executor/mode'
import { executeInWorker } from '../src/executor/run-executor'
import type { ExecutionMode } from '../src/shared/types'
import type { PendingRun, TaskScheduler } from '../src/scheduler/task-scheduler'
import { emptyTaskForm } from '../web/src/lib/task-form'
import { createTaskRow, setRuntimeSettings, toSnapshot } from './helpers'

afterEach(() => vi.restoreAllMocks())

const AUTH = { authorization: `Bearer ${env.API_TOKEN}`, 'content-type': 'application/json' }
const call = (path: string, init: RequestInit = {}, e: CloudflareBindings = env) =>
  app.request(`http://yunji-task.test/api${path}`, { ...init, headers: { ...AUTH, ...init.headers } }, e)

const YEARLY = { type: 'cron', cron: '0 0 0 1 1 *', timezone: 'UTC' } as const
const SHORT_HTTP = (url = 'https://downstream.test/hook') => ({
  type: 'http' as const,
  config: { url, timeoutMs: 10_000 },
})

/** Give a scheduler a recording queue, which worker mode must not use. */
async function instrument(stub: DurableObjectStub<TaskScheduler>, mode?: ExecutionMode) {
  if (mode) await setRuntimeSettings({ executionMode: mode })
  const sent: RunMessage[] = []
  await runInDurableObject(stub, (instance: TaskScheduler, state) => {
    const real = (instance as unknown as { env: CloudflareBindings }).env
    Object.defineProperty(instance, 'env', {
      value: Object.create(real, {
        RUN_QUEUE: { value: { send: async (m: RunMessage) => void sent.push(m) } },
      }),
      configurable: true,
    })
  })
  return { sent }
}

const settled = (taskId: string, status: string, attempt = 1) =>
  vi.waitFor(
    async () => {
      const runs = await listRuns(env.DB, taskId, { limit: 10 })
      expect(runs.map((r) => [r.status, r.attempt])).toContainEqual([status, attempt])
    },
    { timeout: 3000, interval: 20 },
  )

const pending = (stub: DurableObjectStub<TaskScheduler>) =>
  runInDurableObject(stub, async (_i: TaskScheduler, state) => [
    ...(await state.storage.list<PendingRun>({ prefix: 'pending:' })).values(),
  ])

describe('worker mode', () => {
  it('runs a scheduled run in the RunExecutor Worker, records it and releases the slot', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      calls.push(new Request(input).url)
      return new Response('ok')
    })
    const task = await createTaskRow({ executionMode: 'worker', executor: SHORT_HTTP() })
    const stub = env.TASK_SCHEDULER.getByName(task.id)
    await stub.sync(toSnapshot(task))
    const { sent } = await instrument(stub)

    await runDurableObjectAlarm(stub)
    await settled(task.id, 'success')
    expect(calls).toEqual(['https://downstream.test/hook'])
    expect(sent).toEqual([])
    await vi.waitFor(async () => expect((await stub.status()).running).toBeNull(), { timeout: 3000, interval: 20 })
  })

  it('keeps a retry reported by the Worker as a worker-mode pending attempt and hands it out when due', async () => {
    const statuses = [500, 200]
    let n = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('x', { status: statuses[n++] }))
    const task = await createTaskRow({
      schedule: YEARLY,
      executionMode: 'worker',
      executor: SHORT_HTTP(),
      retry: { count: 1, intervalSeconds: 60 },
    })
    const stub = env.TASK_SCHEDULER.getByName(task.id)
    await stub.sync(toSnapshot(task))
    const { sent } = await instrument(stub)

    await runDurableObjectAlarm(stub)
    await settled(task.id, 'retrying')
    await vi.waitFor(async () => expect(await pending(stub)).toHaveLength(1), { timeout: 3000, interval: 20 })
    const [retry] = await pending(stub)
    expect(retry).toMatchObject({ mode: 'worker', deliveries: 0, msg: { attempt: 2 } })
    expect((await stub.status()).alarmAt).toBe(retry.dueAt)

    await runDurableObjectAlarm(stub)
    await settled(task.id, 'success', 2)
    expect(await pending(stub)).toEqual([])
    expect(sent).toEqual([])
  })

  it('an infrastructure error in the Worker is redelivered through the DO', async () => {
    const task = await createTaskRow({ schedule: YEARLY, executionMode: 'worker', executor: SHORT_HTTP() })
    const stub = env.TASK_SCHEDULER.getByName(task.id)
    await stub.sync(toSnapshot(task))
    const brokenDb = { prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error('D1 is down')) }) }) }
    const brokenEnv = Object.create(env, { DB: { value: brokenDb } }) as CloudflareBindings
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const msg: RunMessage = { runId: crypto.randomUUID(), taskId: task.id, trigger: 'schedule', scheduledAt: 1, attempt: 1 }

    await executeInWorker(brokenEnv, msg, 0)
    expect(await pending(stub)).toMatchObject([{ mode: 'worker', deliveries: 1, msg: { runId: msg.runId } }])
    // The last allowed delivery is not redelivered again.
    await runInDurableObject(stub, (_i: TaskScheduler, state) => state.storage.delete(`pending:${msg.runId}`))
    await executeInWorker(brokenEnv, msg, 2)
    expect(await pending(stub)).toEqual([])
  })

  it('manual triggers are handed to the Worker, and so are their retries', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('x', { status: 500 }))
    const task = await createTaskRow({
      schedule: { type: 'manual' },
      executionMode: 'worker',
      executor: SHORT_HTTP(),
      retry: { count: 1, intervalSeconds: 60 },
    })
    const sent: RunMessage[] = []
    const e = Object.create(env, { RUN_QUEUE: { value: { send: async (m: RunMessage) => void sent.push(m) } } })
    expect((await call(`/tasks/${task.id}/trigger`, { method: 'POST' }, e)).status).toBe(202)
    await settled(task.id, 'retrying')
    const stub = env.TASK_SCHEDULER.getByName(task.id)
    await vi.waitFor(async () => expect(await pending(stub)).toMatchObject([{ mode: 'worker', msg: { trigger: 'manual' } }]), {
      timeout: 3000,
      interval: 20,
    })
    expect(sent).toEqual([])
  })

  it('the entrypoint answers before the HTTP call finishes', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await gate
      return new Response('ok')
    })
    const task = await createTaskRow({ schedule: { type: 'manual' }, executor: SHORT_HTTP() })
    const msg: RunMessage = { runId: crypto.randomUUID(), taskId: task.id, trigger: 'manual', scheduledAt: Date.now(), attempt: 1 }
    const stub = env.TASK_SCHEDULER.getByName(task.id)

    // Returns while the downstream request is still blocked.
    await runInDurableObject(stub, (_i: TaskScheduler, state) => state.exports.RunExecutor.start(msg, 0))
    await vi.waitFor(async () => expect((await listRuns(env.DB, task.id, { limit: 1 }))[0]?.status).toBe('running'), {
      timeout: 3000,
      interval: 20,
    })
    release()
    await settled(task.id, 'success')
  })

  it('only accepts tasks whose timeout fits in the Worker budget', async () => {
    const body = (timeoutMs: number) =>
      JSON.stringify({
        name: 'w',
        schedule: { type: 'manual' },
        executor: { type: 'http', config: { url: 'https://downstream.test/hook', timeoutMs } },
        executionMode: 'worker',
      })
    const rejected = await call('/tasks', { method: 'POST', body: body(25_001) })
    expect(rejected.status).toBe(422)
    expect(((await rejected.json()) as { issues: unknown[] }).issues).toEqual([
      { path: 'executionMode', message: 'Worker 异步只支持 25 秒以内的超时（当前 25.001 秒）' },
    ])
    expect((await call('/tasks', { method: 'POST', body: body(25_000) })).status).toBe(201)
  })

  it('validates inherited worker timeouts on create and update, while allowing explicit longer-running modes', async () => {
    await setRuntimeSettings({ executionMode: 'worker' })
    const body = (timeoutMs: number, executionMode = 'inherit') => JSON.stringify({
      name: 'inherited timeout',
      schedule: { type: 'manual' },
      executor: { type: 'http', config: { url: 'https://downstream.test/hook', timeoutMs } },
      executionMode,
    })
    expect((await call('/tasks', { method: 'POST', body: body(25_001) })).status).toBe(422)
    const created = await call('/tasks', { method: 'POST', body: body(25_000) })
    expect(created.status).toBe(201)
    const { task } = await created.json() as { task: { id: string } }
    expect((await call(`/tasks/${task.id}`, { method: 'PUT', headers: { 'if-match': '"1"' }, body: body(60_000) })).status).toBe(422)
    expect((await getTask(env.DB, task.id))?.executor.config.timeoutMs).toBe(25_000)
    for (const mode of ['direct', 'queue']) {
      expect((await call('/tasks', { method: 'POST', body: body(60_000, mode) })).status).toBe(201)
    }
    await setRuntimeSettings({ executionMode: 'queue' })
    expect((await call('/tasks', { method: 'POST', body: body(60_000) })).status).toBe(201)
  })

  it('the default timeout fits worker mode, so new tasks can use the default', async () => {
    const res = await call('/tasks', {
      method: 'POST',
      body: JSON.stringify({
        name: 'w',
        schedule: { type: 'manual' },
        executor: { type: 'http', config: { url: 'https://downstream.test/hook' } },
        executionMode: 'worker',
      }),
    })
    // No timeoutMs: the server default must pass the worker-mode check.
    expect(res.status).toBe(201)
    expect(Number(emptyTaskForm.timeoutSeconds) * 1000).toBe(WORKER_MAX_TIMEOUT_MS)
  })

  it('a long timeout and a missing queue never change worker mode', async () => {
    await setRuntimeSettings({ executionMode: 'worker' })
    expect(await executionMode(env)).toBe('worker')
    expect(await effectiveMode(env, { executionMode: 'inherit', timeoutMs: 25_000 })).toBe('worker')
    expect(await effectiveMode(env, { executionMode: 'inherit', timeoutMs: 25_001 })).toBe('worker')
    const noQueue = Object.create(env, { RUN_QUEUE: { value: undefined } }) as CloudflareBindings
    expect(await effectiveMode(noQueue, { executionMode: 'inherit', timeoutMs: 60_000 })).toBe('worker')
    expect(await effectiveMode(noQueue, { executionMode: 'worker', timeoutMs: 60_000 })).toBe('worker')
  })

  it('keeps scheduled inherited runs and retries in worker mode after the global mode changes, capping each at 25 seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() =>
      AbortSignal.abort(new DOMException('deadline reached', 'TimeoutError')),
    )
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      init?.signal?.throwIfAborted()
      return new Response('unexpected success')
    })
    const task = await createTaskRow({
      schedule: YEARLY,
      executor: { type: 'http', config: { url: 'https://downstream.test/hook', timeoutMs: 60_000 } },
      retry: { count: 1, intervalSeconds: 60 },
    })
    const stub = env.TASK_SCHEDULER.getByName(task.id)
    await stub.sync(toSnapshot(task))
    const { sent } = await instrument(stub, 'worker')

    await runDurableObjectAlarm(stub)
    await settled(task.id, 'retrying')
    await vi.waitFor(async () => expect(await pending(stub)).toMatchObject([{ mode: 'worker', msg: { attempt: 2 } }]))
    await setRuntimeSettings({ executionMode: 'direct' })
    await runDurableObjectAlarm(stub)
    await settled(task.id, 'failed', 2)
    await vi.waitFor(async () => expect((await stub.status()).running).toBeNull())
    const [run] = await listRuns(env.DB, task.id, { limit: 1 })
    expect(run.error).toBe('timeout after 25000ms')
    expect(timeout.mock.calls).toEqual([[25_000], [25_000]])
    expect(sent).toEqual([])
    expect((await getTask(env.DB, task.id))?.executor.config.timeoutMs).toBe(60_000)
  })

  it('manual inherited runs stay in worker mode with a capped timeout after a global mode change', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok'))
    const task = await createTaskRow({
      schedule: { type: 'manual' },
      executor: { type: 'http', config: { url: 'https://downstream.test/hook', timeoutMs: 60_000 } },
    })
    await setRuntimeSettings({ executionMode: 'worker' })
    const workerEnv = Object.create(env, {
      RUN_QUEUE: { value: undefined },
    }) as CloudflareBindings
    expect((await call(`/tasks/${task.id}/trigger`, { method: 'POST' }, workerEnv)).status).toBe(202)
    await settled(task.id, 'success')
    expect(timeout.mock.calls).toEqual([[25_000]])
    expect((await getTask(env.DB, task.id))?.executor.config.timeoutMs).toBe(60_000)
  })

  it.each([1000, 25_000, 25_001, 60_000, 300_000])('caps a worker request configured for %i ms without changing its stored timeout', async (timeoutMs) => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok'))
    const task = await createTaskRow({
      schedule: { type: 'manual' },
      executionMode: 'worker',
      executor: { type: 'http', config: { url: 'https://downstream.test/hook', timeoutMs } },
    })
    const msg: RunMessage = { runId: crypto.randomUUID(), taskId: task.id, trigger: 'manual', scheduledAt: Date.now(), attempt: 1 }
    await executeInWorker(env, msg, 0)
    expect(timeout.mock.calls).toEqual([[Math.min(timeoutMs, 25_000)]])
    expect(await getRun(env.DB, msg.runId)).toMatchObject({ executionMode: 'worker', effectiveTimeoutMs: Math.min(timeoutMs, 25_000) })
    expect((await getTask(env.DB, task.id))?.executor.config.timeoutMs).toBe(timeoutMs)
  })

  it('leaves a queue request with a long timeout unchanged', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok'))
    const task = await createTaskRow({
      executor: { type: 'http', config: { url: 'https://downstream.test/hook', timeoutMs: 60_000 } },
    })
    const msg: RunMessage = { runId: crypto.randomUUID(), taskId: task.id, trigger: 'manual', scheduledAt: Date.now(), attempt: 1 }
    await processRun(msg, env)
    expect(timeout.mock.calls).toEqual([[60_000]])
  })
})
