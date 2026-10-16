import type { Run, RunStatus, RunTrigger } from '../shared/types'
import { finalOutcomeStatement, lostRunsStatement, skippedStatement } from './stats-repo'

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
export const DEFAULT_RETENTION_DAYS = 30
export const DEFAULT_STATS_RETENTION_DAYS = 90
const MAX_RETENTION_DAYS = 3650

/**
 * Parse a retention-days variable. Empty means the default; an invalid value
 * (e.g. 0, "abc") also falls back to the default rather than purging aggressively.
 */
function parseRetentionDays(name: string, raw: string | undefined, fallback: number): number {
  const value = raw?.trim() ?? ''
  if (value === '') return fallback
  const n = Number(value)
  if (Number.isInteger(n) && n >= 1 && n <= MAX_RETENTION_DAYS) return n
  console.warn(`invalid ${name} "${value}", using ${fallback}`)
  return fallback
}

/** RUN_RETENTION_DAYS: how long individual runs (logs) are kept. */
export function retentionDays(raw: string | undefined): number {
  return parseRetentionDays('RUN_RETENTION_DAYS', raw, DEFAULT_RETENTION_DAYS)
}

/** STATS_RETENTION_DAYS: how long hourly statistics are kept. */
export function statsRetentionDays(raw: string | undefined): number {
  return parseRetentionDays('STATS_RETENTION_DAYS', raw, DEFAULT_STATS_RETENTION_DAYS)
}

export const DAY_MS = 24 * 60 * 60_000
export const PURGE_BATCH = 5000

export async function insertSkippedRun(
  db: D1Database,
  run: { taskId: string; scheduledAt: number; reason: string },
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO runs (id, task_id, trigger, status, attempt, scheduled_at, finished_at, error, created_at, updated_at)
         VALUES (?, ?, 'schedule', 'skipped', 0, ?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), run.taskId, run.scheduledAt, now, run.reason, now, now),
    skippedStatement(db, run.taskId, run.scheduledAt),
  ])
}

/**
 * Claim an attempt of a run. Returns false for duplicate queue deliveries,
 * which must be acked without executing.
 */
export async function claimRun(db: D1Database, msg: RunMessage, now: number): Promise<boolean> {
  const res =
    msg.attempt === 1
      ? await db
          .prepare(
            `INSERT INTO runs (id, task_id, trigger, status, attempt, scheduled_at, started_at, created_at, updated_at)
             VALUES (?, ?, ?, 'running', 1, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
          )
          .bind(msg.runId, msg.taskId, msg.trigger, msg.scheduledAt, now, now, now)
          .run()
      : await db
          .prepare(
            `UPDATE runs SET status = 'running', attempt = ?, updated_at = ?
             WHERE id = ? AND status = 'retrying' AND attempt = ?`,
          )
          .bind(msg.attempt, now, msg.runId, msg.attempt - 1)
          .run()
  return res.meta.changes > 0
}

/**
 * Record the result of the attempt currently `running`. Final outcomes are
 * counted into the hourly stats in the same transaction. Returns false when
 * the run had already been closed (e.g. marked lost), in which case nothing changes.
 */
export async function recordAttempt(
  db: D1Database,
  runId: string,
  status: 'success' | 'failed' | 'retrying',
  result: { httpStatus: number | null; responseBody: string | null; error: string | null; durationMs: number },
  now: number,
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
  if (status === 'retrying') return (await update.run()).meta.changes > 0
  const [, res] = await db.batch([finalOutcomeStatement(db, runId, status, result.durationMs), update])
  return res.meta.changes > 0
}

export async function getRun(db: D1Database, id: string): Promise<Run | null> {
  const row = await db.prepare('SELECT * FROM runs WHERE id = ?').bind(id).first<RunRow>()
  return row ? rowToRun(row) : null
}

/** Newest first; `before` is a `createdAt` cursor from the previous page. */
export async function listRuns(
  db: D1Database,
  taskId: string,
  opts: { limit: number; before?: number },
): Promise<Run[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM runs WHERE task_id = ? AND created_at < ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(taskId, opts.before ?? Number.MAX_SAFE_INTEGER, opts.limit)
    .all<RunRow>()
  return results.map(rowToRun)
}

const LOST_WHERE = `(status = 'running' AND updated_at < ?) OR (status = 'retrying' AND updated_at < ?)`

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

export async function purgeOldRuns(db: D1Database, now: number, days: number): Promise<number> {
  const res = await db
    .prepare(`DELETE FROM runs WHERE id IN (SELECT id FROM runs WHERE created_at < ? LIMIT ${PURGE_BATCH})`)
    .bind(now - days * DAY_MS)
    .run()
  return res.meta.changes
}
