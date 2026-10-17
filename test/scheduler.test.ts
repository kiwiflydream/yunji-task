import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getTask } from '../src/domain/tasks-repo'
import { listRuns } from '../src/domain/runs-repo'
import type { PendingRun, TaskScheduler } from '../src/scheduler/task-scheduler'
import { processRun } from '../src/executor/consumer'
import { captureQueue, createTaskRow, setRuntimeSettings, snapshotFor, toSnapshot } from './helpers'

afterEach(() => vi.restoreAllMocks())

const stubFor = (taskId: string) => env.TASK_SCHEDULER.getByName(taskId)
const storedNext = (stub: DurableObjectStub<TaskScheduler>) =>
  runInDurableObject(stub, (_i: TaskScheduler, state) => state.storage.get<number>('nextRunAt'))

describe('TaskScheduler.sync', () => {
  it('arms the alarm at the next cron fire time', async () => {
    const snap = snapshotFor()
    const before = Date.now()
    const status = await stubFor(snap.taskId).sync(snap)
    expect(status.version).toBe(1)
    expect(status.alarmAt).not.toBeNull()
    expect(status.alarmAt! % 10_000).toBe(0)
    expect(status.alarmAt!).toBeGreaterThan(before)
    expect(status.alarmAt!).toBeLessThanOrEqual(before + 10_000)
  })

  it('ignores snapshots older than the stored version', async () => {
    const snap = snapshotFor({ version: 5 })
    const stub = stubFor(snap.taskId)
    await stub.sync(snap)
    const status = await stub.sync({ ...snap, version: 4, enabled: false })
    expect(status.version).toBe(5)
    expect(status.alarmAt).not.toBeNull()
  })

  it('clears the alarm when disabled or manual', async () => {
    const snap = snapshotFor()
    const stub = stubFor(snap.taskId)
    await stub.sync(snap)
    expect((await stub.sync({ ...snap, version: 2, enabled: false })).alarmAt).toBeNull()
    expect((await stub.sync({ ...snap, version: 3, scheduleType: 'manual', cron: null })).alarmAt).toBeNull()
  })

  it('re-arms a missing alarm for the same version (reconcile)', async () => {
    const snap = snapshotFor()
    const stub = stubFor(snap.taskId)
    await stub.sync(snap)
    await runInDurableObject(stub, (_i: TaskScheduler, state) => state.storage.deleteAlarm())
    expect((await stub.sync(snap)).alarmAt).not.toBeNull()
  })
})

describe('TaskScheduler.alarm', () => {
  it('dispatches a run for the scheduled time and re-arms for the next one', async () => {
    const snap = snapshotFor()
    const stub = stubFor(snap.taskId)
    await stub.sync(snap)
    const sent = await captureQueue(stub)
    const scheduledAt = await storedNext(stub)

    expect(await runDurableObjectAlarm(stub)).toBe(true)

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ taskId: snap.taskId, trigger: 'schedule', scheduledAt, attempt: 1 })
    const status = await stub.status()
    expect(status.alarmAt).toBe(scheduledAt! + 10_000)
    expect(status.running?.runId).toBe(sent[0].runId)
  })

  it('skip policy: records a skipped run while the previous one holds the slot', async () => {
    const task = await createTaskRow()
    const stub = stubFor(task.id)
    await stub.sync(toSnapshot(task))
    const sent = await captureQueue(stub)

    await runDurableObjectAlarm(stub)
    await runDurableObjectAlarm(stub)
    expect(sent).toHaveLength(1)
    const runs = await listRuns(env.DB, task.id, { limit: 10 })
    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe('skipped')
    expect(runs[0].error).toContain(sent[0].runId)

    await stub.complete(sent[0].runId)
    await runDurableObjectAlarm(stub)
    expect(sent).toHaveLength(2)
  })

  it('skip policy: complete() with a different runId keeps the slot', async () => {
    const snap = snapshotFor()
    const stub = stubFor(snap.taskId)
    await stub.sync(snap)
    const sent = await captureQueue(stub)
    await runDurableObjectAlarm(stub)
    await stub.complete('some-other-run')
    expect((await stub.status()).running?.runId).toBe(sent[0].runId)
  })

  it('skip policy: an expired lease no longer blocks', async () => {
    const snap = snapshotFor({ leaseMs: -1 })
    const stub = stubFor(snap.taskId)
    await stub.sync(snap)
    const sent = await captureQueue(stub)
    await runDurableObjectAlarm(stub)
    await runDurableObjectAlarm(stub)
    expect(sent).toHaveLength(2)
  })

  it('parallel policy: dispatches every fire without holding a slot', async () => {
    const snap = snapshotFor({ overlapPolicy: 'parallel' })
    const stub = stubFor(snap.taskId)
    await stub.sync(snap)
    const sent = await captureQueue(stub)
    await runDurableObjectAlarm(stub)
    await runDurableObjectAlarm(stub)
    expect(sent).toHaveLength(2)
    expect(sent[0].runId).not.toBe(sent[1].runId)
    expect((await stub.status()).running).toBeNull()
  })

  it('once: fires exactly once and disables the task in D1', async () => {
    const runAt = Date.now() + 60_000
    const task = await createTaskRow({ schedule: { type: 'once', runAt } })
    const stub = stubFor(task.id)
    const status = await stub.sync(toSnapshot(task))
    expect(status.alarmAt).toBe(runAt)
    const sent = await captureQueue(stub)

    await runDurableObjectAlarm(stub)
    expect(sent).toHaveLength(1)
    expect(sent[0].scheduledAt).toBe(runAt)
    expect((await stub.status()).alarmAt).toBeNull()

    const after = await getTask(env.DB, task.id)
    expect(after?.enabled).toBe(false)
    expect(after?.version).toBe(task.version + 1)

    // A reconcile replaying the old (still enabled) snapshot must not re-arm it.
    expect((await stub.sync(toSnapshot(task))).alarmAt).toBeNull()
  })

  it('does nothing when the task is disabled', async () => {
    const snap = snapshotFor({ enabled: false })
    const stub = stubFor(snap.taskId)
    await stub.sync(snap)
    const sent = await captureQueue(stub)
    expect(await runDurableObjectAlarm(stub)).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('retains a failed once handoff across reconciliation and mode changes, then executes once', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const task = await createTaskRow({ schedule: { type: 'once', runAt: Date.now() + 60_000 }, alert: { mode: 'off' } })
    const stub = stubFor(task.id)
    await stub.sync(toSnapshot(task))
    await breakQueue(stub)
    await runDurableObjectAlarm(stub)
    const [entry] = await pending(stub)
    expect(entry).toMatchObject({ mode: 'queue', msg: { scheduledAt: task.schedule.type === 'once' ? task.schedule.runAt : 0, attempt: 1 } })
    expect((await getTask(env.DB, task.id))?.enabled).toBe(false)

    await setRuntimeSettings({ executionMode: 'worker' })
    await stub.sync(toSnapshot(task))
    const disabled = (await getTask(env.DB, task.id))!
    await runInDurableObject(stub, (_i, state) => state.storage.deleteAlarm())
    expect((await stub.sync(toSnapshot(disabled))).alarmAt).toBe(entry.dueAt)
    const sent = await captureQueue(stub)
    await runDurableObjectAlarm(stub)
    expect(sent).toEqual([entry.msg])
    expect(await pending(stub)).toEqual([])
    expect((await stub.status()).alarmAt).toBeNull()
    await processRun(entry.msg, env)
    await processRun(entry.msg, env)
    expect(fetch).toHaveBeenCalledOnce()
    expect(await listRuns(env.DB, task.id, { limit: 10 })).toMatchObject([{ status: 'success', executionMode: 'queue' }])
    expect(await runDurableObjectAlarm(stub)).toBe(false)
  })

  it('keeps the same queue handoff through a prolonged outage instead of discarding it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const task = await createTaskRow({ schedule: { type: 'once', runAt: Date.now() + 60_000 } })
    const stub = stubFor(task.id)
    await stub.sync(toSnapshot(task))
    await breakQueue(stub)
    let runId: string | undefined
    for (let attempt = 1; attempt <= 5; attempt++) {
      await runDurableObjectAlarm(stub)
      const entries = await pending(stub)
      expect(entries).toHaveLength(1)
      runId ??= entries[0].msg.runId
      expect(entries[0]).toMatchObject({ deliveries: attempt, msg: { runId, attempt: 1 } })
      expect((await stub.status()).alarmAt).toBe(entries[0].dueAt)
    }
    const sent = await captureQueue(stub)
    await runDurableObjectAlarm(stub)
    expect(sent).toMatchObject([{ runId }])
    expect(await pending(stub)).toEqual([])
  })

  it('a queued handoff waiting for recovery still blocks overlapping scheduled runs after lease expiry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const task = await createTaskRow()
    const stub = stubFor(task.id)
    await stub.sync({ ...toSnapshot(task), leaseMs: -1 })
    await breakQueue(stub)
    await runDurableObjectAlarm(stub)
    const [entry] = await pending(stub)
    await runDurableObjectAlarm(stub)
    expect(await pending(stub)).toEqual([entry])
    expect(await listRuns(env.DB, task.id, { limit: 10 })).toMatchObject([{ status: 'skipped' }])
  })
})

const pending = (stub: DurableObjectStub<TaskScheduler>) =>
  runInDurableObject(stub, async (_i, state) => [...(await state.storage.list<PendingRun>({ prefix: 'pending:' })).values()])

async function breakQueue(stub: DurableObjectStub<TaskScheduler>) {
  await runInDurableObject(stub, (instance) => {
    const real = (instance as unknown as { env: CloudflareBindings }).env
    Object.defineProperty(instance, 'env', {
      configurable: true,
      value: Object.create(real, { RUN_QUEUE: { value: { send: async () => { throw new Error('temporary queue outage') } } } }),
    })
  })
}
