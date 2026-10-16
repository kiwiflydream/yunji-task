import { DAY_MS, markLostRuns, purgeOldRuns, retentionDays, statsRetentionDays } from '../domain/runs-repo'
import { purgeOldStats } from '../domain/stats-repo'
import { syncScheduler } from '../domain/task-service'
import { listAllTasks } from '../domain/tasks-repo'

const SYNC_CONCURRENCY = 20
const MAX_PURGE_BATCHES = 4

export interface MaintenanceReport {
  tasks: number
  syncFailures: number
  lostRuns: number
  purgedRuns: number
  purgedStats: number
}

/**
 * Runs on the 5-minute cron: replay D1 state into every DO (re-arming lost alarms,
 * finishing interrupted once-task disables), close out lost runs and purge
 * runs older than RUN_RETENTION_DAYS and statistics older than STATS_RETENTION_DAYS.
 */
export async function runMaintenance(env: CloudflareBindings, now = Date.now()): Promise<MaintenanceReport> {
  const tasks = await listAllTasks(env.DB)
  let syncFailures = 0
  for (let i = 0; i < tasks.length; i += SYNC_CONCURRENCY) {
    const results = await Promise.all(tasks.slice(i, i + SYNC_CONCURRENCY).map((t) => syncScheduler(env, t)))
    syncFailures += results.filter((ok) => !ok).length
  }

  const lostRuns = await markLostRuns(env.DB, now)

  const days = retentionDays(env.RUN_RETENTION_DAYS)
  let purgedRuns = 0
  for (let i = 0; i < MAX_PURGE_BATCHES; i++) {
    const n = await purgeOldRuns(env.DB, now, days)
    purgedRuns += n
    if (n === 0) break
  }

  const statsCutoff = now - statsRetentionDays(env.STATS_RETENTION_DAYS) * DAY_MS
  let purgedStats = 0
  for (let i = 0; i < MAX_PURGE_BATCHES; i++) {
    const n = await purgeOldStats(env.DB, statsCutoff)
    purgedStats += n
    if (n === 0) break
  }

  const report = { tasks: tasks.length, syncFailures, lostRuns, purgedRuns, purgedStats }
  console.log(JSON.stringify({ event: 'maintenance', ...report }))
  return report
}
