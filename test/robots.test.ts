import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { app } from '../src/app'

it.each([
  ['/', 302], ['/health', 200], ['/admin', 401], ['/missing', 404],
])('adds noindex to %s without changing its status', async (path, status) => {
  const response = await app.request(`https://example.com${path}`, {}, env)
  expect(response.status).toBe(status)
  expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
})
