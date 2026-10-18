import { env } from 'cloudflare:workers'
import { sign } from 'hono/jwt'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { app } from '../src/app'
import { getTask } from '../src/domain/tasks-repo'
import { setRuntimeSettings } from './helpers'

afterEach(() => vi.restoreAllMocks())

const SHELL = '<!doctype html><div id="root"></div>'

/** Tests run without a Vite build, so stand in for the static-assets binding. */
const assetRequests: string[] = []
const fakeAssets = {
  fetch: async (input: RequestInfo | URL) => {
    assetRequests.push(new Request(input).url)
    return new Response(SHELL, { headers: { 'content-type': 'text/html' } })
  },
}

const withEnv = (vars: Record<string, unknown>) =>
  Object.create(
    env,
    Object.fromEntries(Object.entries({ ASSETS: fakeAssets, ...vars }).map(([k, value]) => [k, { value }])),
  ) as CloudflareBindings
const baseEnv = withEnv({})

const BASE = 'https://tasks.example.com'
const basic = (user: string, pass: string) =>
  'Basic ' + btoa(String.fromCharCode(...new TextEncoder().encode(`${user}:${pass}`)))
const ADMIN_AUTH = basic('admin', env.ADMIN_PASSWORD)

function get(path: string, e: CloudflareBindings = baseEnv, headers: Record<string, string> = { authorization: ADMIN_AUTH }) {
  return app.request(`${BASE}${path}`, { headers }, e)
}

function sendJson(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(
    `${BASE}${path}`,
    {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', authorization: ADMIN_AUTH, ...headers },
    },
    baseEnv,
  )
}

describe('basic auth (default mode)', () => {
  it('challenges requests without credentials', async () => {
    const res = await get('/admin', env, {})
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Basic realm="yunji-task", charset="UTF-8"')
  })

  it('accepts the configured credentials', async () => {
    const res = await get('/admin')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(SHELL)
    expect(await (await get('/admin/api/me')).json()).toEqual({
      user: 'admin',
      authMode: 'basic',
      retentionDays: 30,
      statsRetentionDays: 90,
      runtimeSettingsVersion: expect.any(Number),
      executionMode: 'queue',
      queueAvailable: true,
      senderAvailable: false,
    })
  })

  it('rejects a wrong password or username', async () => {
    expect((await get('/admin', baseEnv, { authorization: basic('admin', 'nope') })).status).toBe(401)
    expect((await get('/admin', baseEnv, { authorization: basic('root', env.ADMIN_PASSWORD) })).status).toBe(401)
    expect((await get('/admin', baseEnv, { authorization: 'Basic !!!' })).status).toBe(401)
    expect((await get('/admin', baseEnv, { authorization: `Bearer ${env.API_TOKEN}` })).status).toBe(401)
  })

  it('uses ADMIN_USERNAME and supports UTF-8 passwords containing colons', async () => {
    const e = withEnv({ ADMIN_USERNAME: 'ops', ADMIN_PASSWORD: 'pä:ss 密码' })
    expect((await get('/admin', e, { authorization: basic('ops', 'pä:ss 密码') })).status).toBe(200)
    expect((await get('/admin', e, { authorization: basic('admin', 'pä:ss 密码') })).status).toBe(401)
  })

  it('fails closed when ADMIN_PASSWORD is not set', async () => {
    const res = await get('/admin', withEnv({ ADMIN_PASSWORD: '' }), { authorization: basic('admin', '') })
    expect(res.status).toBe(503)
  })

  it('defaults to basic when ADMIN_AUTH_MODE is empty', async () => {
    const e = withEnv({ ADMIN_AUTH_MODE: '' })
    expect((await get('/admin', e)).status).toBe(200)
    expect((await get('/admin', e, {})).status).toBe(401)
  })

  it('fails closed on an unknown mode', async () => {
    expect((await get('/admin', withEnv({ ADMIN_AUTH_MODE: 'none' }))).status).toBe(503)
  })
})

describe('Cloudflare Access', () => {
  const TEAM = 'team.cloudflareaccess.com'
  const AUD = 'aud-tag-123'
  const accessEnv = withEnv({ ADMIN_AUTH_MODE: 'access', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD })

  // One key pair for the whole block: the middleware caches JWKS per team domain,
  // so a fresh key per test would make every token fail for the wrong reason.
  let pub: JsonWebKey
  let priv: JsonWebKey
  const kid = crypto.randomUUID()
  beforeAll(async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair
    pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
    priv = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey
  })

  async function setupKeys() {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      expect(String(input)).toBe(`https://${TEAM}/cdn-cgi/access/certs`)
      return Response.json({ keys: [{ ...pub, kid, alg: 'RS256', use: 'sig' }] })
    })
    const now = Math.floor(Date.now() / 1000)
    return (claims: Record<string, unknown> = {}) =>
      sign(
        { iss: `https://${TEAM}`, aud: [AUD], email: 'me@example.com', iat: now, exp: now + 600, ...claims },
        { ...priv, kid, alg: 'RS256' },
        'RS256',
      )
  }

  it('is locked (503) when Access mode is not configured', async () => {
    expect((await get('/admin', withEnv({ ADMIN_AUTH_MODE: 'access' }))).status).toBe(503)
  })

  it('does not accept basic credentials in access mode', async () => {
    await setupKeys()
    expect((await get('/admin', accessEnv)).status).toBe(403)
  })

  it('accepts a valid Access JWT from header or cookie', async () => {
    const token = await setupKeys().then((mint) => mint())
    const viaHeader = await app.request(
      'https://tasks.example.com/admin',
      { headers: { 'cf-access-jwt-assertion': token } },
      accessEnv,
    )
    expect(viaHeader.status).toBe(200)
    const me = await app.request(
      'https://tasks.example.com/admin/api/me',
      { headers: { 'cf-access-jwt-assertion': token } },
      accessEnv,
    )
    expect(await me.json()).toMatchObject({ user: 'me@example.com', authMode: 'access' })
    const viaCookie = await app.request(
      'https://tasks.example.com/admin',
      { headers: { cookie: `CF_Authorization=${token}` } },
      accessEnv,
    )
    expect(viaCookie.status).toBe(200)
  })

  it('rejects missing, wrong-audience, wrong-issuer and expired tokens', async () => {
    const mint = await setupKeys()
    const req = async (token?: string) =>
      (
        await app.request(
          'https://tasks.example.com/admin',
          { headers: token ? { 'cf-access-jwt-assertion': token } : {} },
          accessEnv,
        )
      ).status
    // Positive control: the same setup accepts a correct token.
    expect(await req(await mint())).toBe(200)
    expect(await req()).toBe(403)
    expect(await req(await mint({ aud: ['other'] }))).toBe(403)
    expect(await req(await mint({ iss: 'https://evil.cloudflareaccess.com' }))).toBe(403)
    expect(await req(await mint({ exp: Math.floor(Date.now() / 1000) - 10 }))).toBe(403)
  })
})

describe('admin SPA and API', () => {
  it('serves the SPA shell for client-side routes, uncached', async () => {
    assetRequests.length = 0
    const res = await get('/admin/tasks/some-id/edit')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(SHELL)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(assetRequests).toEqual([`${BASE}/`])
  })

  it('never serves the shell without auth', async () => {
    assetRequests.length = 0
    expect((await get('/admin/tasks/x', baseEnv, {})).status).toBe(401)
    expect(assetRequests).toEqual([])
  })

  it('redirects / to /admin', async () => {
    const res = await app.request(`${BASE}/`, {}, baseEnv)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/admin')
  })

  it('exposes the task API under /admin/api with admin auth', async () => {
    const created = await sendJson('POST', '/admin/api/tasks', {
      name: 'from spa',
      schedule: { type: 'cron', cron: '0 0 * * * *', timezone: 'UTC' },
      executor: { type: 'http', config: { url: 'https://downstream.test/' } },
    })
    expect(created.status).toBe(201)
    const { task } = (await created.json()) as { task: { id: string; nextRunAt: number } }
    expect((await getTask(env.DB, task.id))?.name).toBe('from spa')

    const scheduler = (await (await get(`/admin/api/tasks/${task.id}/scheduler`)).json()) as any
    expect(scheduler.scheduler).toMatchObject({ version: 1, alarmAt: task.nextRunAt })

    const invalid = await sendJson('POST', '/admin/api/tasks', { name: '' })
    expect(invalid.status).toBe(422)
    expect(((await invalid.json()) as any).issues.length).toBeGreaterThan(0)
  })

  it('returns JSON 404 for unknown admin API paths instead of the shell', async () => {
    const res = await get('/admin/api/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it('keeps the two auth schemes separate', async () => {
    expect((await get('/admin/api/tasks', baseEnv, { authorization: `Bearer ${env.API_TOKEN}` })).status).toBe(401)
    expect((await app.request(`${BASE}/api/tasks`, { headers: { authorization: ADMIN_AUTH } }, baseEnv)).status).toBe(401)
  })

  it('rejects cross-site form posts (CSRF)', async () => {
    const res = await app.request(
      `${BASE}/admin/api/tasks/x/trigger`,
      { method: 'POST', body: new URLSearchParams({}), headers: { origin: 'https://evil.example', authorization: ADMIN_AUTH } },
      baseEnv,
    )
    expect(res.status).toBe(403)
  })

  it('reports the latest saved runtime settings in /admin/api/me', async () => {
    await setRuntimeSettings({ executionMode: 'direct', retentionDays: 7, statsRetentionDays: 365 })
    const res = await get('/admin/api/me')
    expect(await res.json()).toMatchObject({ executionMode: 'direct', retentionDays: 7, statsRetentionDays: 365 })
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})
