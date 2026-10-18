import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { app } from '../src/app'

const headers = { authorization: `Bearer ${env.API_TOKEN}`, 'content-type': 'application/json' }
const call = (path: string, method = 'GET', body?: unknown, version?: number) => app.request(`https://task.test/api${path}`, {
  method,
  headers: { ...headers, ...(version === undefined ? {} : { 'if-match': `"${version}"` }) },
  body: body === undefined ? undefined : JSON.stringify(body),
}, env)
const input = { name: 'original', schedule: { type: 'manual' }, executor: { type: 'http', config: { url: 'https://old.test/' } } }

describe('configuration compare-and-set', () => {
  it('rejects a stale task form without re-enabling or replacing the current URL', async () => {
    const created = await call('/tasks', 'POST', input)
    const { task } = await created.json() as { task: { id: string; version: number } }
    const path = `/tasks/${task.id}`
    expect((await call(path, 'PUT', { ...input, enabled: false, executor: { type: 'http', config: { url: 'https://new.test/' } } }, task.version)).status).toBe(200)
    expect((await call(path, 'PUT', { ...input, description: 'description only' }, task.version)).status).toBe(409)
    expect(await (await call(path)).json()).toMatchObject({ task: { enabled: false, version: 2, executor: { config: { url: 'https://new.test/' } } } })
    expect((await call(path, 'PUT', { ...input, name: 'fresh edit' }, 2)).status).toBe(200)
  })

  it('allows only one task writer using the same version', async () => {
    const { task } = await (await call('/tasks', 'POST', input)).json() as { task: { id: string; version: number } }
    const responses = await Promise.all(['first', 'second'].map(name => call(`/tasks/${task.id}`, 'PUT', { ...input, name }, task.version)))
    expect(responses.map(r => r.status).sort()).toEqual([200, 409])
  })

  it('rejects a stale runtime save without shortening the saved retention', async () => {
    const initial = await (await call('/settings/runtime')).json() as { version: number }
    const first = await call('/settings/runtime', 'PUT', { executionMode: 'worker', retentionDays: 30, statsRetentionDays: 90 }, initial.version)
    const state = await first.json() as { version: number }
    expect(state.version).toEqual(expect.any(Number))
    expect(first.headers.get('etag')).toBe(`"${state.version}"`)
    expect((await call('/settings/runtime', 'PUT', { executionMode: 'worker', retentionDays: 365, statsRetentionDays: 90 }, state.version)).status).toBe(200)
    expect((await call('/settings/runtime', 'PUT', { executionMode: 'direct', retentionDays: 30, statsRetentionDays: 90 }, state.version)).status).toBe(409)
    const latest = await call('/settings/runtime')
    expect(latest.headers.get('etag')).toBe(`"${state.version + 1}"`)
    expect(await latest.json()).toMatchObject({ settings: { retentionDays: 365 }, version: state.version + 1 })
  })

  it('guards both initially absent and existing alert settings, even within one millisecond', async () => {
    const initial = await (await call('/settings/alert')).json() as { version: number }
    expect(initial.version).toBe(0)
    const original = { mode: 'webhook', url: 'https://original.test', bodyTemplate: '', senderChannelGroup: '' }
    const responses = await Promise.all(['a', 'b'].map(name => call('/settings/alert', 'PUT', { ...original, url: `https://${name}.test` }, 0)))
    expect(responses.map(r => r.status).sort()).toEqual([200, 409])
    const current = await (await call('/settings/alert')).json() as { version: number }
    expect(current.version).toBe(1)
    expect((await call('/settings/alert', 'PUT', original, 1)).status).toBe(200)
    expect((await call('/settings/alert', 'PUT', original, 1)).status).toBe(409)
  })

  it('rejects malformed If-Match instead of silently removing the guard', async () => {
    const response = await app.request('https://task.test/api/settings/runtime', {
      method: 'PUT', headers: { ...headers, 'if-match': 'garbage' },
      body: JSON.stringify({ executionMode: 'worker', retentionDays: 30, statsRetentionDays: 90 }),
    }, env)
    expect(response.status).toBe(422)
  })
})

describe('variable creation', () => {
  it('refuses a duplicate create and preserves the original encrypted value and description', async () => {
    const original = { value: 'fake-original-credential', description: 'original owner' }
    expect((await call('/variables/EXISTING', 'POST', original)).status).toBe(204)
    const before = await env.DB.prepare('SELECT value_encrypted, description FROM variables WHERE name = ?').bind('EXISTING').first()
    expect((await call('/variables/EXISTING', 'POST', { value: 'fake-replacement', description: '' })).status).toBe(409)
    expect(await env.DB.prepare('SELECT value_encrypted, description FROM variables WHERE name = ?').bind('EXISTING').first()).toEqual(before)
    expect((await call('/variables/EXISTING', 'PUT', { value: 'fake-explicit-update', description: 'updated' })).status).toBe(204)
    expect(await env.DB.prepare('SELECT description FROM variables WHERE name = ?').bind('EXISTING').first()).toEqual({ description: 'updated' })
  })

  it('creates a variable atomically when two clients use the same name', async () => {
    const responses = await Promise.all(['first', 'second'].map(value => call('/variables/SAME_NAME', 'POST', { value })))
    expect(responses.map(r => r.status).sort()).toEqual([204, 409])
  })
})

it.each(['task', 'runtime', 'alert'])('requires If-Match for %s updates without changing state', async (surface) => {
  const { task } = await (await call('/tasks', 'POST', input)).json() as { task: { id: string } }
  const path = surface === 'task' ? `/tasks/${task.id}` : `/settings/${surface}`
  const payload = surface === 'task' ? { ...input, name: 'must not replace' }
    : surface === 'runtime' ? { executionMode: 'direct', retentionDays: 5, statsRetentionDays: 10 }
      : { mode: 'off', url: '', bodyTemplate: '', senderChannelGroup: '' }
  const before = await call(path)
  const original = await before.json()
  expect((await call(path, 'PUT', payload)).status).toBe(428)
  expect(await (await call(path)).json()).toEqual(original)
  const version = Number(before.headers.get('etag')!.replaceAll('"', ''))
  expect((await call(path, 'PUT', payload, version)).status).toBe(200)
})
