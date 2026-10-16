import { getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { verifyAccessJwt } from './access'
import { checkBasicCredentials } from './basic'

export type AdminVariables = { adminUser: string }

export const DEFAULT_ADMIN_USERNAME = 'admin'
const REALM = 'cf-task'

/**
 * Protect the admin UI. ADMIN_AUTH_MODE selects the scheme:
 * - `basic` (default): ADMIN_USERNAME (default "admin") + ADMIN_PASSWORD secret.
 * - `access`: Cloudflare Access JWT, needs ACCESS_TEAM_DOMAIN + ACCESS_AUD.
 * Missing configuration or an unknown mode fails closed with 503.
 */
export const requireAdmin = createMiddleware<{ Bindings: CloudflareBindings; Variables: AdminVariables }>(
  async (c, next) => {
    const env = c.env
    const mode = env.ADMIN_AUTH_MODE?.trim() || 'basic'

    if (mode === 'basic') {
      const password = env.ADMIN_PASSWORD
      if (!password) return c.text('Admin is locked: set the ADMIN_PASSWORD secret.', 503)
      const username = env.ADMIN_USERNAME?.trim() || DEFAULT_ADMIN_USERNAME
      const user = await checkBasicCredentials(c.req.header('authorization'), username, password)
      if (!user) {
        return c.text('Unauthorized', 401, { 'www-authenticate': `Basic realm="${REALM}", charset="UTF-8"` })
      }
      c.set('adminUser', user)
      return next()
    }

    if (mode === 'access') {
      const team = env.ACCESS_TEAM_DOMAIN?.trim()
      const aud = env.ACCESS_AUD?.trim()
      if (!team || !aud) return c.text('Admin is locked: set ACCESS_TEAM_DOMAIN and ACCESS_AUD.', 503)
      const token = c.req.header('cf-access-jwt-assertion') ?? getCookie(c, 'CF_Authorization')
      if (!token) return c.text('Forbidden: missing Cloudflare Access token', 403)
      const email = await verifyAccessJwt(token, team, aud)
      if (!email) return c.text('Forbidden: invalid Cloudflare Access token', 403)
      c.set('adminUser', email)
      return next()
    }

    return c.text(`Admin is locked: unknown ADMIN_AUTH_MODE "${mode}" (use "basic" or "access").`, 503)
  },
)
