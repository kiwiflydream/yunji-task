import { DAY_MS, markLostRuns, PURGE_BATCH, purgeOldRuns } from '../domain/runs-repo'
import { getRuntimeSettings } from '../domain/settings'
import { purgeOldStats } from '../domain/stats-repo'
import { syncScheduler } from '../domain/task-service'
import { listAllTasks } from '../domain/tasks-repo'

const SYNC_CONCURRENCY = 20
const MAX_PURGE_BATCHES = 4
/** Tasks purged per D1 batch, and the per-run cap on purged runs (a backlog drains over several runs). */
const PURGE_TASKS_PER_BATCH = 20
const MAX_PURGED_RUNS = 20_000

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
 * logs and statistics older than the retention periods saved in runtime settings.
 */
export async function runMaintenance(env: CloudflareBindings, now = Date.now()): Promise<MaintenanceReport> {
  const [tasks, settings] = await Promise.all([listAllTasks(env.DB), getRuntimeSettings(env.DB)])
  let syncFailures = 0
  for (let i = 0; i < tasks.length; i += SYNC_CONCURRENCY) {
    const results = await Promise.all(tasks.slice(i, i + SYNC_CONCURRENCY).map((t) => syncScheduler(env, t)))
    syncFailures += results.filter((ok) => !ok).length
  }

  const lostRuns = await markLostRuns(env.DB, now)

  const runsCutoff = now - settings.retentionDays * DAY_MS
  let purgedRuns = 0
  let pending = tasks.map((t) => t.id)
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

  const report = { tasks: tasks.length, syncFailures, lostRuns, purgedRuns, purgedStats }
  console.log(JSON.stringify({ event: 'maintenance', ...report }))
  return report
}
