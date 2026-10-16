import { rowToTask, type Task, type TaskInput, type TaskRow, type TaskSummary } from './task'
import { deleteTaskStatsStatement } from './stats-repo'

function columns(input: TaskInput) {
  const s = input.schedule
  return {
    name: input.name,
    description: input.description,
    enabled: input.enabled ? 1 : 0,
    schedule_type: s.type,
    cron: s.type === 'cron' ? s.cron : null,
    timezone: s.timezone,
    run_at: s.type === 'once' ? s.runAt : null,
    executor_type: input.executor.type,
    executor_config: JSON.stringify(input.executor.config),
    overlap_policy: input.overlapPolicy,
    retry_count: input.retry.count,
    retry_interval_seconds: input.retry.intervalSeconds,
    alert_config: JSON.stringify(input.alert),
    execution_mode: input.executionMode,
  }
}

export async function listTasks(db: D1Database): Promise<TaskSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT t.*,
        (SELECT r.status FROM runs r WHERE r.task_id = t.id ORDER BY r.created_at DESC LIMIT 1) AS last_status,
        (SELECT r.created_at FROM runs r WHERE r.task_id = t.id ORDER BY r.created_at DESC LIMIT 1) AS last_run_at
       FROM tasks t ORDER BY t.created_at DESC`,
    )
    .all<TaskRow & { last_status: string | null; last_run_at: number | null }>()
  return results.map((row) => ({ ...rowToTask(row), lastStatus: row.last_status, lastRunAt: row.last_run_at }))
}

export async function getTask(db: D1Database, id: string): Promise<Task | null> {
  const row = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first<TaskRow>()
  return row ? rowToTask(row) : null
}

export async function insertTask(db: D1Database, input: TaskInput, now: number): Promise<Task> {
  const id = crypto.randomUUID()
  const c = columns(input)
  const row = await db
    .prepare(
      `INSERT INTO tasks (id, name, description, enabled, schedule_type, cron, timezone, run_at,
        executor_type, executor_config, overlap_policy, retry_count, retry_interval_seconds, alert_config,
        execution_mode, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING *`,
    )
    .bind(
      id, c.name, c.description, c.enabled, c.schedule_type, c.cron, c.timezone, c.run_at,
      c.executor_type, c.executor_config, c.overlap_policy, c.retry_count, c.retry_interval_seconds, c.alert_config,
      c.execution_mode, now, now,
    )
    .first<TaskRow>()
  return rowToTask(row!)
}

export async function updateTask(db: D1Database, id: string, input: TaskInput, now: number): Promise<Task | null> {
  const c = columns(input)
  const row = await db
    .prepare(
      `UPDATE tasks SET name = ?, description = ?, enabled = ?, schedule_type = ?, cron = ?, timezone = ?, run_at = ?,
        executor_type = ?, executor_config = ?, overlap_policy = ?, retry_count = ?, retry_interval_seconds = ?,
        alert_config = ?, execution_mode = ?, version = version + 1, updated_at = ?
       WHERE id = ? RETURNING *`,
    )
    .bind(
      c.name, c.description, c.enabled, c.schedule_type, c.cron, c.timezone, c.run_at,
      c.executor_type, c.executor_config, c.overlap_policy, c.retry_count, c.retry_interval_seconds,
      c.alert_config, c.execution_mode, now, id,
    )
    .first<TaskRow>()
  return row ? rowToTask(row) : null
}

export async function setTaskEnabled(db: D1Database, id: string, enabled: boolean, now: number): Promise<Task | null> {
  const row = await db
    .prepare('UPDATE tasks SET enabled = ?, version = version + 1, updated_at = ? WHERE id = ? RETURNING *')
    .bind(enabled ? 1 : 0, now, id)
    .first<TaskRow>()
  return row ? rowToTask(row) : null
}

/** Disable a once task after it fired, only if nobody edited it since. */
export async function disableFiredOnceTask(db: D1Database, id: string, version: number, now: number): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE tasks SET enabled = 0, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND schedule_type = 'once'`,
    )
    .bind(now, id, version)
    .run()
  return res.meta.changes > 0
}

export async function deleteTask(db: D1Database, id: string): Promise<boolean> {
  const [res] = await db.batch([
    db.prepare('DELETE FROM tasks WHERE id = ?').bind(id),
    db.prepare('DELETE FROM runs WHERE task_id = ?').bind(id),
    deleteTaskStatsStatement(db, id),
  ])
  return res.meta.changes > 0
}

export async function listAllTasks(db: D1Database, onlyUnsynced = false): Promise<Task[]> {
  const { results } = await db.prepare(`SELECT * FROM tasks${onlyUnsynced ? ' WHERE scheduler_synced_version < version' : ''}`).all<TaskRow>()
  return results.map(rowToTask)
}

export async function markSchedulerSynced(db: D1Database, id: string, version: number): Promise<void> {
  await db.prepare(
    `UPDATE tasks SET scheduler_synced_version = ? WHERE id = ? AND version = ? AND scheduler_synced_version < version`,
  ).bind(version, id, version).run()
}

export async function markSchedulerUnsynced(db: D1Database, id: string, version: number): Promise<void> {
  await db.prepare(
    `UPDATE tasks SET scheduler_synced_version = 0 WHERE id = ? AND version = ? AND scheduler_synced_version >= version`,
  ).bind(id, version).run()
}

export async function listTaskIds(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare('SELECT id FROM tasks').all<{ id: string }>()
  return results.map((row) => row.id)
}
