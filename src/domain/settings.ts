import { z } from 'zod'
import { BARK_ALERT_TEMPLATE, DEFAULT_RUNTIME_SETTINGS, type RuntimeSettings } from '../shared/types'
import { SENDER_CHANNEL_GROUP_RE } from './task'

export const runtimeSettingsSchema = z.object({
  executionMode: z.enum(['worker', 'queue', 'direct']),
  retentionDays: z.number().int().min(1).max(3650),
  statsRetentionDays: z.number().int().min(1).max(3650),
})

/** Read at each configuration boundary so API requests and existing DOs see saved changes. */
export async function getRuntimeSettings(db: D1Database): Promise<RuntimeSettings> {
  return (await getRuntimeSettingsState(db)).settings
}

export async function getRuntimeSettingsState(db: D1Database): Promise<{ settings: RuntimeSettings; version: number }> {
  const row = await db.prepare(`SELECT value, version FROM settings WHERE key = 'runtime'`).first<{ value: string; version: number }>()
  return { settings: row ? runtimeSettingsSchema.parse(JSON.parse(row.value)) : { ...DEFAULT_RUNTIME_SETTINGS }, version: row?.version ?? 0 }
}

/** A zero revision means the setting has not been saved yet. Null means a stale writer. */
async function writeSetting(db: D1Database, key: string, value: unknown, now: number, expectedVersion: number): Promise<number | null> {
  const encoded = JSON.stringify(value)
  const statement = expectedVersion === 0
    ? db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT (key) DO NOTHING RETURNING version`).bind(key, encoded, now)
    : db.prepare(`UPDATE settings SET value = ?, updated_at = ?, version = version + 1
          WHERE key = ? AND version = ? RETURNING version`).bind(encoded, now, key, expectedVersion)
  return (await statement.first<{ version: number }>())?.version ?? null
}

export async function putRuntimeSettings(db: D1Database, settings: RuntimeSettings, now: number, expectedVersion: number): Promise<number | null> {
  return writeSetting(db, 'runtime', settings, now, expectedVersion)
}

export const alertSettingsSchema = z.strictObject({
  mode: z.enum(['webhook', 'sender', 'off']).default('webhook'),
  url: z.string().trim().max(2048).default(''),
  bodyTemplate: z.string().max(8000).default(BARK_ALERT_TEMPLATE),
  senderChannelGroup: z.string().trim().default(''),
}).superRefine((settings, ctx) => {
  if (settings.mode === 'sender' && !SENDER_CHANNEL_GROUP_RE.test(settings.senderChannelGroup)) {
    ctx.addIssue({ code: 'custom', path: ['senderChannelGroup'], message: '请填写渠道组标识，只能包含小写字母、数字、点、下划线和连字符，最长 64 个字符' })
  }
})

export type AlertSettings = z.output<typeof alertSettingsSchema>

export async function getAlertSettings(db: D1Database): Promise<AlertSettings> {
  return (await getAlertSettingsState(db)).alert
}

export async function getAlertSettingsState(db: D1Database): Promise<{ alert: AlertSettings; version: number }> {
  const row = await db.prepare(`SELECT value, version FROM settings WHERE key = 'alert'`).first<{ value: string; version: number }>()
  return { alert: alertSettingsSchema.parse(row ? JSON.parse(row.value) : {}), version: row?.version ?? 0 }
}

export async function putAlertSettings(db: D1Database, settings: AlertSettings, now: number, expectedVersion: number): Promise<number | null> {
  return writeSetting(db, 'alert', settings, now, expectedVersion)
}
