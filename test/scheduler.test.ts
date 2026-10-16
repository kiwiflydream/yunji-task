import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { getTask } from '../src/domain/tasks-repo'
import { listRuns } from '../src/domain/runs-repo'
import type { TaskScheduler } from '../src/scheduler/task-scheduler'
import { captureQueue, createTaskRow, snapshotFor, toSnapshot } from './helpers'

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
})
