import { DAY_MS, markLostRuns, PURGE_BATCH, purgeOldRuns } from '../domain/runs-repo'
import { getRuntimeSettings } from '../domain/settings'
import { dueActions } from '../domain/actions-repo'
import { purgeOldStats } from '../domain/stats-repo'
import { syncScheduler } from '../domain/task-service'
import { listAllTasks, listTaskIds } from '../domain/tasks-repo'

const SYNC_CONCURRENCY = 20
export const FULL_RECONCILE_MS = 60 * 60_000
const RECONCILE_KEY = 'maintenance:scheduler-reconcile'
const MAX_PURGE_BATCHES = 4
/** Tasks purged per D1 batch, and the per-run cap on purged runs (a backlog drains over several runs). */
const PURGE_TASKS_PER_BATCH = 20
const MAX_PURGED_RUNS = 20_000

export interface MaintenanceReport {
  tasks: number
  fullReconcile: boolean
  syncFailures: number
  lostRuns: number
  purgedRuns: number
  purgedStats: number
}

/**
 * Every 5 minutes, retry unsynced versions; once per hour also heal lost alarms
 * and interrupted once-task disables. Close out lost runs and purge
 * logs and statistics older than the retention periods saved in runtime settings.
 */
export async function runMaintenance(env: CloudflareBindings, now = Date.now()): Promise<MaintenanceReport> {
  const [lastFull, settings, taskIds] = await Promise.all([
    env.DB.prepare('SELECT updated_at FROM settings WHERE key = ?').bind(RECONCILE_KEY).first<{ updated_at: number }>(),
    getRuntimeSettings(env.DB),
    listTaskIds(env.DB),
  ])
  const fullReconcile = !lastFull || now - lastFull.updated_at >= FULL_RECONCILE_MS
  const tasks = await listAllTasks(env.DB, !fullReconcile)
  let syncFailures = 0
  for (let i = 0; i < tasks.length; i += SYNC_CONCURRENCY) {
    const results = await Promise.all(tasks.slice(i, i + SYNC_CONCURRENCY).map((t) => syncScheduler(env, t)))
    syncFailures += results.filter((ok) => !ok).length
  }
  if (fullReconcile) {
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, '{}', ?)
       ON CONFLICT (key) DO UPDATE SET updated_at = MAX(settings.updated_at, excluded.updated_at)`,
    ).bind(RECONCILE_KEY, now).run()
  }

  const lostRuns = await markLostRuns(env.DB, now)

  for (const action of await dueActions(env.DB, now)) {
    try {
      await env.TASK_SCHEDULER.getByName(action.taskId).scheduleAction(action.id, action.dueAt)
    } catch (err) {
      console.error('action recovery failed', action.id, err)
    }
  }

  const runsCutoff = now - settings.retentionDays * DAY_MS
  let purgedRuns = 0
  let pending = taskIds
  // Tasks that hit the per-statement limit still have a backlog; go round again.
  while (pending.length > 0 && purgedRuns < MAX_PURGED_RUNS) {
    const backlog: string[] = []
    for (let i = 0; i < pending.length && purgedRuns < MAX_PURGED_RUNS; i += PURGE_TASKS_PER_BATCH) {
      const chunk = pending.slice(i, i + PURGE_TASKS_PER_BATCH)
      const counts = await purgeOldRuns(env.DB, chunk, runsCutoff)
      counts.forEach((n, j) => {
        purgedRuns += n
        if (n === PURGE_BATCH) backlog.push(chunk[j])
      })
    }
    pending = backlog
  }

  const statsCutoff = now - settings.statsRetentionDays * DAY_MS
  let purgedStats = 0
  for (let i = 0; i < MAX_PURGE_BATCHES; i++) {
    const n = await purgeOldStats(env.DB, statsCutoff)
    purgedStats += n
    if (n === 0) break
  }

  const report = { tasks: tasks.length, fullReconcile, syncFailures, lostRuns, purgedRuns, purgedStats }
  console.log(JSON.stringify({ event: 'maintenance', ...report }))
  return report
}
