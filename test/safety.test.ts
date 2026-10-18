import { env } from 'cloudflare:workers'
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { app } from '../src/app'
import { claimAction, dueActions } from '../src/domain/actions-repo'
import { getRun, type RunMessage } from '../src/domain/runs-repo'
import { triggerTask } from '../src/domain/task-service'
import { processRun, queueTransport } from '../src/executor/consumer'
import { sendFailureAlert } from '../src/executor/alert'
import { DEFAULT_SAFETY_SETTINGS } from '../src/shared/types'
import { admit, getSafetySettingsState, putSafetySettings } from '../src/domain/safety'
import { runMaintenance } from '../src/maintenance/maintenance'
import { deliverAction } from '../src/executor/actions'
import { createTaskRow, toSnapshot } from './helpers'

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM settings WHERE key='safety'"), env.DB.prepare('DELETE FROM execution_budget'), env.DB.prepare('DELETE FROM execution_budget_totals')])
})

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
const safety = (value: object) => env.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES('safety',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify({ ...DEFAULT_SAFETY_SETTINGS, ...value }), Date.now()).run()
const safetyHeaders = async () => ({ authorization: `Bearer ${env.API_TOKEN}`, 'content-type': 'application/json', 'if-match': `"${(await getSafetySettingsState(env.DB)).version}"` })
const message = (taskId: string): RunMessage => ({ taskId, runId: crypto.randomUUID(), trigger: 'manual', scheduledAt: Date.now(), attempt: 1 })

it('stops queue handoffs after a finite number of failures, releasing the slot', async () => {
  const task = await createTaskRow({ schedule: { type: 'once', runAt: Date.now() + 1000 } })
  const stub = env.TASK_SCHEDULER.getByName(task.id)
  await stub.sync(toSnapshot(task))
  const send = vi.fn().mockRejectedValue(new Error('offline'))
  await runInDurableObject(stub, (instance) => {
    const real = (instance as unknown as { env: CloudflareBindings }).env
    Object.defineProperty(instance, 'env', { value: Object.create(real, { RUN_QUEUE: { value: { send } } }) })
  })
  for (let n = 0; n < 14; n++) await runDurableObjectAlarm(stub)
  expect(send.mock.calls.length).toBeGreaterThan(0)
  expect(send.mock.calls.length).toBeLessThanOrEqual(10)
  expect((await stub.status()).alarmAt).toBeNull()
  expect((await stub.status()).running).toBeNull()
})

it('stops retry outbox actions even when their transport never recovers', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('failed', { status: 500 }))
  const task = await createTaskRow({ retry: { count: 1, intervalSeconds: 1 }, alert: { mode: 'off' } })
  const msg = message(task.id)
  const retry = vi.fn().mockRejectedValue(new Error('offline'))
  const transport = { ...queueTransport(env), retry }
  await expect(processRun(msg, env, transport)).rejects.toThrow('offline')
  const now = Date.now()
  vi.spyOn(Date, 'now')
  for (let n = 1; n <= 14; n++) {
    vi.mocked(Date.now).mockReturnValue(now + n * 300000)
    await deliverAction(`${msg.runId}:retry:2`, env, transport).catch(() => {})
  }
  expect(retry.mock.calls.length).toBeLessThanOrEqual(10)
  expect(await dueActions(env.DB, now + 86400000)).toEqual([])
})

it('does not reclaim a fourth alert after three interrupted attempts', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('failed', { status: 500 }))
  const task = await createTaskRow({ alert: { mode: 'custom', url: 'https://alerts.test' } })
  const msg = message(task.id)
  await processRun(msg, env)
  const now = Date.now()
  for (let n = 0; n < 3; n++) expect(await claimAction(env.DB, `${msg.runId}:alert`, now + n * 46000)).not.toBeNull()
  expect(await claimAction(env.DB, `${msg.runId}:alert`, now + 3 * 46000)).toBeNull()
  expect(await dueActions(env.DB, now + 86400000)).toEqual([])
})

it('enforces the manual trigger budget atomically under concurrency', async () => {
  await safety({ taskDailyLimit: 3 })
  const task = await createTaskRow({ schedule: { type: 'manual' }, executionMode: 'queue' })
  const send = vi.fn().mockResolvedValue(undefined)
  const fake = Object.create(env, { RUN_QUEUE: { value: { send } } })
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => triggerTask(fake, task.id)))
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3)
  expect(send).toHaveBeenCalledTimes(3)
})

it('rejects authenticated recursive trigger calls before creating another run', async () => {
  const task = await createTaskRow({ schedule: { type: 'manual' } })
  const res = await app.request(`/api/tasks/${task.id}/trigger`, { method: 'POST', headers: { authorization: `Bearer ${env.API_TOKEN}`, 'x-yunji-task-run': 'parent-run' } }, env)
  expect(res.status).toBe(429)
})

it('global pause blocks already delivered messages as well as new triggers', async () => {
  const task = await createTaskRow()
  await safety({ paused: true })
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
  const msg = message(task.id)
  await processRun(msg, env)
  expect(fetch).not.toHaveBeenCalled()
  expect(await getRun(env.DB, msg.runId)).toMatchObject({ status: 'failed' })
  await expect(triggerTask(env, task.id)).rejects.toThrow(/paused/)
})

it('shares a global dispatch cap across different tasks', async () => {
  await safety({ globalDailyLimit: 4 })
  const tasks = await Promise.all(Array.from({ length: 3 }, () => createTaskRow({ schedule: { type: 'manual' }, executionMode: 'queue' })))
  const send = vi.fn().mockResolvedValue(undefined)
  const fake = Object.create(env, { RUN_QUEUE: { value: { send } } })
  await Promise.allSettled(Array.from({ length: 15 }, (_, n) => triggerTask(fake, tasks[n % 3].id)))
  expect(send).toHaveBeenCalledTimes(4)
})

it('bounds actual executions, including retry messages and direct deliveries', async () => {
  await safety({ taskDailyLimit: 1 })
  const task = await createTaskRow({ retry: { count: 1, intervalSeconds: 1 } })
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('failed', { status: 500 }))
  const msg = message(task.id)
  const transport = { ...queueTransport(env), retry: vi.fn().mockResolvedValue(undefined) }
  await processRun(msg, env, transport)
  await processRun({ ...msg, attempt: 2 }, env, transport)
  expect(fetch).toHaveBeenCalledOnce()
  expect(await getRun(env.DB, msg.runId)).toMatchObject({ status: 'failed', attempt: 2, error: expect.stringContaining('budget exhausted') })
})

it('tags outgoing requests and overrides a user-supplied recursion header', async () => {
  const task = await createTaskRow({ executor: { type: 'http', config: { url: 'https://downstream.test', headers: { 'x-yunji-task-run': '' } } } })
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
  const msg = message(task.id)
  await processRun(msg, env)
  expect(new Headers(fetch.mock.calls[0][1]?.headers).get('x-yunji-task-run')).toBe(msg.runId)
})

it('rejects expired queue handoffs before sending and leaves a terminal run', async () => {
  const task = await createTaskRow({ schedule: { type: 'manual' } })
  const stub = env.TASK_SCHEDULER.getByName(task.id)
  const msg = { ...message(task.id), scheduledAt: Date.now() - 86400001 }
  const send = vi.fn().mockResolvedValue(undefined)
  await runInDurableObject(stub, (instance) => {
    const real = (instance as unknown as { env: CloudflareBindings }).env
    Object.defineProperty(instance, 'env', { value: Object.create(real, { RUN_QUEUE: { value: { send } } }) })
  })
  await stub.schedule({ msg, deliveries: 0, dueAt: Date.now() + 60000, mode: 'queue', leaseMs: 60000 })
  await runDurableObjectAlarm(stub)
  expect(send).not.toHaveBeenCalled()
  expect(await getRun(env.DB, msg.runId)).toMatchObject({ status: 'failed' })
  expect((await stub.status()).alarmAt).toBeNull()
})

it('exposes the authenticated emergency pause without changing runtime settings', async () => {
  const headers = await safetyHeaders()
  const denied = await app.request('/api/settings/safety', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused: true }) }, env)
  expect(denied.status).toBe(401)
  const changed = await app.request('/api/settings/safety', { method: 'PUT', headers, body: JSON.stringify({ paused: true, taskDailyLimit: 12, globalDailyLimit: 30 }) }, env)
  expect(changed.status).toBe(200)
  const read = await app.request('/api/settings/safety', { headers }, env)
  expect(await read.json()).toEqual({ settings: { paused: true, taskDailyLimit: 12, globalDailyLimit: 30 }, version: 1 })
  const task = await createTaskRow()
  const trigger = await app.request(`/api/tasks/${task.id}/trigger`, { method: 'POST', headers }, env)
  expect(trigger.status).toBe(429)
})

it('Sender calls time out and dispose a stuck RPC session', async () => {
  vi.useFakeTimers()
  const dispose = vi.fn()
  const pending = new Promise<never>(() => {})
  Object.defineProperty(pending, Symbol.dispose, { value: dispose })
  const fake = Object.create(env, { SENDER: { value: { send: () => pending } } })
  const result = sendFailureAlert(fake, { id: 'task', name: 'task', alert: { mode: 'sender', channelGroup: 'ops' } },
    { id: 'run', attempt: 1, trigger: 'manual', httpStatus: null, error: 'failed', finishedAt: Date.now() })
  const check = expect(result).rejects.toThrow('timeout')
  await vi.advanceTimersByTimeAsync(10001)
  await check
  expect(dispose).toHaveBeenCalledOnce()
})

it('starts a fresh daily budget at UTC midnight, without resetting within a day', async () => {
  await safety({ taskDailyLimit: 1 })
  const now = Date.now()
  await admit(env.DB, 'task', 'dispatch', now)
  await expect(admit(env.DB, 'task', 'dispatch', now)).rejects.toThrow('budget exhausted')
  await expect(admit(env.DB, 'task', 'dispatch', now + 86400000)).resolves.toBeUndefined()
})

it('maintenance expires abandoned actions and closes their protected runs', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('failed', { status: 500 }))
  const task = await createTaskRow({ schedule: { type: 'manual' }, retry: { count: 1, intervalSeconds: 1 }, alert: { mode: 'off' } })
  const msg = message(task.id)
  await expect(processRun(msg, env, { ...queueTransport(env), retry: async () => { throw new Error('offline') } })).rejects.toThrow('offline')
  await runMaintenance(env, Date.now() + 86400001)
  expect(await getRun(env.DB, msg.runId)).toMatchObject({ status: 'failed' })
  expect(await dueActions(env.DB, Date.now() + 86400001)).toEqual([])
})

it('rejects partial safety writes instead of accidentally unpausing', async () => {
  await safety({ paused: true, globalDailyLimit: 5 })
  const headers = await safetyHeaders()
  const res = await app.request('/api/settings/safety', { method: 'PUT', headers, body: JSON.stringify({ taskDailyLimit: 10 }) }, env)
  expect(res.status).toBe(422)
  const read = await app.request('/api/settings/safety', { headers }, env)
  expect(await read.json()).toMatchObject({ settings: { paused: true, globalDailyLimit: 5 } })
})

it('quota exhaustion preserves the original cron instead of firing at UTC midnight', async () => {
  const now = Date.UTC(2026, 9, 18, 9)
  vi.spyOn(Date, 'now').mockReturnValue(now)
  await safety({ taskDailyLimit: 1 })
  const task = await createTaskRow({ schedule: { type: 'cron', cron: '0 0 9 * * *', timezone: 'UTC' } })
  const stub = env.TASK_SCHEDULER.getByName(task.id)
  await stub.sync(toSnapshot(task))
  await admit(env.DB, task.id, 'dispatch', now)
  await runDurableObjectAlarm(stub)
  const next = await runInDurableObject(stub, (_, state) => state.storage.get<number>('nextRunAt'))
  expect(next).toBe(Date.UTC(2026, 9, 19, 9))
})

it('maintenance resumes paused cron tasks after the safety switch is released', async () => {
  const task = await createTaskRow()
  const stub = env.TASK_SCHEDULER.getByName(task.id)
  await stub.sync(toSnapshot(task))
  await safety({ paused: true })
  await runDurableObjectAlarm(stub)
  expect((await stub.status()).alarmAt).toBeNull()
  const res = await app.request('/api/settings/safety', { method: 'PUT', headers: await safetyHeaders(), body: JSON.stringify(DEFAULT_SAFETY_SETTINGS) }, env)
  expect(res.status).toBe(200)
  await runMaintenance(env)
  expect((await stub.status()).alarmAt).not.toBeNull()
})

it('bounds once-trigger recovery when settings lookup remains broken', async () => {
  const task = await createTaskRow({ schedule: { type: 'once', runAt: Date.now() + 60000 } })
  const stub = env.TASK_SCHEDULER.getByName(task.id)
  await stub.sync(toSnapshot(task))
  const failures = vi.fn(() => { throw new Error('settings unavailable') })
  await runInDurableObject(stub, (instance) => {
    const real = (instance as unknown as { env: CloudflareBindings }).env
    const DB = { prepare: (sql: string) => sql.includes("key = 'runtime'") ? failures() : real.DB.prepare(sql), batch: real.DB.batch.bind(real.DB) }
    Object.defineProperty(instance, 'env', { value: Object.create(real, { DB: { value: DB } }) })
  })
  for (let n = 0; n < 14; n++) await runDurableObjectAlarm(stub)
  expect(failures).toHaveBeenCalledTimes(10)
  expect((await stub.status()).alarmAt).toBeNull()
  const remaining = await runInDurableObject(stub, (_, state) => state.storage.list({ prefix: 'once:' }))
  expect(remaining.size).toBe(0)
})

it('old action wake records cannot reset handoff counts or extend their lifetime', async () => {
  const task = await createTaskRow({ schedule: { type: 'manual' } })
  const stub = env.TASK_SCHEDULER.getByName(task.id)
  const id = 'interrupted-action'
  const createdAt = Date.now() - 86400001
  await runInDurableObject(stub, (_, state) => state.storage.put(`action:${id}`, { id, dueAt: Date.now() + 60000, deliveries: 10, createdAt }))
  await stub.scheduleAction(id, Date.now() + 120000)
  expect(await runInDurableObject(stub, (_, state) => state.storage.get(`action:${id}`))).toMatchObject({ deliveries: 10, createdAt })
  await runDurableObjectAlarm(stub)
  await vi.waitFor(async () => expect((await stub.status()).alarmAt).toBeNull())
})

it('retains terminal queue failures across D1 failure without sending again', async () => {
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const task = await createTaskRow({ schedule: { type: 'manual' } })
  const stub = env.TASK_SCHEDULER.getByName(task.id)
  const msg = message(task.id)
  const send = vi.fn().mockResolvedValue(undefined)
  let healthy = false
  await runInDurableObject(stub, (instance) => {
    const real = (instance as unknown as { env: CloudflareBindings }).env
    const DB = { prepare: real.DB.prepare.bind(real.DB), batch: (statements: D1PreparedStatement[]) => healthy ? real.DB.batch(statements) : Promise.reject(new Error('D1 writes unavailable')) }
    Object.defineProperty(instance, 'env', { value: Object.create(real, { DB: { value: DB }, RUN_QUEUE: { value: { send } } }) })
  })
  await stub.schedule({ msg, deliveries: 10, dueAt: now + 60000, mode: 'queue', leaseMs: 60000 })
  await runDurableObjectAlarm(stub)
  expect(await stub.status()).toMatchObject({ terminalPending: 1, terminalExhausted: 0 })
  expect(await getRun(env.DB, msg.runId)).toBeNull()
  healthy = true
  vi.mocked(Date.now).mockReturnValue(now + 61000)
  await runDurableObjectAlarm(stub)
  expect(await getRun(env.DB, msg.runId)).toMatchObject({ status: 'failed' })
  expect(await stub.status()).toMatchObject({ terminalPending: 0, alarmAt: null })
  expect(send).not.toHaveBeenCalled()
})

it('does not reset exhausted action handoffs when D1 terminal writes fail permanently', async () => {
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const task = await createTaskRow({ schedule: { type: 'manual' } })
  const stub = env.TASK_SCHEDULER.getByName(task.id)
  const id = 'exhausted-action'
  const writes = vi.fn(() => { throw new Error('D1 unavailable') })
  await runInDurableObject(stub, (instance, state) => {
    const real = (instance as unknown as { env: CloudflareBindings }).env
    Object.defineProperty(instance, 'env', { value: Object.create(real, { DB: { value: { prepare: writes } } }) })
    return state.storage.put(`action:${id}`, { id, deliveries: 10, createdAt: now, dueAt: now + 60000 })
  })
  await stub.scheduleAction(id, now + 60000)
  expect(await runDurableObjectAlarm(stub)).toBe(true)
  await vi.waitFor(async () => expect((await stub.status()).terminalPending).toBe(1))
  for (let n = 1; n <= 12; n++) {
    vi.mocked(Date.now).mockReturnValue(now + n * 61000)
    await stub.scheduleAction(id, Date.now())
    await runDurableObjectAlarm(stub)
  }
  expect(writes).toHaveBeenCalledTimes(10)
  expect(await stub.status()).toMatchObject({ terminalPending: 1, terminalExhausted: 1, alarmAt: null })
  expect(await runInDurableObject(stub, (_, state) => state.storage.get(`action:${id}`))).toBeUndefined()
})

it('a terminal cleanup alarm does not fire the next cron occurrence early', async () => {
  const now = (Math.floor(Date.now() / 86400000) + 1) * 86400000 + 8 * 3600000
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const task = await createTaskRow({ schedule: { type: 'cron', cron: '0 0 9 * * *', timezone: 'UTC' } })
  const stub = env.TASK_SCHEDULER.getByName(task.id)
  await stub.sync(toSnapshot(task))
  const send = vi.fn().mockResolvedValue(undefined)
  await runInDurableObject(stub, (instance, state) => {
    const real = (instance as unknown as { env: CloudflareBindings }).env
    Object.defineProperty(instance, 'env', { value: Object.create(real, { RUN_QUEUE: { value: { send } } }) })
    return state.storage.put('terminal:action:old', { id: 'action:old', actionId: 'old', reason: 'exhausted', attempts: 0, createdAt: now, dueAt: now + 1000 })
  })
  await stub.sync(toSnapshot(task))
  await runInDurableObject(stub, (_, state) => state.storage.setAlarm(now + 1000))
  vi.mocked(Date.now).mockReturnValue(now + 1000)
  await runDurableObjectAlarm(stub)
  expect(send).not.toHaveBeenCalled()
  expect((await stub.status()).alarmAt).toBe(now + 3600000)
})

it('does not charge global quota on a task rejection and isolates kinds and UTC days', async () => {
  await safety({ taskDailyLimit: 1, globalDailyLimit: 2 })
  const now = Date.UTC(2026, 9, 18)
  await admit(env.DB, 'a', 'dispatch', now)
  await expect(admit(env.DB, 'a', 'dispatch', now)).rejects.toThrow('budget exhausted')
  await admit(env.DB, 'b', 'dispatch', now)
  await expect(admit(env.DB, 'c', 'dispatch', now)).rejects.toThrow('budget exhausted')
  await admit(env.DB, 'a', 'attempt', now)
  await admit(env.DB, 'a', 'dispatch', now + 86400000)
  const { results } = await env.DB.prepare('SELECT day,kind,count FROM execution_budget_totals ORDER BY day,kind').all()
  expect(results).toEqual([
    { day: now / 86400000, kind: 'attempt', count: 1 },
    { day: now / 86400000, kind: 'dispatch', count: 2 },
    { day: now / 86400000 + 1, kind: 'dispatch', count: 1 },
  ])
  expect(await env.DB.prepare("SELECT count FROM execution_budget WHERE task_id='c'").first()).toBeNull()
})

it('rolls back task quota if updating the global quota fails', async () => {
  const now = Date.UTC(2026, 9, 18)
  await admit(env.DB, 'a', 'dispatch', now)
  const broken = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: (statements: D1PreparedStatement[]) => env.DB.batch([
      ...statements,
      env.DB.prepare("INSERT INTO execution_budget_totals(day,kind,count) VALUES(0,'failure',NULL)"),
    ]),
  } as unknown as D1Database
  await expect(admit(broken, 'a', 'dispatch', now)).rejects.toThrow()
  expect(await env.DB.prepare("SELECT count FROM execution_budget WHERE task_id='a'").first('count')).toBe(1)
  expect(await env.DB.prepare("SELECT count FROM execution_budget_totals WHERE kind='dispatch'").first('count')).toBe(1)
})

it('maintenance removes old task and global counters together without resetting recent quotas', async () => {
  const now = Date.now()
  for (const daysAgo of [0, 2, 3]) await admit(env.DB, 'retention-task', 'dispatch', now - daysAgo * 86400000)
  await runMaintenance(env, now)
  const day = Math.floor(now / 86400000)
  const tasks = await env.DB.prepare('SELECT day,count FROM execution_budget ORDER BY day').all()
  const totals = await env.DB.prepare('SELECT day,count FROM execution_budget_totals ORDER BY day').all()
  expect(tasks.results).toEqual([{ day: day - 2, count: 1 }, { day, count: 1 }])
  expect(totals.results).toEqual(tasks.results)
})


it('saving lower safety limits preserves consumed quota and blocks further attempts', async () => {
  const now = Date.now()
  await admit(env.DB, 'quota-task', 'attempt', now)
  await admit(env.DB, 'quota-task', 'attempt', now)
  const saved = await putSafetySettings(env.DB, { paused: false, taskDailyLimit: 1, globalDailyLimit: 100000 }, 0)
  expect(saved).toMatchObject({ settings: { taskDailyLimit: 1 }, version: 1 })
  await expect(admit(env.DB, 'quota-task', 'attempt', now)).rejects.toThrow('budget exhausted')
  expect(await env.DB.prepare("SELECT count FROM execution_budget WHERE task_id='quota-task' AND kind='attempt'").first('count')).toBe(2)
  expect(await env.DB.prepare("SELECT count FROM execution_budget_totals WHERE kind='attempt'").first('count')).toBe(2)
})
