import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { secureHeaders } from 'hono/secure-headers'
import { requireAdmin, type AdminVariables } from '../auth/admin'
import { getRuntimeSettingsState } from '../domain/settings'
import { hasRunQueue } from '../executor/mode'
import { hasSender } from '../executor/sender'
import type { AdminMe } from '../shared/types'
import { apiRoutes } from './api'

type AdminEnv = { Bindings: CloudflareBindings; Variables: AdminVariables }

/**
 * /admin: the Kumo SPA shell plus its JSON API, all behind admin auth.
 * Built JS/CSS under /assets is served directly by Workers static assets.
 */
export const admin = new Hono<AdminEnv>()

admin.use('*', requireAdmin)
admin.use('*', csrf())

admin.get('/api/me', async (c) => {
  const { settings, version } = await getRuntimeSettingsState(c.env.DB)
  c.header('cache-control', 'no-store')
  return c.json<AdminMe>({
    ...settings,
    runtimeSettingsVersion: version,
    user: c.get('adminUser'),
    authMode: c.env.ADMIN_AUTH_MODE?.trim() === 'access' ? 'access' : 'basic',
    queueAvailable: hasRunQueue(c.env),
    senderAvailable: hasSender(c.env),
  })
})
admin.route('/api', apiRoutes)
admin.all('/api/*', (c) => c.json({ error: 'not_found' }, 404))

// Any other /admin path is a client-side route: serve the SPA shell.
admin.get('*', secureHeaders(), async (c) => {
  const shell = await c.env.ASSETS.fetch(new URL('/', c.req.url))
  const res = new Response(shell.body, shell)
  res.headers.set('cache-control', 'no-store')
  return res
})
