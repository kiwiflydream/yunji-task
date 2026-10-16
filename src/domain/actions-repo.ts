import type { RunMessage } from './runs-repo'
import type { AlertTask, FailedRun } from '../executor/alert'
import type { ExecutionMode } from '../shared/types'

export type ActionPayload =
  | { kind: 'retry'; msg: RunMessage; mode: ExecutionMode; runAt: number }
  | { kind: 'alert'; task: AlertTask; run: FailedRun }

export interface RunAction {
  id: string
  taskId: string
  runId: string
  payload: ActionPayload
  dueAt: number
  attempts: number
}

interface ActionRow {
  id: string
  task_id: string
  run_id: string
  payload: string
  due_at: number
  attempts: number
}

const fromRow = (r: ActionRow): RunAction => ({
  id: r.id, taskId: r.task_id, runId: r.run_id,
  payload: JSON.parse(r.payload), dueAt: r.due_at, attempts: r.attempts,
})

export function insertActionStatement(db: D1Database, action: RunAction, attempt: number): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO run_actions (id, task_id, run_id, payload, due_at)
     SELECT ?, ?, ?, ?, ? FROM runs WHERE id = ? AND status = 'running' AND attempt = ?
     ON CONFLICT (id) DO NOTHING`,
  ).bind(action.id, action.taskId, action.runId, JSON.stringify(action.payload), action.dueAt, action.runId, attempt)
}

export async function actionsForRun(db: D1Database, runId: string): Promise<RunAction[]> {
  const { results } = await db.prepare('SELECT * FROM run_actions WHERE run_id = ? AND failed_at IS NULL')
    .bind(runId).all<ActionRow>()
  return results.map(fromRow)
}

export async function dueActions(db: D1Database, now: number, limit = 100): Promise<RunAction[]> {
  const { results } = await db.prepare(
    `SELECT * FROM run_actions WHERE failed_at IS NULL AND due_at <= ? AND lease_until <= ? ORDER BY due_at LIMIT ?`,
  ).bind(now, now, limit).all<ActionRow>()
  return results.map(fromRow)
}

export async function claimAction(db: D1Database, id: string, now: number): Promise<RunAction | null> {
  const row = await db.prepare(
    `UPDATE run_actions SET lease_until = ?, attempts = attempts + 1
     WHERE id = ? AND failed_at IS NULL AND due_at <= ? AND lease_until <= ? RETURNING *`,
  ).bind(now + 45_000, id, now, now).first<ActionRow>()
  return row ? fromRow(row) : null
}

export async function completeAction(db: D1Database, action: RunAction, now: number): Promise<void> {
  const statements: D1PreparedStatement[] = []
  if (action.payload.kind === 'retry') {
    statements.push(db.prepare(
      `UPDATE runs SET updated_at = ? WHERE id = ? AND status = 'retrying'
       AND EXISTS (SELECT 1 FROM run_actions WHERE id = ? AND attempts = ?)`,
    ).bind(now, action.runId, action.id, action.attempts))
  }
  statements.push(db.prepare('DELETE FROM run_actions WHERE id = ? AND attempts = ?').bind(action.id, action.attempts))
  await db.batch(statements)
}

export async function failAction(db: D1Database, action: RunAction, error: string, now: number): Promise<number | null> {
  const terminal = action.payload.kind === 'alert' && action.attempts >= 3
  const dueAt = action.payload.kind === 'retry' ? now : now + 30_000 * action.attempts
  await db.prepare(
    `UPDATE run_actions SET lease_until = 0, due_at = ?, last_error = ?, failed_at = ? WHERE id = ? AND attempts = ?`,
  ).bind(dueAt, error, terminal ? now : null, action.id, action.attempts).run()
  return terminal ? null : dueAt
}
