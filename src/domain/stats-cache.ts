import { withDeadline } from '../lib/deadline'
import { SafetyError } from './safety'

export const STATS_CACHE_MS = 60_000
export const STATS_REBUILDS_PER_MINUTE = 20

/** Shared across isolates: one lease per key, plus a global cache-miss budget.
 * Arbitrary task/timezone combinations cannot bypass the rebuild budget.
 */
export async function cachedStats<T>(db: D1Database, key: string, build: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const read = () => db.prepare('SELECT value,expires_at FROM stats_cache WHERE key=?').bind(key)
    .first<{ value: string | null; expires_at: number }>()
  const cached = await read()
  if (cached?.value && cached.expires_at > now) return JSON.parse(cached.value) as T
  const owner = crypto.randomUUID()
  const [, lease] = await db.batch([
    db.prepare(`INSERT INTO resource_budgets(name,window,count)
      SELECT 'stats-rebuild',?,1 WHERE NOT EXISTS (
        SELECT 1 FROM stats_cache WHERE key=? AND (expires_at>? OR lease_until>?))
      ON CONFLICT(name) DO UPDATE SET window=excluded.window,
        count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END
      WHERE window<excluded.window OR (window=excluded.window AND count<?)`)
      .bind(Math.floor(now / 60000), key, now, now, STATS_REBUILDS_PER_MINUTE),
    db.prepare(`INSERT INTO stats_cache(key,value,expires_at,lease_until,owner)
      SELECT ?,NULL,0,?,? WHERE changes()=1
      ON CONFLICT(key) DO UPDATE SET lease_until=excluded.lease_until,owner=excluded.owner`)
      .bind(key, now + 30_000, owner),
  ])
  if (!lease.meta.changes) {
    const fresh = await read()
    if (fresh?.value && fresh.expires_at > Date.now()) return JSON.parse(fresh.value) as T
    throw new SafetyError('statistics are refreshing or query budget exhausted; retry in one minute')
  }
  try {
    const value = await withDeadline(build(), 20_000)
    await db.prepare('UPDATE stats_cache SET value=?,expires_at=?,lease_until=0 WHERE key=? AND owner=?')
      .bind(JSON.stringify(value), Date.now() + STATS_CACHE_MS, key, owner).run()
    return value
  } catch (err) {
    // Failed refreshes consume budget too and cannot spin immediately on this key.
    await db.prepare('UPDATE stats_cache SET lease_until=? WHERE key=? AND owner=?')
      .bind(Date.now() + 15_000, key, owner).run()
    throw err
  }
}
