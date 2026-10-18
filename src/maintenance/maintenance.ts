import { withDeadline } from '../lib/deadline'
import { DAY_MS, markLostRuns, PURGE_BATCH, purgeOldRuns } from '../domain/runs-repo'
import { getRuntimeSettings } from '../domain/settings'
import { dueActions, expireActions } from '../domain/actions-repo'
import { purgeOldStats } from '../domain/stats-repo'
import { syncScheduler } from '../domain/task-service'
import { listAllTasks, listTaskIds } from '../domain/tasks-repo'

const SYNC_CONCURRENCY = 20
export const FULL_RECONCILE_MS = 60 * 60_000
const RECONCILE_KEY = 'maintenance:scheduler-reconcile'
const MAX_PURGE_BATCHES = 4
export const MAINTENANCE_TASK_BATCH = 100
const CURSOR_KEY = 'maintenance:cursors'
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
  const [lastFull, settings, cursorRow] = await Promise.all([
    env.DB.prepare('SELECT updated_at FROM settings WHERE key = ?').bind(RECONCILE_KEY).first<{ updated_at: number }>(),
    getRuntimeSettings(env.DB),
    env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(CURSOR_KEY).first<{ value: string }>(),
  ])
  const cursor: { sync: string; purge: string; full: boolean } = cursorRow ? JSON.parse(cursorRow.value) : { sync: '', purge: '', full: false }
  const fullReconcile = cursor.full || !lastFull || now - lastFull.updated_at >= FULL_RECONCILE_MS
  const [tasks, taskIds] = await Promise.all([
    listAllTasks(env.DB, !fullReconcile, fullReconcile && !cursor.full ? '' : cursor.sync, MAINTENANCE_TASK_BATCH),
    listTaskIds(env.DB, cursor.purge, MAINTENANCE_TASK_BATCH),
  ])
  let syncFailures = 0
  for (let i = 0; i < tasks.length; i += SYNC_CONCURRENCY) {
    const results = await Promise.all(tasks.slice(i, i + SYNC_CONCURRENCY).map((t) => syncScheduler(env, t)))
    syncFailures += results.filter((ok) => !ok).length
  }
  if (fullReconcile && tasks.length < MAINTENANCE_TASK_BATCH) {
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, '{}', ?)
       ON CONFLICT (key) DO UPDATE SET updated_at = MAX(settings.updated_at, excluded.updated_at)`,
    ).bind(RECONCILE_KEY, now).run()
  }

  await env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(CURSOR_KEY, JSON.stringify({
      sync: tasks.length === MAINTENANCE_TASK_BATCH ? tasks.at(-1)!.id : '',
      purge: cursor.purge,
      full: fullReconcile && tasks.length === MAINTENANCE_TASK_BATCH,
    }), now).run()
  await env.DB.prepare('DELETE FROM stats_cache WHERE key IN (SELECT key FROM stats_cache WHERE expires_at < ? AND lease_until < ? LIMIT 100)').bind(now, now).run()
  await expireActions(env.DB, now)
  const budgetCutoff = Math.floor(now / DAY_MS) - 2
  await env.DB.batch([
    env.DB.prepare('DELETE FROM execution_budget WHERE day < ?').bind(budgetCutoff),
    env.DB.prepare('DELETE FROM execution_budget_totals WHERE day < ?').bind(budgetCutoff),
  ])
  const lostRuns = await markLostRuns(env.DB, now)

  const actions = await dueActions(env.DB, now)
  for (let i = 0; i < actions.length; i += SYNC_CONCURRENCY) {
    await Promise.all(actions.slice(i, i + SYNC_CONCURRENCY).map(async (action) => {
      try {
        await withDeadline(env.TASK_SCHEDULER.getByName(action.taskId).scheduleAction(action.id, action.dueAt))
      } catch (err) {
        console.error('action recovery failed', action.id, err)
      }
    }))
  }

  const runsCutoff = now - settings.retentionDays * DAY_MS
  let purgedRuns = 0
  let purgeAfter = cursor.purge
  let pending = taskIds
  // Tasks that hit the per-statement limit still have a backlog; go round again.
  while (pending.length > 0 && purgedRuns <= MAX_PURGED_RUNS - PURGE_BATCH) {
    const backlog: string[] = []
    for (let i = 0; i < pending.length && purgedRuns <= MAX_PURGED_RUNS - PURGE_BATCH;) {
      const chunk = pending.slice(i, i + Math.min(PURGE_TASKS_PER_BATCH, Math.floor((MAX_PURGED_RUNS - purgedRuns) / PURGE_BATCH)))
      const counts = await purgeOldRuns(env.DB, chunk, runsCutoff)
      i += chunk.length
      // Only advance past tasks whose purge query actually completed. Backlog
      // rounds may revisit earlier IDs; never move this cursor backwards.
      if (chunk.at(-1)! > purgeAfter) purgeAfter = chunk.at(-1)!
      const completedPage = taskIds.length < MAINTENANCE_TASK_BATCH && purgeAfter === taskIds.at(-1)
      await env.DB.prepare("UPDATE settings SET value=json_set(value,'$.purge',?),updated_at=? WHERE key=?")
        .bind(completedPage ? '' : purgeAfter, now, CURSOR_KEY).run()
      counts.forEach((n, j) => {
        purgedRuns += n
        if (n === PURGE_BATCH) backlog.push(chunk[j])
      })
    }
    pending = backlog
  }

  if (taskIds.length === 0) {
    await env.DB.prepare("UPDATE settings SET value=json_set(value,'$.purge',''),updated_at=? WHERE key=?").bind(now, CURSOR_KEY).run()
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
