import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { app } from '../src/app'
import { listRuns, type RunMessage } from '../src/domain/runs-repo'
import type { ScheduleSnapshot } from '../src/domain/task'
import { effectiveMode } from '../src/executor/mode'
import type { TaskScheduler } from '../src/scheduler/task-scheduler'
import type { TaskExecutionMode } from '../src/shared/types'
import { describeTaskMode, effectiveTaskMode, suggestMode, suggestionText } from '../web/src/lib/execution-mode'
import { emptyTaskForm, formToPayload, mapIssues } from '../web/src/lib/task-form'
import { createTaskRow, toSnapshot } from './helpers'

afterEach(() => vi.restoreAllMocks())

const AUTH = { authorization: `Bearer ${env.API_TOKEN}`, 'content-type': 'application/json' }
const call = (path: string, init: RequestInit = {}, e: CloudflareBindings = env) =>
  app.request(`http://cf-task.test/api${path}`, { ...init, headers: AUTH }, e)

const withoutQueue = (e: CloudflareBindings = env) =>
  Object.create(e, { RUN_QUEUE: { value: undefined } }) as CloudflareBindings

const taskBody = (executionMode?: TaskExecutionMode) => ({
  name: 'mode',
  schedule: { type: 'cron', cron: '0 0 0 1 1 *', timezone: 'UTC' },
  executor: { type: 'http', config: { url: 'https://downstream.test/hook' } },
  ...(executionMode ? { executionMode } : {}),
})

/** Replace a scheduler's bindings; returns what was sent to its queue. */
async function schedulerEnv(stub: DurableObjectStub<TaskScheduler>, overrides: Record<string, unknown>) {
  const sent: RunMessage[] = []
  await runInDurableObject(stub, (instance: TaskScheduler) => {
    const real = (instance as unknown as { env: CloudflareBindings }).env
    const props: PropertyDescriptorMap = {
      RUN_QUEUE: { value: { send: async (m: RunMessage) => void sent.push(m) } },
    }
    for (const [k, v] of Object.entries(overrides)) props[k] = { value: v }
    Object.defineProperty(instance, 'env', { value: Object.create(real, props), configurable: true })
  })
  return sent
}

const storedSnapshot = (stub: DurableObjectStub<TaskScheduler>) =>
  runInDurableObject(stub, (_i: TaskScheduler, state) => state.storage.get<ScheduleSnapshot>('snapshot'))

const ranDirectly = (taskId: string) =>
  vi.waitFor(
    async () => expect((await listRuns(env.DB, taskId, { limit: 5 })).map((r) => r.status)).toContain('success'),
    { timeout: 3000, interval: 20 },
  )

describe('per-task execution mode: API', () => {
  it('defaults to inherit, round-trips an override and pushes it to the scheduler', async () => {
    const created = await call('/tasks', { method: 'POST', body: JSON.stringify(taskBody()) })
    const { task } = (await created.json()) as { task: { id: string; executionMode: string; version: number } }
    expect(task.executionMode).toBe('inherit')

    const updated = await call(`/tasks/${task.id}`, { method: 'PUT', body: JSON.stringify(taskBody('direct')) })
    const body = (await updated.json()) as { task: { executionMode: string; version: number } }
    expect(body.task).toMatchObject({ executionMode: 'direct', version: task.version + 1 })
    expect(await storedSnapshot(env.TASK_SCHEDULER.getByName(task.id))).toMatchObject({
      executionMode: 'direct',
      version: task.version + 1,
    })
  })

  it('rejects queue mode when the deployment has no queue, and unknown modes', async () => {
    const res = await call('/tasks', { method: 'POST', body: JSON.stringify(taskBody('queue')) }, withoutQueue())
    expect(res.status).toBe(422)
    expect(((await res.json()) as { issues: { path: string }[] }).issues).toMatchObject([{ path: 'executionMode' }])

    const ok = await call('/tasks', { method: 'POST', body: JSON.stringify(taskBody('direct')) }, withoutQueue())
    expect(ok.status).toBe(201)
    const bad = await call('/tasks', { method: 'POST', body: JSON.stringify({ ...taskBody(), executionMode: 'inline' }) })
    expect(bad.status).toBe(422)
  })
})

describe('per-task execution mode: dispatch', () => {
  it('a direct task runs in its DO while the global mode is queue', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok'))
    const task = await createTaskRow({ executionMode: 'direct' })
    const stub = env.TASK_SCHEDULER.getByName(task.id)
    await stub.sync(toSnapshot(task))
    const sent = await schedulerEnv(stub, { EXECUTION_MODE: 'queue' })

    await runDurableObjectAlarm(stub)
    await ranDirectly(task.id)
    expect(sent).toEqual([])
  })

  it('a queue task is enqueued while the global mode is direct', async () => {
    const task = await createTaskRow({ executionMode: 'queue' })
    const stub = env.TASK_SCHEDULER.getByName(task.id)
    await stub.sync(toSnapshot(task))
    const sent = await schedulerEnv(stub, { EXECUTION_MODE: 'direct' })

    await runDurableObjectAlarm(stub)
    expect(sent).toMatchObject([{ taskId: task.id, trigger: 'schedule' }])
  })

  it('an inheriting task follows the global mode', async () => {
    const task = await createTaskRow()
    const stub = env.TASK_SCHEDULER.getByName(task.id)
    await stub.sync(toSnapshot(task))
    const sent = await schedulerEnv(stub, { EXECUTION_MODE: 'queue' })
    await runDurableObjectAlarm(stub)
    expect(sent).toHaveLength(1)
  })

  it('a queue task without the binding falls back to direct instead of stopping', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const task = await createTaskRow({ executionMode: 'queue' })
    const stub = env.TASK_SCHEDULER.getByName(task.id)
    await stub.sync(toSnapshot(task))
    await schedulerEnv(stub, { RUN_QUEUE: undefined })

    await runDurableObjectAlarm(stub)
    await ranDirectly(task.id)
    expect(warn.mock.calls.some(([m]) => String(m).includes('RUN_QUEUE binding is not configured'))).toBe(true)
  })

  it('manual triggers follow the task mode', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok'))
    const task = await createTaskRow({ schedule: { type: 'manual' }, executionMode: 'direct' })
    const sent: RunMessage[] = []
    const e = Object.create(env, { RUN_QUEUE: { value: { send: async (m: RunMessage) => void sent.push(m) } } })
    expect((await call(`/tasks/${task.id}/trigger`, { method: 'POST' }, e)).status).toBe(202)
    await ranDirectly(task.id)
    expect(sent).toEqual([])
  })

  it('effectiveMode: task setting first, then EXECUTION_MODE', () => {
    const queueEnv = Object.create(env, { EXECUTION_MODE: { value: 'queue' } }) as CloudflareBindings
    const directEnv = Object.create(env, { EXECUTION_MODE: { value: 'direct' } }) as CloudflareBindings
    expect(effectiveMode(queueEnv, undefined)).toBe('queue')
    expect(effectiveMode(queueEnv, 'inherit')).toBe('queue')
    expect(effectiveMode(queueEnv, 'direct')).toBe('direct')
    expect(effectiveMode(directEnv, 'inherit')).toBe('direct')
    expect(effectiveMode(directEnv, 'queue')).toBe('queue')
  })
})

describe('per-task execution mode: UI helpers', () => {
  const queueGlobal = { executionMode: 'queue' as const, queueAvailable: true }
  const directNoQueue = { executionMode: 'direct' as const, queueAvailable: false }

  it('describes the mode a task actually uses', () => {
    expect(describeTaskMode('inherit', queueGlobal)).toBe('队列（跟随全局）')
    expect(describeTaskMode('direct', queueGlobal)).toBe('直接执行')
    expect(describeTaskMode('inherit', directNoQueue)).toBe('直接执行（跟随全局）')
    expect(describeTaskMode('queue', directNoQueue)).toBe('直接执行（未配置 Queue，已回退）')
    expect(effectiveTaskMode('queue', directNoQueue)).toEqual({ mode: 'direct', fallback: true })
  })

  it('suggests direct below one second of P95 and queue above', () => {
    expect(suggestMode(null)).toBeNull()
    expect(suggestMode(999)).toBe('direct')
    expect(suggestMode(1000)).toBe('queue')
    expect(suggestionText(120, true)).toBe('近 7 天 P95 耗时 120ms，建议「直接执行」：低于 1 秒时比队列便宜。')
    expect(suggestionText(2300, false)).toContain('建议「队列」')
    expect(suggestionText(2300, false)).toContain('当前部署没有配置 Queue')
    expect(suggestionText(null, true)).toContain('还没有耗时数据')
  })

  it('the form sends the mode and maps its server error back to the field', () => {
    const out = formToPayload({ ...emptyTaskForm, name: 'x', url: 'https://x.test', executionMode: 'direct' })
    expect('payload' in out && out.payload.executionMode).toBe('direct')
    expect(mapIssues([{ path: 'executionMode', message: 'no queue' }]).fields).toEqual({ executionMode: 'no queue' })
  })
})
