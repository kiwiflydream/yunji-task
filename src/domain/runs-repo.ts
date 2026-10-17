import type { ExecutionMode, Run, RunStatus, RunTrigger } from '../shared/types'
import { finalOutcomeStatement, lostRunsStatement, skippedStatement } from './stats-repo'
import { insertActionStatement, type RunAction } from './actions-repo'

export type { Run, RunStatus, RunTrigger }

export interface RunMessage {
  runId: string
  taskId: string
  trigger: RunTrigger
  scheduledAt: number
  attempt: number
}

interface RunRow {
  id: string
  task_id: string
  trigger: RunTrigger
  status: RunStatus
  attempt: number
  scheduled_at: number
  execution_mode: ExecutionMode | null
  effective_timeout_ms: number | null
  started_at: number | null
  finished_at: number | null
  duration_ms: number | null
  http_status: number | null
  response_body: string | null
  error: string | null
  created_at: number
  updated_at: number
}

function rowToRun(r: RunRow): Run {
  return {
    id: r.id,
    taskId: r.task_id,
    trigger: r.trigger,
    status: r.status,
    attempt: r.attempt,
    executionMode: r.execution_mode,
    effectiveTimeoutMs: r.effective_timeout_ms,
    scheduledAt: r.scheduled_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.duration_ms,
    httpStatus: r.http_status,
    responseBody: r.response_body,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export const RUNNING_STALE_MS = 15 * 60_000
export const RETRYING_STALE_MS = 75 * 60_000
export const DAY_MS = 24 * 60 * 60_000
export const PURGE_BATCH = 1000

/**
 * Runs are only inserted while their task exists (checked atomically), so
 * deleting a task's runs together with the task leaves no orphans, and
 * retention can purge task by task.
 */
const TASK_EXISTS = 'WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ?)'

export async function insertSkippedRun(
  db: D1Database,
  run: { taskId: string; scheduledAt: number; reason: string },
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO runs (id, task_id, trigger, status, attempt, scheduled_at, finished_at, error, created_at, updated_at)
         SELECT ?, ?, 'schedule', 'skipped', 0, ?, ?, ?, ?, ? ${TASK_EXISTS}`,
      )
      .bind(crypto.randomUUID(), run.taskId, run.scheduledAt, now, run.reason, now, now, run.taskId),
    skippedStatement(db, run.taskId, run.scheduledAt),
  ])
}

/**
 * Claim an attempt of a run. Returns false for duplicate queue deliveries and
 * for tasks deleted meanwhile; both must be acked without executing.
 */
export async function claimRun(
  db: D1Database, msg: RunMessage, now: number,
  details?: { executionMode: ExecutionMode; effectiveTimeoutMs: number },
): Promise<boolean> {
  const res =
    msg.attempt === 1
      ? await db
          .prepare(
            `INSERT INTO runs (id, task_id, trigger, status, attempt, scheduled_at, started_at, created_at, updated_at,
              execution_mode, effective_timeout_ms)
             SELECT ?, ?, ?, 'running', 1, ?, ?, ?, ?, ?, ? ${TASK_EXISTS} ON CONFLICT (id) DO NOTHING`,
          )
          .bind(msg.runId, msg.taskId, msg.trigger, msg.scheduledAt, now, now, now,
            details?.executionMode ?? null, details?.effectiveTimeoutMs ?? null, msg.taskId)
          .run()
      : await db
          .prepare(
            `UPDATE runs SET status = 'running', attempt = ?, updated_at = ?, execution_mode = ?, effective_timeout_ms = ?
             WHERE id = ? AND status = 'retrying' AND attempt = ?`,
          )
          .bind(msg.attempt, now, details?.executionMode ?? null, details?.effectiveTimeoutMs ?? null, msg.runId, msg.attempt - 1)
          .run()
  return res.meta.changes > 0
}

/**
 * Record the result of the attempt currently `running`. Final outcomes are
 * counted into the statistics in the same transaction. Returns false when
 * the run had already been closed (e.g. marked lost), in which case nothing changes.
 */
export async function recordAttempt(
  db: D1Database,
  runId: string,
  status: 'success' | 'failed' | 'retrying',
  result: { httpStatus: number | null; responseBody: string | null; error: string | null; durationMs: number },
  now: number,
  action?: RunAction,
): Promise<boolean> {
  const update = db
    .prepare(
      `UPDATE runs SET status = ?, http_status = ?, response_body = ?, error = ?, duration_ms = ?,
        finished_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .bind(
      status,
      result.httpStatus,
      result.responseBody,
      result.error,
      result.durationMs,
      status === 'retrying' ? null : now,
      now,
      runId,
    )
  if (status === 'retrying' && !action) return (await update.run()).meta.changes > 0
  const statements = action ? [insertActionStatement(db, action, action.payload.kind === 'retry' ? action.payload.msg.attempt - 1 : action.payload.run.attempt)] : []
  if (status !== 'retrying') statements.push(finalOutcomeStatement(db, runId, status, result.durationMs))
  statements.push(update)
  const results = await db.batch(statements)
  const res = results[results.length - 1]
  return res.meta.changes > 0
}

export async function getRun(db: D1Database, id: string): Promise<Run | null> {
  const row = await db.prepare('SELECT * FROM runs WHERE id = ?').bind(id).first<RunRow>()
  return row ? rowToRun(row) : null
}

export interface RunCursor {
  createdAt: number
  id: string
}

/** The run ID breaks timestamp ties, keeping every row reachable across pages. */
export async function listRuns(
  db: D1Database,
  taskId: string,
  opts: { limit: number; before?: RunCursor },
): Promise<Run[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM runs WHERE task_id = ?${opts.before ? ' AND (created_at, id) < (?, ?)' : ''}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .bind(...(opts.before ? [taskId, opts.before.createdAt, opts.before.id, opts.limit] : [taskId, opts.limit]))
    .all<RunRow>()
  return results.map(rowToRun)
}

/**
 * Stale in-flight runs: running for RUNNING_STALE_MS or retrying for
 * RETRYING_STALE_MS (the longer one) without an update. The first term must
 * match idx_runs_inflight's WHERE clause verbatim for SQLite to use that
 * partial index instead of scanning every run.
 */
export const LOST_WHERE = `status IN ('running', 'retrying') AND updated_at < ? AND (status = 'running' OR updated_at < ?)
  AND NOT EXISTS (SELECT 1 FROM run_actions WHERE run_id = runs.id AND failed_at IS NULL)`

/** Runs whose consumer died mid-flight never report back; close them out (counted as failed). */
export async function markLostRuns(db: D1Database, now: number): Promise<number> {
  const params = [now - RUNNING_STALE_MS, now - RETRYING_STALE_MS]
  const [, res] = await db.batch([
    lostRunsStatement(db, LOST_WHERE, params),
    db
      .prepare(
        `UPDATE runs SET status = 'failed', finished_at = ?, updated_at = ?,
          error = COALESCE(error || ' | ', '') || 'lost: no result reported (consumer crashed or message dropped)'
         WHERE ${LOST_WHERE}`,
      )
      .bind(now, now, ...params),
  ])
  return res.meta.changes
}

export const PURGE_RUNS_SQL = `DELETE FROM runs WHERE id IN
  (SELECT id FROM runs WHERE task_id = ? AND created_at < ?
   AND NOT EXISTS (SELECT 1 FROM run_actions WHERE run_id = runs.id AND failed_at IS NULL) LIMIT ${PURGE_BATCH})`

/** Delete up to PURGE_BATCH runs per task created before `cutoff`; returns the count per task. */
export async function purgeOldRuns(db: D1Database, taskIds: string[], cutoff: number): Promise<number[]> {
  if (taskIds.length === 0) return []
  const stmt = db.prepare(PURGE_RUNS_SQL)
  const results = await db.batch(taskIds.map((id) => stmt.bind(id, cutoff)))
  return results.map((r) => r.meta.changes)
}
