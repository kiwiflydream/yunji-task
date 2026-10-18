import { env } from 'cloudflare:workers'
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { afterEach, expect, it, vi } from 'vitest'
import { actionsForRun, claimAction, completeAction, type RunAction } from '../src/domain/actions-repo'
import { claimRun, getRun, insertSkippedRun, recordAttempt, type RunMessage } from '../src/domain/runs-repo'
import { deleteTask, updateTask } from '../src/domain/tasks-repo'
import { taskInputSchema } from '../src/domain/task'
import { runMaintenance } from '../src/maintenance/maintenance'
import type { PendingRun, TaskScheduler } from '../src/scheduler/task-scheduler'
import { createTaskRow, toSnapshot } from './helpers'

afterEach(() => vi.restoreAllMocks())

const pending = (stub: DurableObjectStub<TaskScheduler>) => runInDurableObject(stub, async (_, state) =>
  [...(await state.storage.list<PendingRun>({ prefix: 'pending:' })).values()])

for (const deliveries of [0, 2]) {
  it.each(['direct', 'worker', 'queue'] as const)(`%s same-attempt replay with deliveries=${deliveries} preserves the pending handoff`, async (mode) => {
    const stub = env.TASK_SCHEDULER.getByName(crypto.randomUUID())
    const dueAt = Date.now() + 86_400_000
    const msg: RunMessage = { taskId: crypto.randomUUID(), runId: crypto.randomUUID(), scheduledAt: dueAt, trigger: 'manual', attempt: 3 }
    const newest: PendingRun = mode === 'queue'
      ? { msg, dueAt, deliveries: 2, mode, leaseMs: 60_000 }
      : { msg, dueAt, deliveries: 2, mode }
    await stub.schedule(newest)
    expect(await pending(stub)).toEqual([newest])
    await stub.schedule({ ...newest, deliveries, dueAt: dueAt + 1000 })
    expect(await pending(stub)).toEqual([newest])
    expect((await stub.status()).alarmAt).toBe(dueAt)
  })
}

it.each(['direct', 'worker', 'queue'] as const)('%s pending attempts and deliveries never regress, including persisted records', async (mode) => {
  const stub = env.TASK_SCHEDULER.getByName(crypto.randomUUID())
  const dueAt = Date.now() + 86_400_000
  const msg: RunMessage = { taskId: crypto.randomUUID(), runId: crypto.randomUUID(), scheduledAt: dueAt, trigger: 'manual', attempt: 3 }
  const newest: PendingRun = mode === 'queue'
    ? { msg, dueAt, deliveries: 2, mode, leaseMs: 60_000 }
    : { msg, dueAt, deliveries: 2, mode }
  // Existing deployments store exactly this key, with no extra attempt metadata.
  await runInDurableObject(stub, (_, state) => state.storage.put(`pending:${msg.runId}`, newest))
  await stub.schedule({ ...newest, msg: { ...msg, attempt: 2 }, deliveries: 99, dueAt: dueAt - 1000 })
  expect(await pending(stub)).toEqual([newest])
  await stub.schedule({ ...newest, deliveries: 0, dueAt: dueAt - 1000 })
  expect(await pending(stub)).toEqual([newest])
  await stub.schedule({ ...newest, dueAt: dueAt + 1000 })
  expect(await pending(stub)).toEqual([newest])

  const advanced = { ...newest, msg: { ...msg, attempt: 4 }, deliveries: 0 }
  await Promise.all([stub.schedule(advanced), stub.schedule(newest)])
  expect(await pending(stub)).toEqual([advanced])
  await Promise.all([stub.schedule({ ...advanced, deliveries: 3 }), stub.schedule({ ...advanced, deliveries: 1 })])
  expect(await pending(stub)).toEqual([{ ...advanced, deliveries: 3 }])
  expect((await stub.status()).alarmAt).toBe(dueAt)
})

for (const mode of ['direct', 'worker'] as const) {
  for (const interrupted of [false, true]) {
    it(`${mode}: ${interrupted ? 'interrupted' : 'completed'} outbox handoff preserves attempt 3 through maintenance and independent RPCs`, async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('failure', { status: 500 }))
      const start = Date.now() + 86_400_000 // Only explicitly fired alarms run.
      vi.spyOn(Date, 'now').mockReturnValue(start)
      const task = await createTaskRow({ schedule: { type: 'manual' }, executionMode: mode, retry: { count: 2, intervalSeconds: 180 }, alert: { mode: 'off' } })
      const stub = env.TASK_SCHEDULER.getByName(task.id)
      await stub.sync(toSnapshot(task))
      const msg: RunMessage = { taskId: task.id, runId: crypto.randomUUID(), scheduledAt: start, trigger: 'manual', attempt: 1 }
      const next = { ...msg, attempt: 2 }
      const action: RunAction = {
        id: `${msg.runId}:retry:2`, taskId: task.id, runId: msg.runId, dueAt: start, attempts: 0,
        payload: { kind: 'retry', msg: next, mode, runAt: start + 180_000 },
      }
      expect(await claimRun(env.DB, msg, start)).toBe(true)
      expect(await recordAttempt(env.DB, msg.runId, 'retrying', { httpStatus: 500, responseBody: 'failure', error: 'failure', durationMs: 1 }, start, action)).toBe(true)
      const claimed = await claimAction(env.DB, action.id, start)
      expect(claimed).not.toBeNull()
      // Crash cutpoint: the scheduling RPC committed, but outbox completion may not.
      await stub.schedule({ msg: next, dueAt: start + 180_000, deliveries: 0, mode })
      if (!interrupted) await completeAction(env.DB, claimed!, start)

      vi.mocked(Date.now).mockReturnValue(start + 180_000)
      expect(await runDurableObjectAlarm(stub)).toBe(true)
      await vi.waitFor(async () => expect(await pending(stub)).toMatchObject([{ msg: { attempt: 3 }, dueAt: start + 360_000 }]))
      await vi.waitFor(async () => expect((await actionsForRun(env.DB, msg.runId)).map((a) => a.id)).toEqual(interrupted ? [action.id] : []))
      expect(await getRun(env.DB, msg.runId)).toMatchObject({ status: 'retrying', attempt: 2 })

      vi.mocked(Date.now).mockReturnValue(start + 300_000)
      await runMaintenance(env)
      if (interrupted) {
        expect(await runDurableObjectAlarm(stub)).toBe(true) // ActionExecutor replays the old scheduling RPC.
        await vi.waitFor(async () => expect(await actionsForRun(env.DB, msg.runId)).toEqual([]))
      }
      expect(await pending(stub)).toMatchObject([{ msg: { attempt: 3 }, dueAt: start + 360_000 }])
      expect((await stub.status()).alarmAt).toBe(start + 360_000)
      vi.mocked(Date.now).mockReturnValue(start + 360_000)
      expect(await runDurableObjectAlarm(stub)).toBe(true)
      await vi.waitFor(async () => expect(await getRun(env.DB, msg.runId)).toMatchObject({ status: 'failed', attempt: 3 }))
      expect(fetch).toHaveBeenCalledTimes(2) // Attempt 1 was seeded; 2 and 3 executed.
      expect(await pending(stub)).toEqual([])
      expect(await actionsForRun(env.DB, msg.runId)).toEqual([])
    })
  }
}

it('a once-sync suspended in D1 cannot overwrite a newer independent sync RPC or block its alarm', async () => {
  const start = Date.now() + 86_400_000
  vi.spyOn(Date, 'now').mockReturnValue(start)
  const task = await createTaskRow({ schedule: { type: 'once', runAt: start + 60_000 }, executionMode: 'queue' })
  const stub = env.TASK_SCHEDULER.getByName(task.id)
  await stub.sync(toSnapshot(task))
  let release!: () => void
  let entered = false
  const gate = new Promise<void>((resolve) => { release = resolve })
  const sent: RunMessage[] = []
  await runInDurableObject(stub, async (instance, state) => {
    await state.storage.put('onceFiredVersion', task.version)
    await state.storage.delete('nextRunAt')
    await state.storage.deleteAlarm()
    const real = (instance as unknown as { env: CloudflareBindings }).env
    const DB = {
      prepare: (query: string) => !query.includes('SET enabled = 0') ? real.DB.prepare(query) : ({ bind: (...args: unknown[]) => ({ run: async () => {
        entered = true
        await gate
        return real.DB.prepare(query).bind(...args).run()
      } }) }),
    }
    Object.defineProperty(instance, 'env', { configurable: true, value: Object.create(real, {
      DB: { value: DB }, RUN_QUEUE: { value: { send: async (msg: RunMessage) => { sent.push(msg) } } },
    }) })
  })
  const old = Promise.resolve(stub.sync(toSnapshot(task)))
  try {
    await vi.waitFor(() => expect(entered).toBe(true))
    const updated = await updateTask(env.DB, task.id, taskInputSchema.parse({ ...task, schedule: { type: 'cron', cron: '*/10 * * * * *' } }), start, task.version)
    await stub.sync(toSnapshot(updated!))
    expect(await stub.status()).toMatchObject({ version: 2, alarmAt: expect.any(Number) })
    // The old D1 call is still pending: newer RPCs and the normal alarm must work.
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect(sent).toHaveLength(1)
    const before = await stub.status()
    const nextBefore = await runInDurableObject(stub, (_, state) => state.storage.get<number>('nextRunAt'))
    release()
    await old
    expect(await stub.status()).toEqual(before)
    expect(await runInDurableObject(stub, (_, state) => state.storage.get<number>('nextRunAt'))).toBe(nextBefore)
  } finally {
    release()
    await old
  }
})

it('a late skipped write cannot resurrect deleted task statistics', async () => {
  const task = await createTaskRow()
  const now = Date.now()
  const skip = { taskId: task.id, scheduledAt: now, reason: 'previous run busy' }
  // Positive control: real skipped runs still contribute exactly once per insert.
  await insertSkippedRun(env.DB, skip, now)
  await insertSkippedRun(env.DB, skip, now)
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM runs WHERE task_id = ?').bind(task.id).first()).toEqual({ n: 2 })
  expect(await env.DB.prepare('SELECT skipped FROM run_stats WHERE task_id = ?').bind(task.id).first()).toEqual({ skipped: 2 })
  expect(await deleteTask(env.DB, task.id)).toBe(true)
  await insertSkippedRun(env.DB, skip, now)
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM runs WHERE task_id = ?').bind(task.id).first()).toEqual({ n: 0 })
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM run_stats WHERE task_id = ?').bind(task.id).first()).toEqual({ n: 0 })
})
