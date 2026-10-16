import { createMiddleware } from 'hono/factory'
import { timingSafeEqual } from 'hono/utils/buffer'

/** Bearer auth against the API_TOKEN secret. Fails closed when the secret is unset. */
export const requireApiToken = createMiddleware<{ Bindings: CloudflareBindings }>(async (c, next) => {
  const expected = c.env.API_TOKEN
  if (!expected) return c.json({ error: 'api_disabled', message: 'API_TOKEN is not configured' }, 503)
  const header = c.req.header('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match || !(await timingSafeEqual(match[1].trim(), expected))) {
    return c.json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' })
  }
  await next()
})
