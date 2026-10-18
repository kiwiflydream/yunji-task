import { withDeadline } from '../lib/deadline'
import type { HonoJsonWebKey } from 'hono/utils/jwt/jws'
import { verifyWithJwks } from 'hono/utils/jwt/jwt'

const JWKS_TTL_MS = 10 * 60_000
/** Bad tokens trigger a refresh; rate-limit it so they cannot force a fetch per request. */
const JWKS_MIN_REFRESH_MS = 60_000
const jwksCache = new Map<string, { keys?: HonoJsonWebKey[]; fetchedAt: number; attemptedAt: number; pending?: Promise<HonoJsonWebKey[]> }>()
const JWKS_TIMEOUT_MS = 5_000

async function accessKeys(teamDomain: string, forceRefresh = false): Promise<HonoJsonWebKey[]> {
  let entry = jwksCache.get(teamDomain)
  const now = Date.now()
  if (entry?.pending) return entry.pending
  if (entry?.keys && now - entry.fetchedAt < (forceRefresh ? JWKS_MIN_REFRESH_MS : JWKS_TTL_MS)) return entry.keys
  if (entry && now - entry.attemptedAt < JWKS_MIN_REFRESH_MS) throw new Error('Access cert refresh cooling down')
  if (!entry) {
    entry = { fetchedAt: 0, attemptedAt: now }
    // Domains come from deployment configuration; still keep isolate memory bounded.
    if (jwksCache.size >= 8) jwksCache.delete(jwksCache.keys().next().value!)
    jwksCache.set(teamDomain, entry)
  }
  entry.attemptedAt = now
  const state = entry
  state.pending = withDeadline((async () => {
    const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) })
    if (!res.ok) { await res.body?.cancel(); throw new Error(`failed to fetch Access certs: HTTP ${res.status}`) }
    const { keys } = await res.json() as { keys: HonoJsonWebKey[] }
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > 20) throw new Error('Invalid Access certs')
    return keys
  })(), JWKS_TIMEOUT_MS)
  try {
    const keys = await state.pending
    state.keys = keys
    state.fetchedAt = Date.now()
    return keys
  } finally { state.pending = undefined }
}

/**
 * Verify a Cloudflare Access JWT (from the `cf-access-jwt-assertion` header or
 * the `CF_Authorization` cookie). Returns the user's email, or null if invalid.
 */
export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  aud: string,
): Promise<string | null> {
  const verify = async (forceRefresh: boolean) =>
    verifyWithJwks(token, {
      keys: await accessKeys(teamDomain, forceRefresh),
      allowedAlgorithms: ['RS256'],
      verification: { iss: `https://${teamDomain}`, aud },
    })
  let payload
  try {
    payload = await verify(false)
  } catch {
    try {
      // Keys may have rotated since we cached them.
      payload = await verify(true)
    } catch {
      return null
    }
  }
  return typeof payload.email === 'string' ? payload.email : 'unknown'
}
