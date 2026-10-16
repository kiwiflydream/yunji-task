import { BUCKET_COUNT, bucketIndex, emptyAgg, floorHour, HOUR_MS, type Agg } from './stats'

const BUCKET_COLS = Array.from({ length: BUCKET_COUNT }, (_, i) => `dur_b${i}`)
const SUM_COLS = ['success', 'failed', 'skipped', 'duration_count', 'duration_sum', ...BUCKET_COLS, 'delay_count', 'delay_sum']
const MAX_COLS = ['duration_max', 'delay_max']
const INSERT_COLS = [
  'task_id',
  'hour',
  'success',
  'failed',
  'skipped',
  'duration_count',
  'duration_sum',
  'duration_max',
  ...BUCKET_COLS,
  'delay_count',
  'delay_sum',
  'delay_max',
].join(', ')

const ON_CONFLICT = `ON CONFLICT (task_id, hour) DO UPDATE SET ${[
  ...SUM_COLS.map((c) => `${c} = ${c} + excluded.${c}`),
  ...MAX_COLS.map((c) => `${c} = MAX(${c}, excluded.${c})`),
].join(', ')}`

const HOUR_OF_SCHEDULED = `scheduled_at - scheduled_at % ${HOUR_MS}`
/** Scheduling delay of a scheduled run, or NULL for manual runs / runs that never started. */
const DELAY = `CASE WHEN trigger = 'schedule' AND started_at IS NOT NULL THEN MAX(0, started_at - scheduled_at) END`

/**
 * Count the final outcome of a run that is still `running`. Must be batched
 * immediately before the UPDATE that moves the run out of `running`, so a run
 * is counted at most once even if a lost-run sweep or a duplicate gets there first.
 */
export function finalOutcomeStatement(
  db: D1Database,
  runId: string,
  outcome: 'success' | 'failed',
  durationMs: number,
): D1PreparedStatement {
  const buckets = new Array(BUCKET_COUNT).fill(0)
  buckets[bucketIndex(durationMs)] = 1
  return db
    .prepare(
      `INSERT INTO run_stats_hourly (${INSERT_COLS})
       SELECT task_id, ${HOUR_OF_SCHEDULED}, ?, ?, 0, 1, ?, ?, ${BUCKET_COLS.map(() => '?').join(', ')},
         (${DELAY}) IS NOT NULL, COALESCE(${DELAY}, 0), COALESCE(${DELAY}, 0)
       FROM runs WHERE id = ? AND status = 'running'
       ${ON_CONFLICT}`,
    )
    .bind(outcome === 'success' ? 1 : 0, outcome === 'failed' ? 1 : 0, durationMs, durationMs, ...buckets, runId)
}

export function skippedStatement(db: D1Database, taskId: string, scheduledAt: number): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO run_stats_hourly (task_id, hour, skipped) VALUES (?, ?, 1) ${ON_CONFLICT}`)
    .bind(taskId, floorHour(scheduledAt))
}

/**
 * Count runs matching `where` (bound with `params`) as failed, without a
 * duration. Batch before the UPDATE that closes them.
 */
export function lostRunsStatement(db: D1Database, where: string, params: unknown[]): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO run_stats_hourly (task_id, hour, failed, delay_count, delay_sum, delay_max)
       SELECT task_id, ${HOUR_OF_SCHEDULED} AS h, COUNT(*), COUNT(${DELAY}), COALESCE(SUM(${DELAY}), 0), COALESCE(MAX(${DELAY}), 0)
       FROM runs WHERE ${where}
       GROUP BY task_id, h
       ${ON_CONFLICT}`,
    )
    .bind(...params)
}

export function deleteTaskStatsStatement(db: D1Database, taskId: string): D1PreparedStatement {
  return db.prepare('DELETE FROM run_stats_hourly WHERE task_id = ?').bind(taskId)
}

export const STATS_PURGE_BATCH = 5000

export async function purgeOldStats(db: D1Database, cutoff: number): Promise<number> {
  const res = await db
    .prepare(
      `DELETE FROM run_stats_hourly WHERE (task_id, hour) IN
       (SELECT task_id, hour FROM run_stats_hourly WHERE hour < ? LIMIT ${STATS_PURGE_BATCH})`,
    )
    .bind(cutoff)
    .run()
  return res.meta.changes
}

type AggRow = Record<string, number>

const aggSelect = (prefix = '') =>
  [
    ...SUM_COLS.map((c) => `SUM(${prefix}${c}) AS ${c}`),
    ...MAX_COLS.map((c) => `MAX(${prefix}${c}) AS ${c}`),
  ].join(', ')

function rowToAgg(r: AggRow): Agg {
  const agg = emptyAgg()
  agg.success = r.success
  agg.failed = r.failed
  agg.skipped = r.skipped
  agg.durationCount = r.duration_count
  agg.durationSum = r.duration_sum
  agg.durationMax = r.duration_max
  agg.buckets = BUCKET_COLS.map((c) => r[c])
  agg.delayCount = r.delay_count
  agg.delaySum = r.delay_sum
  agg.delayMax = r.delay_max
  return agg
}

/** Aggregates per hour in [from, to], across all tasks or for one task. */
export async function statsByHour(
  db: D1Database,
  from: number,
  to: number,
  taskId?: string,
): Promise<{ hour: number; agg: Agg }[]> {
  const stmt = taskId
    ? db
        .prepare(
          `SELECT hour, ${aggSelect()} FROM run_stats_hourly WHERE task_id = ? AND hour >= ? AND hour <= ? GROUP BY hour`,
        )
        .bind(taskId, from, to)
    : db
        .prepare(`SELECT hour, ${aggSelect()} FROM run_stats_hourly WHERE hour >= ? AND hour <= ? GROUP BY hour`)
        .bind(from, to)
  const { results } = await stmt.all<AggRow>()
  return results.map((r) => ({ hour: r.hour, agg: rowToAgg(r) }))
}

/** Aggregates per existing task in [from, to]. */
export async function statsByTask(
  db: D1Database,
  from: number,
  to: number,
): Promise<{ taskId: string; name: string; agg: Agg }[]> {
  const { results } = await db
    .prepare(
      `SELECT s.task_id, t.name, ${aggSelect('s.')}
       FROM run_stats_hourly s JOIN tasks t ON t.id = s.task_id
       WHERE s.hour >= ? AND s.hour <= ? GROUP BY s.task_id`,
    )
    .bind(from, to)
    .all<AggRow & { task_id: string; name: string }>()
  return results.map((r) => ({ taskId: r.task_id, name: r.name, agg: rowToAgg(r) }))
}
