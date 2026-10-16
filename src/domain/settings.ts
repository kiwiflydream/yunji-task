import { z } from 'zod'

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
