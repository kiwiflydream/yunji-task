import { BUCKET_COUNT, bucketIndex, emptyAgg, MINUTE_MS, HOUR_MS, type Agg, type StatsWindow } from './stats'

const BUCKET_COLS = Array.from({ length: BUCKET_COUNT }, (_, i) => `dur_b${i}`)
const SUM_COLS = ['success', 'failed', 'skipped', 'duration_count', 'duration_sum', ...BUCKET_COLS, 'delay_count', 'delay_sum']
const MAX_COLS = ['duration_max', 'delay_max']
const INSERT_COLS = [
  'task_id',
  'bucket',
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

const ON_CONFLICT = `ON CONFLICT (task_id, bucket) DO UPDATE SET ${[
  ...SUM_COLS.map((c) => `${c} = ${c} + excluded.${c}`),
  ...MAX_COLS.map((c) => `${c} = MAX(${c}, excluded.${c})`),
].join(', ')}`

const BUCKET_OF_SCHEDULED = `scheduled_at - scheduled_at % ${MINUTE_MS}`
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
      `INSERT INTO run_stats (${INSERT_COLS})
       SELECT task_id, ${BUCKET_OF_SCHEDULED}, ?, ?, 0, 1, ?, ?, ${BUCKET_COLS.map(() => '?').join(', ')},
         (${DELAY}) IS NOT NULL, COALESCE(${DELAY}, 0), COALESCE(${DELAY}, 0)
       FROM runs WHERE id = ? AND status = 'running'
       ${ON_CONFLICT}`,
    )
    .bind(outcome === 'success' ? 1 : 0, outcome === 'failed' ? 1 : 0, durationMs, durationMs, ...buckets, runId)
}

/** Batch after inserting this skipped run; a deleted task produces no run and no stats. */
export function skippedStatement(db: D1Database, runId: string): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO run_stats (task_id, bucket, skipped)
      SELECT task_id, ${BUCKET_OF_SCHEDULED}, 1 FROM runs WHERE id = ? AND status = 'skipped' ${ON_CONFLICT}`)
    .bind(runId)
}

/**
 * Count runs matching `where` (bound with `params`) as failed, without a
 * duration. Batch before the UPDATE that closes them.
 */
export function lostRunsStatement(db: D1Database, where: string, params: unknown[]): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO run_stats (task_id, bucket, failed, delay_count, delay_sum, delay_max)
       SELECT task_id, ${BUCKET_OF_SCHEDULED} AS h, COUNT(*), COUNT(${DELAY}), COALESCE(SUM(${DELAY}), 0), COALESCE(MAX(${DELAY}), 0)
       FROM runs WHERE ${where}
       GROUP BY task_id, h
       ${ON_CONFLICT}`,
    )
    .bind(...params)
}

export function deleteTaskStatsStatement(db: D1Database, taskId: string): D1PreparedStatement {
  return db.prepare('DELETE FROM run_stats WHERE task_id = ?').bind(taskId)
}

export const STATS_PURGE_BATCH = 5000

export async function purgeOldStats(db: D1Database, cutoff: number): Promise<number> {
  const res = await db
    .prepare(
      `DELETE FROM run_stats WHERE (task_id, bucket) IN
       (SELECT task_id, bucket FROM run_stats WHERE bucket < ? LIMIT ${STATS_PURGE_BATCH})`,
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

/** Merge minutes in D1 so a request returns at most one row per chart point. */
export async function statsForWindow(
  db: D1Database,
  window: StatsWindow,
  taskId?: string,
): Promise<{ start: number; agg: Agg }[]> {
  const taskFilter = taskId === undefined ? '' : 'AND s.task_id = ?'
  const taskParams = taskId === undefined ? [] : [taskId]
  const stmt = window.granularity === 'hour'
    ? db.prepare(
        `SELECT s.bucket - s.bucket % ${HOUR_MS} AS start, ${aggSelect('s.')}
         FROM run_stats s WHERE s.bucket >= ? AND s.bucket <= ? ${taskFilter} GROUP BY start`,
      ).bind(window.from, window.to, ...taskParams)
    : db.prepare(
        `WITH starts(start) AS (VALUES ${window.buckets.map(() => '(?)').join(', ')}),
         periods AS (SELECT start, LEAD(start, 1, ?) OVER (ORDER BY start) AS end FROM starts)
         SELECT p.start, ${aggSelect('s.')} FROM periods p JOIN run_stats s
           ON s.bucket >= p.start AND s.bucket < p.end ${taskFilter}
         GROUP BY p.start`,
      ).bind(...window.buckets, window.to + 1, ...taskParams)
  const { results } = await stmt.all<AggRow>()
  return results.map((r) => ({ start: r.start, agg: rowToAgg(r) }))
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
       FROM run_stats s JOIN tasks t ON t.id = s.task_id
       WHERE s.bucket >= ? AND s.bucket <= ? GROUP BY s.task_id`,
    )
    .bind(from, to)
    .all<AggRow & { task_id: string; name: string }>()
  return results.map((r) => ({ taskId: r.task_id, name: r.name, agg: rowToAgg(r) }))
}
