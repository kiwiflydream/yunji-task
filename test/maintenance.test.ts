import { createExecutionContext, createScheduledController, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { claimRun, getRun, recordAttempt, RETRYING_STALE_MS, RUNNING_STALE_MS } from '../src/domain/runs-repo'
import { getTask } from '../src/domain/tasks-repo'
import worker from '../src/index'
import { FULL_RECONCILE_MS, runMaintenance } from '../src/maintenance/maintenance'
import { syncScheduler } from '../src/domain/task-service'
import type { TaskScheduler } from '../src/scheduler/task-scheduler'
import { createTaskRow, setRuntimeSettings, toSnapshot } from './helpers'

const DAY = 24 * 60 * 60_000

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM settings WHERE key = 'maintenance:scheduler-reconcile'").run()
})

async function seedRun(taskId: string, at: number, status: 'running' | 'retrying' | 'success') {
  const runId = crypto.randomUUID()
  await claimRun(env.DB, { runId, taskId, trigger: 'manual', scheduledAt: at, attempt: 1 }, at)
  if (status !== 'running') {
    await recordAttempt(env.DB, runId, status, { httpStatus: 500, responseBody: null, error: 'HTTP 500', durationMs: 1 }, at)
  }
  return runId
}

describe('runMaintenance', () => {
  it('only syncs dirty task versions between hourly full sweeps, while retention still covers healthy tasks', async () => {
    const task = await createTaskRow()
    const now = Date.now()
    expect((await runMaintenance(env, now)).fullReconcile).toBe(true)
    const old = await seedRun(task.id, now - 40 * DAY, 'success')
    expect(await runMaintenance(env, now + 5 * 60_000)).toMatchObject({ tasks: 0, fullReconcile: false })
    expect(await getRun(env.DB, old)).toBeNull()

    const dirty = await createTaskRow()
    expect(await runMaintenance(env, now + 10 * 60_000)).toMatchObject({ tasks: 1, fullReconcile: false })
    expect((await env.TASK_SCHEDULER.getByName(dirty.id).status()).version).toBe(dirty.version)

    const stub = env.TASK_SCHEDULER.getByName(task.id)
    await runInDurableObject(stub, (_i: TaskScheduler, state) => state.storage.deleteAlarm())
    await runMaintenance(env, now + 15 * 60_000)
    expect((await stub.status()).alarmAt).toBeNull()
    expect((await runMaintenance(env, now + FULL_RECONCILE_MS)).fullReconcile).toBe(true)
    expect((await stub.status()).alarmAt).not.toBeNull()
  })

  it('keeps failed syncs dirty and does not mark a concurrent newer edit as synced', async () => {
    const task = await createTaskRow()
    const broken = Object.create(env, { TASK_SCHEDULER: { value: { getByName: () => ({ sync: async () => { throw new Error('unavailable') } }) } } }) as CloudflareBindings
    expect(await syncScheduler(broken, task)).toBe(false)
    const { listAllTasks, setTaskEnabled } = await import('../src/domain/tasks-repo')
    expect((await listAllTasks(env.DB, true)).some((t) => t.id === task.id)).toBe(true)
    const updated = await setTaskEnabled(env.DB, task.id, false, Date.now())
    await syncScheduler(env, task)
    expect((await listAllTasks(env.DB, true)).find((t) => t.id === task.id)?.version).toBe(updated?.version)
    await runMaintenance(env)
    expect((await listAllTasks(env.DB, true)).some((t) => t.id === task.id)).toBe(false)
  })

  it('retries only the failed task after a full sweep instead of repeating the whole sweep', async () => {
    const task = await createTaskRow()
    const now = Date.now()
    await runMaintenance(env, now)
    const broken = Object.create(env, { TASK_SCHEDULER: { value: {
      getByName: (id: string) => id === task.id
        ? { sync: async () => { throw new Error('unavailable') } }
        : env.TASK_SCHEDULER.getByName(id),
    } } }) as CloudflareBindings
    expect(await runMaintenance(broken, now + FULL_RECONCILE_MS)).toMatchObject({ fullReconcile: true, syncFailures: 1 })
    expect(await runMaintenance(env, now + FULL_RECONCILE_MS + 5 * 60_000)).toMatchObject({ tasks: 1, fullReconcile: false, syncFailures: 0 })
  })

  it('re-arms a scheduler that lost its alarm', async () => {
    const task = await createTaskRow()
    const stub = env.TASK_SCHEDULER.getByName(task.id)
    await stub.sync(toSnapshot(task))
    await runInDurableObject(stub, (_i: TaskScheduler, state) => state.storage.deleteAlarm())
    expect((await stub.status()).alarmAt).toBeNull()

    await runMaintenance(env)
    expect((await stub.status()).alarmAt).not.toBeNull()
  })

  it('syncs a task whose DO never received its snapshot', async () => {
    const task = await createTaskRow()
    const stub = env.TASK_SCHEDULER.getByName(task.id)
    expect((await stub.status()).version).toBeNull()
    await runMaintenance(env)
    expect(await stub.status()).toMatchObject({ version: 1 })
  })

  it('finishes disabling a once task whose post-fire D1 update was lost', async () => {
    const task = await createTaskRow({ schedule: { type: 'once', runAt: Date.now() + 60_000 } })
    const stub = env.TASK_SCHEDULER.getByName(task.id)
    await stub.sync(toSnapshot(task))
    // State after alarm() fired but disableFiredOnceTask failed.
    await runInDurableObject(stub, async (_i: TaskScheduler, state) => {
      await state.storage.put('onceFiredVersion', task.version)
      await state.storage.deleteAlarm()
    })
    expect((await getTask(env.DB, task.id))?.enabled).toBe(true)

    await runMaintenance(env)
    expect((await getTask(env.DB, task.id))?.enabled).toBe(false)
    expect((await stub.status()).alarmAt).toBeNull()
  })

  it('marks only stale running/retrying runs as lost', async () => {
    const task = await createTaskRow()
    const now = Date.now()
    const staleRunning = await seedRun(task.id, now - RUNNING_STALE_MS - 1000, 'running')
    const freshRunning = await seedRun(task.id, now - 60_000, 'running')
    const staleRetrying = await seedRun(task.id, now - RETRYING_STALE_MS - 1000, 'retrying')
    const freshRetrying = await seedRun(task.id, now - RUNNING_STALE_MS - 1000, 'retrying')

    await runMaintenance(env, now)
    expect((await getRun(env.DB, staleRunning))?.status).toBe('failed')
    expect((await getRun(env.DB, staleRunning))?.error).toMatch(/^lost:/)
    expect((await getRun(env.DB, staleRetrying))?.error).toBe('HTTP 500 | lost: no result reported (consumer crashed or message dropped)')
    expect((await getRun(env.DB, freshRunning))?.status).toBe('running')
    expect((await getRun(env.DB, freshRetrying))?.status).toBe('retrying')
  })

  it('purges runs older than the default 30-day retention only', async () => {
    const task = await createTaskRow()
    const now = Date.now()
    const old = await seedRun(task.id, now - 30 * DAY - 1000, 'success')
    const recent = await seedRun(task.id, now - 30 * DAY + 60_000, 'success')
    const report = await runMaintenance(env, now)
    expect(report.purgedRuns).toBeGreaterThanOrEqual(1)
    expect(await getRun(env.DB, old)).toBeNull()
    expect(await getRun(env.DB, recent)).not.toBeNull()
  })

  it('uses saved log retention settings on the next cleanup', async () => {
    const task = await createTaskRow()
    const now = Date.now()
    const eightDays = await seedRun(task.id, now - 8 * DAY, 'success')
    const sixDays = await seedRun(task.id, now - 6 * DAY, 'success')
    await runMaintenance(env, now)
    expect(await getRun(env.DB, eightDays)).not.toBeNull()
    await setRuntimeSettings({ retentionDays: 7 })
    await runMaintenance(env, now)
    expect(await getRun(env.DB, eightDays)).toBeNull()
    expect(await getRun(env.DB, sixDays)).not.toBeNull()
  })

  it('is wired to the scheduled handler', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const ctx = createExecutionContext()
    await worker.scheduled(createScheduledController({ cron: '*/5 * * * *' }), env, ctx)
    await waitOnExecutionContext(ctx)
    expect(log.mock.calls.some(([line]) => String(line).includes('"event":"maintenance"'))).toBe(true)
    log.mockRestore()
  })
})
