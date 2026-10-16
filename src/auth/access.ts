import type { HonoJsonWebKey } from 'hono/utils/jwt/jws'
import { verifyWithJwks } from 'hono/utils/jwt/jwt'

const JWKS_TTL_MS = 10 * 60_000
/** Bad tokens trigger a refresh; rate-limit it so they cannot force a fetch per request. */
const JWKS_MIN_REFRESH_MS = 60_000
const jwksCache = new Map<string, { keys: HonoJsonWebKey[]; fetchedAt: number }>()

async function accessKeys(teamDomain: string, forceRefresh = false): Promise<HonoJsonWebKey[]> {
  const cached = jwksCache.get(teamDomain)
  const age = cached ? Date.now() - cached.fetchedAt : Infinity
  if (cached && age < (forceRefresh ? JWKS_MIN_REFRESH_MS : JWKS_TTL_MS)) return cached.keys
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`)
  if (!res.ok) throw new Error(`failed to fetch Access certs: HTTP ${res.status}`)
  const { keys } = (await res.json()) as { keys: HonoJsonWebKey[] }
  jwksCache.set(teamDomain, { keys, fetchedAt: Date.now() })
  return keys
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
