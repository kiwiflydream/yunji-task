import { z } from 'zod'

export const HANDOFF_MAX_ATTEMPTS = 10
export const RECOVERY_MAX_AGE_MS = 24 * 60 * 60_000
export { RUN_HEADER } from '../shared/types'
export const safetySettingsSchema = z.object({
  paused: z.boolean(),
  taskDailyLimit: z.number().int().min(1).max(1_000_000),
  globalDailyLimit: z.number().int().min(1).max(10_000_000),
})
export class SafetyError extends Error {
  constructor(message: string, readonly reason: 'paused' | 'budget' = 'budget') { super(message) }
}
const DEFAULT_SAFETY = { paused: false, taskDailyLimit: 100_000, globalDailyLimit: 1_000_000 }

export async function getSafetySettings(db: D1Database) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'safety'").first<{ value: string }>()
  return safetySettingsSchema.parse(row ? JSON.parse(row.value) : DEFAULT_SAFETY)
}

export async function putSafetySettings(db: D1Database, raw: unknown) {
  const settings = safetySettingsSchema.parse(raw)
  await db.batch([db.prepare("INSERT INTO settings(key,value,updated_at) VALUES('safety',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
    .bind(JSON.stringify(settings), Date.now()),
    // Reconcile paused schedulers on the next five-minute maintenance pass.
    db.prepare('UPDATE tasks SET scheduler_synced_version=0 WHERE enabled=1 AND ?=0').bind(settings.paused ? 1 : 0),
  ])
  return settings
}

/** Separate budgets bound both new dispatches and actual attempts (including retries).
 * One D1 batch admits atomically across all DOs and consumers. Failed sends
 * consume budget too; never refund an ambiguous network handoff.
 */
export async function admit(db: D1Database, taskId: string, kind: 'dispatch' | 'attempt', now = Date.now()): Promise<void> {
  const settings = await getSafetySettings(db)
  if (settings.paused) throw new SafetyError('execution paused by safety switch', 'paused')
  const day = Math.floor(now / 86_400_000)
  const [res] = await db.batch([
    db.prepare(`INSERT INTO execution_budget(day,kind,task_id,count)
      SELECT ?,?,?,1 WHERE COALESCE((SELECT count FROM execution_budget_totals WHERE day=? AND kind=?),0) < ?
      ON CONFLICT(day,kind,task_id) DO UPDATE SET count=count+1 WHERE count < ?`)
      .bind(day, kind, taskId, day, kind, settings.globalDailyLimit, settings.taskDailyLimit),
    // changes() refers to the immediately preceding task UPSERT in this transaction.
    // A rejected admission changes neither counter; any SQL failure rolls both back.
    db.prepare(`INSERT INTO execution_budget_totals(day,kind,count)
      SELECT ?,?,1 WHERE changes() = 1
      ON CONFLICT(day,kind) DO UPDATE SET count=count+1`).bind(day, kind),
  ])
  if (res.meta.changes === 0) throw new SafetyError('daily execution budget exhausted; resumes after UTC midnight')
}
