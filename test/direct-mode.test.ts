import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { app } from '../src/app'
import { getRun, listRuns } from '../src/domain/runs-repo'
import { runQueue } from '../src/executor/mode'
import type { TaskScheduler } from '../src/scheduler/task-scheduler'
import { createTaskRow, setRuntimeSettings, toSnapshot } from './helpers'

afterEach(() => vi.restoreAllMocks())

const noQueue = { send: async () => Promise.reject(new Error('the queue must not be used in direct mode')) }

const originalEnv = new WeakMap<object, CloudflareBindings>()

/** Switch a scheduler instance to direct mode; `patch` overrides further bindings. */
async function useDirectMode(stub: DurableObjectStub<TaskScheduler>, patch: Record<string, unknown> = {}) {
  await setRuntimeSettings({ executionMode: 'direct' })
  await runInDurableObject(stub, (instance: TaskScheduler) => {
    if (!originalEnv.has(instance)) originalEnv.set(instance, (instance as unknown as { env: CloudflareBindings }).env)
    const real = originalEnv.get(instance)!
    const props: PropertyDescriptorMap = { RUN_QUEUE: { value: noQueue } }
    for (const [k, v] of Object.entries(patch)) props[k] = { value: v }
    Object.defineProperty(instance, 'env', { value: Object.create(real, props), configurable: true })
  })
}

function mockFetch(...statuses: number[]) {
  const calls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    calls.push(new Request(input).url)
    return new Response('body', { status: statuses[Math.min(calls.length - 1, statuses.length - 1)] })
  })
  return calls
}

async function onlyRun(taskId: string) {
  const runs = await listRuns(env.DB, taskId, { limit: 10 })
  expect(runs).toHaveLength(1)
  return runs[0]
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
  runInDurableObject(stub, async (_i: TaskScheduler, state) => [...(await state.storage.list({ prefix: 'pending:' })).values()])

// A yearly cron keeps the next fire far away, so any earlier alarm belongs to a pending attempt.
const YEARLY = { type: 'cron', cron: '0 0 0 1 1 *', timezone: 'UTC' } as const

describe('direct mode', () => {
  it('executes a scheduled run inside the DO, releases the slot and re-arms', async () => {
    const calls = mockFetch(200)
    const task = await createTaskRow()
    const stub = env.TASK_SCHEDULER.getByName(task.id)
    await stub.sync(toSnapshot(task))
    await useDirectMode(stub)

    await runDurableObjectAlarm(stub)
    await settled(task.id, 'success')
    expect(calls).toEqual(['https://downstream.test/hook'])
    const status = await stub.status()
    expect(status.running).toBeNull()
    expect(status.alarmAt).toBeGreaterThan(Date.now())
    const stats = await env.DB.prepare('SELECT SUM(success) AS s FROM run_stats_hourly WHERE task_id = ?').bind(task.id).first<{ s: number }>()
    expect(stats?.s).toBe(1)
  })

  it('keeps a retry as a pending attempt that shares the alarm with the schedule', async () => {
    const calls = mockFetch(500, 200)
    const task = await createTaskRow({ schedule: YEARLY, retry: { count: 1, intervalSeconds: 60 } })
    const stub = env.TASK_SCHEDULER.getByName(task.id)
    await stub.sync(toSnapshot(task))
    await useDirectMode(stub)

    await runDurableObjectAlarm(stub)
    await settled(task.id, 'retrying')
    await vi.waitFor(async () => expect(await pending(stub)).toHaveLength(1), { timeout: 3000, interval: 20 })
    const [retry] = (await pending(stub)) as { dueAt: number; msg: { attempt: number } }[]
    expect(retry.msg.attempt).toBe(2)
    expect(retry.dueAt).toBeGreaterThan(Date.now() + 50_000)
    expect((await stub.status()).alarmAt).toBe(retry.dueAt)
    const nextFire = await runInDurableObject(stub, (_i: TaskScheduler, state) => state.storage.get<number>('nextRunAt'))
    expect(nextFire).toBeGreaterThan(retry.dueAt)

    // The alarm now serves the retry, not the yearly fire.
    await setRuntimeSettings({ executionMode: 'queue' })
    await runDurableObjectAlarm(stub)
    await settled(task.id, 'success', 2)
    expect(calls).toHaveLength(2)
    expect(await pending(stub)).toEqual([])
    expect((await stub.status()).alarmAt).toBe(nextFire)
    expect((await onlyRun(task.id)).trigger).toBe('schedule')
  })

  it('a disabled task still finishes its pending retry, and reconcile re-arms a lost alarm for it', async () => {
    mockFetch(500, 200)
    const task = await createTaskRow({ schedule: YEARLY, retry: { count: 1, intervalSeconds: 60 } })
    const stub = env.TASK_SCHEDULER.getByName(task.id)
    await stub.sync(toSnapshot(task))
    await useDirectMode(stub)
    await runDurableObjectAlarm(stub)
    await vi.waitFor(async () => expect(await pending(stub)).toHaveLength(1), { timeout: 3000, interval: 20 })
    const [{ dueAt }] = (await pending(stub)) as { dueAt: number }[]

    const disabled = { ...toSnapshot(task), enabled: false, version: task.version + 1 }
    await stub.sync(disabled)
    expect((await stub.status()).alarmAt).toBe(dueAt)

    await runInDurableObject(stub, (_i: TaskScheduler, state) => state.storage.deleteAlarm())
    await stub.sync(disabled)
    expect((await stub.status()).alarmAt).toBe(dueAt)

    await runDurableObjectAlarm(stub)
    await settled(task.id, 'success', 2)
    expect((await stub.status()).alarmAt).toBeNull()
  })

  it('an alarm runs only the attempts that are due and re-arms for the rest', async () => {
    const calls = mockFetch(200)
    const task = await createTaskRow({ schedule: { type: 'manual' } })
    const stub = env.TASK_SCHEDULER.getByName(task.id)
    await stub.sync(toSnapshot(task))
    await useDirectMode(stub)
    const now = Date.now()
    const entry = (dueAt: number) => {
      const msg = { runId: crypto.randomUUID(), taskId: task.id, trigger: 'manual', scheduledAt: now, attempt: 1 }
      return { msg, dueAt, deliveries: 0 }
    }
    const soon = entry(now + 5_000)
    const later = entry(now + 600_000)
    await runInDurableObject(stub, async (_i: TaskScheduler, state) => {
      await state.storage.put({ [`pending:${soon.msg.runId}`]: soon, [`pending:${later.msg.runId}`]: later })
      await state.storage.setAlarm(soon.dueAt)
    })

    await runDurableObjectAlarm(stub)
    await settled(task.id, 'success')
    expect(calls).toHaveLength(1)
    expect(await getRun(env.DB, soon.msg.runId)).not.toBeNull()
    expect(await getRun(env.DB, later.msg.runId)).toBeNull()
    expect(await pending(stub)).toMatchObject([{ dueAt: later.dueAt }])
    expect((await stub.status()).alarmAt).toBe(later.dueAt)
  })

  it('redelivers an attempt that hit an infrastructure error', async () => {
    mockFetch(200)
    const task = await createTaskRow({ schedule: YEARLY, executionMode: 'direct' })
    const stub = env.TASK_SCHEDULER.getByName(task.id)
    await stub.sync(toSnapshot(task))
    const brokenDb = { prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error('D1 is down')) }) }) }
    await useDirectMode(stub, { DB: brokenDb })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await runDurableObjectAlarm(stub)
    await vi.waitFor(async () => expect(await pending(stub)).toHaveLength(1), { timeout: 3000, interval: 20 })
    expect(error.mock.calls.some(([m]) => String(m).includes('direct run failed'))).toBe(true)
    expect(await pending(stub)).toMatchObject([{ deliveries: 1, msg: { attempt: 1 } }])

    await useDirectMode(stub)
    await runDurableObjectAlarm(stub)
    await settled(task.id, 'success')
  })

  it('manual triggers go straight to the DO', async () => {
    const calls = mockFetch(200)
    const task = await createTaskRow({ schedule: { type: 'manual' } })
    await setRuntimeSettings({ executionMode: 'direct' })
    const e = Object.create(env, { RUN_QUEUE: { value: noQueue } })
    const res = await app.request(
      `http://cf-task.test/api/tasks/${task.id}/trigger`,
      { method: 'POST', headers: { authorization: `Bearer ${env.API_TOKEN}` } },
      e,
    )
    expect(res.status).toBe(202)
    const { runId } = (await res.json()) as { runId: string }
    await settled(task.id, 'success')
    expect((await getRun(env.DB, runId))?.trigger).toBe('manual')
    expect(calls).toHaveLength(1)
  })
})

describe('queue binding', () => {
  it('queue mode without the binding fails with a clear message', () => {
    const e = Object.create(env, { RUN_QUEUE: { value: undefined } }) as CloudflareBindings
    expect(() => runQueue(e)).toThrow(/RUN_QUEUE binding is not configured/)
  })
})
