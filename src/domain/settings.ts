import { z } from 'zod'
import { DEFAULT_RUNTIME_SETTINGS, type RuntimeSettings } from '../shared/types'

export const runtimeSettingsSchema = z.object({
  executionMode: z.enum(['worker', 'queue', 'direct']),
  retentionDays: z.number().int().min(1).max(3650),
  statsRetentionDays: z.number().int().min(1).max(3650),
})

/** Read at each configuration boundary so API requests and existing DOs see saved changes. */
export async function getRuntimeSettings(db: D1Database): Promise<RuntimeSettings> {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = 'runtime'`).first<{ value: string }>()
  return row ? runtimeSettingsSchema.parse(JSON.parse(row.value)) : { ...DEFAULT_RUNTIME_SETTINGS }
}

export async function putRuntimeSettings(db: D1Database, settings: RuntimeSettings, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('runtime', ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(JSON.stringify(settings), now)
    .run()
}

export const alertSettingsSchema = z.object({
  url: z.string().trim().max(2048).default(''),
  bodyTemplate: z.string().max(8000).default(''),
})

export type AlertSettings = z.output<typeof alertSettingsSchema>

export async function getAlertSettings(db: D1Database): Promise<AlertSettings> {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = 'alert'`).first<{ value: string }>()
  return alertSettingsSchema.parse(row ? JSON.parse(row.value) : {})
}

export async function putAlertSettings(db: D1Database, settings: AlertSettings, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('alert', ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(JSON.stringify(settings), now)
    .run()
}
