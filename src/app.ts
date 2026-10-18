import { Hono } from 'hono'
import { admin } from './routes/admin'
import { api } from './routes/api'

export const app = new Hono<{ Bindings: CloudflareBindings }>()

app.use('*', async (c, next) => {
  await next()
  c.header('X-Robots-Tag', 'noindex, nofollow')
})

app.get('/', (c) => c.redirect('/admin'))
app.get('/health', (c) => c.json({ ok: true }))
app.route('/api', api)
app.route('/admin', admin)
app.notFound((c) => c.json({ error: 'not_found' }, 404))
