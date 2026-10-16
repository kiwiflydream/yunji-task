import { timingSafeEqual } from 'hono/utils/buffer'

/** Parse `Authorization: Basic ...` into username/password (UTF-8). */
export function parseBasicAuth(header: string | undefined): { username: string; password: string } | null {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? '')
  if (!match) return null
  let decoded: string
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(match[1]), (ch) => ch.charCodeAt(0)))
  } catch {
    return null
  }
  const idx = decoded.indexOf(':')
  if (idx < 0) return null
  return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) }
}

/** Constant-time check of both fields; never short-circuits on the username. */
export async function checkBasicCredentials(
  header: string | undefined,
  username: string,
  password: string,
): Promise<string | null> {
  const creds = parseBasicAuth(header)
  if (!creds) return null
  const [userOk, passOk] = await Promise.all([
    timingSafeEqual(creds.username, username),
    timingSafeEqual(creds.password, password),
  ])
  return userOk && passOk ? creds.username : null
}
