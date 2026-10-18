import { env } from 'cloudflare:workers'
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { afterEach, expect, it, vi } from 'vitest'
import { createTaskRow, toSnapshot, captureQueue } from './helpers'
import { getTask } from '../src/domain/tasks-repo'
import { claimRun, getRun, insertSkippedRun, markLostRuns, recordAttempt, RUNNING_STALE_MS } from '../src/domain/runs-repo'
import { runMaintenance } from '../src/maintenance/maintenance'
import { app } from '../src/app'
import { fmtTime } from '../web/src/lib/format'
import { formToPayload, taskToForm } from '../web/src/lib/task-form'
import { MAX_ALARM_TIME_MS } from '../src/lib/schedule'
import { taskInputSchema } from '../src/domain/task'
import { actionsForRun } from '../src/domain/actions-repo'
import { deliverAction } from '../src/executor/actions'

afterEach(() => vi.restoreAllMocks())

it('recovers a once task after its inherited-mode read fails, even after disable and alarm loss', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const task = await createTaskRow({ schedule: { type: 'once', runAt: Date.now() + 60_000 } })
  const stub = env.TASK_SCHEDULER.getByName(task.id)
  await stub.sync(toSnapshot(task))
  const sent = await captureQueue(stub)
  let reads = 0
  let restore!: () => void
  await runInDurableObject(stub, (instance) => {
    const real = (instance as unknown as { env: CloudflareBindings }).env
    const DB = { prepare: (sql: string) => {
      if (sql.includes("key = 'runtime'")) return { first: async () => { reads++; throw new Error('transient D1 failure') } }
      return real.DB.prepare(sql)
    } }
    Object.defineProperty(instance, 'env', { configurable: true, value: Object.create(real, { DB: { value: DB } }) })
    restore = () => { Object.defineProperty(instance, 'env', { configurable: true, value: real }) }
  })
  await runDurableObjectAlarm(stub)
  expect(reads).toBe(1)
  expect(sent).toHaveLength(0)
  expect((await getTask(env.DB, task.id))?.enabled).toBe(false)
  expect((await stub.status()).alarmAt).not.toBeNull()
  const intents = await runInDurableObject(stub, async (_, state) =>
    [...(await state.storage.list<{ runId: string }>({ prefix: 'once:' })).values()])
  expect(intents).toHaveLength(1)
  await runInDurableObject(stub, async (_, state) => { restore(); await state.storage.deleteAlarm() })
  await runMaintenance(env)
  expect((await stub.status()).alarmAt).not.toBeNull()
  await runDurableObjectAlarm(stub)
  expect(sent).toMatchObject([{ runId: intents[0].runId, taskId: task.id, scheduledAt: task.schedule.type === 'once' ? task.schedule.runAt : 0 }])
  expect((await stub.status()).alarmAt).toBeNull()
  expect(await runDurableObjectAlarm(stub)).toBe(false)
})

it('releases a lost scheduled run before its long skip lease expires', async () => {
  const start = Date.now() + 86_400_000
  vi.spyOn(Date, 'now').mockReturnValue(start)
  const task = await createTaskRow({ executionMode: 'queue', retry: { count: 10, intervalSeconds: 3600 },
    executor: { type: 'http', config: { url: 'https://downstream.test/hook', timeoutMs: 300_000 } } })
  const stub = env.TASK_SCHEDULER.getByName(task.id)
  await stub.sync(toSnapshot(task))
  const sent = await captureQueue(stub)
  await runDurableObjectAlarm(stub)
  expect(sent).toHaveLength(1)
  expect(await claimRun(env.DB, sent[0], start)).toBe(true)
  vi.mocked(Date.now).mockReturnValue(start + RUNNING_STALE_MS + 1)
  expect((await runMaintenance(env)).lostRuns).toBe(1)
  expect((await getRun(env.DB, sent[0].runId))?.status).toBe('failed')
  await runDurableObjectAlarm(stub)
  await vi.waitFor(async () => expect((await stub.status()).running?.runId).not.toBe(sent[0].runId))
  if (sent.length === 1) await runDurableObjectAlarm(stub)
  expect(sent).toHaveLength(2)
})

it.each([true, false])('rejects an out-of-range once timestamp, enabled=%s', async (enabled) => {
  const res = await app.request('/api/tasks', {
    method: 'POST', headers: { authorization: `Bearer ${env.API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'invalid time', enabled, schedule: { type: 'once', runAt: 8640000000000001 },
      executor: { type: 'http', config: { url: 'https://downstream.test/hook' } } }),
  }, env)
  expect(res.status).toBe(422)
  expect(await res.json()).toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ path: 'schedule.runAt' })]) })
})

it('keeps invalid dates from crashing the list formatter or editor', async () => {
  expect(fmtTime(Date.now(), 'UTC')).not.toBe('—')
  const task = await createTaskRow({ schedule: { type: 'once', runAt: Date.now() + 60_000 } })
  if (task.schedule.type !== 'once') throw new Error('expected a once task')
  task.schedule.runAt = 8640000000000001
  expect(fmtTime(task.schedule.runAt, 'UTC')).toBe('—')
  expect(taskToForm(task).runAt).toBe('')
  expect(formToPayload(taskToForm(task))).toHaveProperty('issues')
})

it('uses the same alarm timestamp limit for numeric and ISO input', async () => {
  const task = await createTaskRow({ schedule: { type: 'manual' } })
  for (const runAt of [MAX_ALARM_TIME_MS, new Date(MAX_ALARM_TIME_MS).toISOString()]) {
    expect(taskInputSchema.parse({ ...task, schedule: { type: 'once', runAt } }).schedule)
      .toMatchObject({ runAt: MAX_ALARM_TIME_MS })
  }
  for (const runAt of [MAX_ALARM_TIME_MS + 1, new Date(MAX_ALARM_TIME_MS + 1).toISOString()]) {
    expect(taskInputSchema.safeParse({ ...task, schedule: { type: 'once', runAt } }).success).toBe(false)
  }
  const stub = env.TASK_SCHEDULER.getByName(crypto.randomUUID())
  await runInDurableObject(stub, async (_, state) => {
    await state.storage.setAlarm(MAX_ALARM_TIME_MS)
    expect(await state.storage.getAlarm()).toBe(MAX_ALARM_TIME_MS)
    await state.storage.deleteAlarm()
  })
})

it('retains a failed lost-slot release and never clears a newer run slot', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const task = await createTaskRow()
  const runId = crypto.randomUUID()
  const now = Date.now()
  await claimRun(env.DB, { runId, taskId: task.id, trigger: 'schedule', scheduledAt: now, attempt: 1 }, now - RUNNING_STALE_MS - 1)
  expect(await markLostRuns(env.DB, now)).toBe(1)
  const [action] = await actionsForRun(env.DB, runId)
  expect(action.payload.kind).toBe('release')
  const broken = Object.create(env, { TASK_SCHEDULER: { value: { getByName: () => ({
    complete: async () => { throw new Error('scheduler unavailable') }, scheduleAction: async () => {},
  }) } } }) as CloudflareBindings
  await deliverAction(action.id, broken)
  const pending = await actionsForRun(env.DB, runId)
  expect(pending).toHaveLength(1)
  const stub = env.TASK_SCHEDULER.getByName(task.id)
  const newerRunId = crypto.randomUUID()
  await runInDurableObject(stub, (_, state) => state.storage.put('running', { runId: newerRunId, leaseUntil: now + 60_000 }))
  vi.spyOn(Date, 'now').mockReturnValue(pending[0].dueAt + 1)
  await deliverAction(action.id, env)
  expect((await stub.status()).running?.runId).toBe(newerRunId)
  expect(await actionsForRun(env.DB, runId)).toEqual([])
})

it('a replayed skipped once dispatch contributes one log and one statistic', async () => {
  const task = await createTaskRow()
  const now = Date.now()
  const skipped = { runId: crypto.randomUUID(), taskId: task.id, scheduledAt: now, reason: 'busy' }
  await insertSkippedRun(env.DB, skipped, now)
  await insertSkippedRun(env.DB, skipped, now + 1000)
  expect((await getRun(env.DB, skipped.runId))?.status).toBe('skipped')
  expect(await env.DB.prepare('SELECT skipped FROM run_stats WHERE task_id = ?').bind(task.id).first()).toEqual({ skipped: 1 })
})

it('an interrupted once acknowledgement cannot retake a slot after the run finished', async () => {
  const now = Date.now()
  const task = await createTaskRow({ schedule: { type: 'once', runAt: now + 60_000 }, executionMode: 'queue' })
  const snapshot = toSnapshot(task)
  const stub = env.TASK_SCHEDULER.getByName(task.id)
  await stub.sync(snapshot)
  const sent = await captureQueue(stub)
  const runId = crypto.randomUUID()
  await claimRun(env.DB, { runId, taskId: task.id, trigger: 'schedule', scheduledAt: now, attempt: 1 }, now)
  await recordAttempt(env.DB, runId, 'success', { httpStatus: 200, responseBody: '', error: null, durationMs: 1 }, now)
  await runInDurableObject(stub, async (_, state) => {
    await state.storage.delete('nextRunAt')
    await state.storage.put('onceFiredVersion', task.version)
    await state.storage.put(`once:${runId}`, { snapshot, runId, scheduledAt: now, dueAt: now, deliveries: 0, mode: 'queue' })
    await state.storage.setAlarm(now)
  })
  await runDurableObjectAlarm(stub)
  expect(sent).toHaveLength(0)
  expect((await stub.status()).running).toBeNull()
  expect((await stub.status()).alarmAt).toBeNull()
})
