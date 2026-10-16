import { decryptString, encryptString } from '../lib/crypto'

import type { VariableInfo } from '../shared/types'

export type { VariableInfo }

export async function listVariables(db: D1Database): Promise<VariableInfo[]> {
  const { results } = await db
    .prepare('SELECT name, description, created_at, updated_at FROM variables ORDER BY name')
    .all<{ name: string; description: string; created_at: number; updated_at: number }>()
  return results.map((r) => ({
    name: r.name,
    description: r.description,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
}

export async function upsertVariable(
  db: D1Database,
  key: string,
  v: { name: string; value: string; description: string },
  now: number,
): Promise<void> {
  const encrypted = await encryptString(key, v.value, v.name)
  await db
    .prepare(
      `INSERT INTO variables (name, value_encrypted, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET value_encrypted = excluded.value_encrypted,
         description = excluded.description, updated_at = excluded.updated_at`,
    )
    .bind(v.name, encrypted, v.description, now, now)
    .run()
}

export async function deleteVariable(db: D1Database, name: string): Promise<boolean> {
  const res = await db.prepare('DELETE FROM variables WHERE name = ?').bind(name).run()
  return res.meta.changes > 0
}

/** Decrypt the named variables. Names that do not exist are simply absent from the result. */
export async function resolveVariables(db: D1Database, key: string, names: string[]): Promise<Record<string, string>> {
  if (names.length === 0) return {}
  const { results } = await db
    .prepare(`SELECT name, value_encrypted FROM variables WHERE name IN (${names.map(() => '?').join(', ')})`)
    .bind(...names)
    .all<{ name: string; value_encrypted: string }>()
  const out: Record<string, string> = {}
  for (const r of results) out[r.name] = await decryptString(key, r.value_encrypted, r.name)
  return out
}
