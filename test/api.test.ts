import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { app } from '../src/app'
import type { RunMessage } from '../src/domain/runs-repo'
import { insertSkippedRun } from '../src/domain/runs-repo'

const AUTH = { authorization: `Bearer ${env.API_TOKEN}` }

function call(path: string, init: RequestInit = {}, e: CloudflareBindings = env) {
  const headers = { ...AUTH, 'content-type': 'application/json', ...(init.headers as Record<string, string>) }
  return app.request(`http://yunji-task.test/api${path}`, { ...init, headers }, e)
}

const cronTask = (overrides: Record<string, unknown> = {}) => ({
  name: 'heartbeat',
  schedule: { type: 'cron', cron: '0 */5 * * * *', timezone: 'UTC' },
  executor: { type: 'http', config: { url: 'https://downstream.test/ping' } },
  ...overrides,
})

async function create(body: unknown = cronTask()) {
  const res = await call('/tasks', { method: 'POST', body: JSON.stringify(body) })
  expect(res.status).toBe(201)
  return ((await res.json()) as { task: any }).task
}

describe('auth', () => {
  it('rejects missing or wrong tokens', async () => {
    expect((await app.request('http://x/api/tasks', {}, env)).status).toBe(401)
    expect((await call('/tasks', { headers: { authorization: 'Bearer nope' } })).status).toBe(401)
    expect((await call('/tasks')).status).toBe(200)
  })

  it('fails closed when API_TOKEN is not configured', async () => {
    const e = Object.create(env, { API_TOKEN: { value: '' } })
    expect((await call('/tasks', {}, e)).status).toBe(503)
  })
})

describe('tasks API', () => {
  it('persists advanced conditions, validates rule paths and allows switching back to simple mode', async () => {
    const condition = { match: 'all', rules: [
      { type: 'status', operator: 'between', value: 200, valueTo: 299 },
      { type: 'json', path: 'data.code', operator: 'eq', value: 0 },
    ] }
    const input = cronTask({ schedule: { type: 'manual' }, executor: { type: 'http', config: { url: 'https://d.test', successCondition: condition } } })
    const task = await create(input)
    const read = await call(`/tasks/${task.id}`)
    expect((await read.json() as any).task.executor.config.successCondition).toEqual(condition)
    const bad = await call(`/tasks/${task.id}`, { method: 'PUT', body: JSON.stringify({
      ...input, executor: { type: 'http', config: { url: 'https://d.test', successCondition: { match: 'all', rules: [{ type: 'status', operator: 'between', value: 299, valueTo: 200 }] } } },
    }) })
    expect(bad.status).toBe(422)
    expect((await bad.json() as any).issues).toContainEqual(expect.objectContaining({ path: 'executor.config.successCondition.rules.0.valueTo' }))
    const updated = await call(`/tasks/${task.id}`, { method: 'PUT', body: JSON.stringify(cronTask({ schedule: { type: 'manual' } })) })
    expect(updated.status).toBe(200)
    expect((await updated.json() as any).task.executor.config.successCondition).toBeUndefined()
  })

  it('creates a task with defaults and arms its scheduler', async () => {
    const task = await create()
    expect(task).toMatchObject({
      name: 'heartbeat',
      enabled: true,
      version: 1,
      overlapPolicy: 'skip',
      retry: { count: 0, intervalSeconds: 10 },
      alert: { mode: 'inherit' },
      executor: { type: 'http', config: { method: 'GET', timeoutMs: 25_000, headers: {}, body: '' } },
    })
    expect(task.nextRunAt % 300_000).toBe(0)
    const status = await env.TASK_SCHEDULER.getByName(task.id).status()
    expect(status).toMatchObject({ version: 1, alarmAt: task.nextRunAt })
  })

  it('accepts ISO runAt for once tasks', async () => {
    const runAt = new Date(Date.now() + 3_600_000).toISOString()
    const task = await create(cronTask({ schedule: { type: 'once', runAt } }))
    expect(task.schedule.runAt).toBe(Date.parse(runAt))
    expect(task.nextRunAt).toBe(Date.parse(runAt))
  })

  it('returns field-level validation errors', async () => {
    const bad = await call('/tasks', {
      method: 'POST',
      body: JSON.stringify(cronTask({ schedule: { type: 'cron', cron: '*/5 * * * *' } })),
    })
    expect(bad.status).toBe(422)
    const body = (await bad.json()) as { issues: { path: string }[] }
    expect(body.issues.map((i) => i.path)).toContain('schedule.cron')

    const past = await call('/tasks', {
      method: 'POST',
      body: JSON.stringify(cronTask({ schedule: { type: 'once', runAt: Date.now() - 1000 } })),
    })
    expect(past.status).toBe(422)

    const tz = await call('/tasks', {
      method: 'POST',
      body: JSON.stringify(cronTask({ schedule: { type: 'cron', cron: '0 * * * * *', timezone: 'Mars/Base' } })),
    })
    expect(tz.status).toBe(422)

    const notJson = await call('/tasks', { method: 'POST', body: '{' })
    expect(notJson.status).toBe(422)
  })

  it('updates bump the version and resync the scheduler', async () => {
    const task = await create()
    const res = await call(`/tasks/${task.id}`, {
      method: 'PUT',
      body: JSON.stringify(cronTask({ schedule: { type: 'cron', cron: '0 0 * * * *', timezone: 'UTC' } })),
    })
    expect(res.status).toBe(200)
    const updated = ((await res.json()) as { task: any }).task
    expect(updated.version).toBe(2)
    expect(updated.nextRunAt % 3_600_000).toBe(0)
    expect(await env.TASK_SCHEDULER.getByName(task.id).status()).toMatchObject({
      version: 2,
      alarmAt: updated.nextRunAt,
    })
  })

  it('disable/enable toggles the alarm', async () => {
    const task = await create()
    const stub = env.TASK_SCHEDULER.getByName(task.id)
    const off = (await (await call(`/tasks/${task.id}/disable`, { method: 'POST' })).json()) as { task: any }
    expect(off.task).toMatchObject({ enabled: false, nextRunAt: null, version: 2 })
    expect((await stub.status()).alarmAt).toBeNull()
    await call(`/tasks/${task.id}/enable`, { method: 'POST' })
    expect((await stub.status()).alarmAt).not.toBeNull()
  })

  it('refuses to enable a once task whose time has passed', async () => {
    const task = await create(cronTask({ enabled: false, schedule: { type: 'once', runAt: Date.now() - 1000 } }))
    expect((await call(`/tasks/${task.id}/enable`, { method: 'POST' })).status).toBe(422)
  })

  it('delete removes the task and its scheduler state', async () => {
    const task = await create()
    expect((await call(`/tasks/${task.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await call(`/tasks/${task.id}`)).status).toBe(404)
    expect(await env.TASK_SCHEDULER.getByName(task.id).status()).toEqual({
      version: null,
      alarmAt: null,
      running: null,
    })
  })

  it('manual trigger enqueues a manual run', async () => {
    const task = await create()
    const sent: RunMessage[] = []
    const e = Object.create(env, { RUN_QUEUE: { value: { send: async (m: RunMessage) => void sent.push(m) } } })
    const res = await call(`/tasks/${task.id}/trigger`, { method: 'POST' }, e)
    expect(res.status).toBe(202)
    const { runId } = (await res.json()) as { runId: string }
    expect(sent).toEqual([expect.objectContaining({ runId, taskId: task.id, trigger: 'manual', attempt: 1 })])
    expect((await call('/tasks/nope/trigger', { method: 'POST' }, e)).status).toBe(404)
  })

  it('pages through runs newest first', async () => {
    const task = await create()
    for (let i = 1; i <= 3; i++) await insertSkippedRun(env.DB, { taskId: task.id, scheduledAt: i, reason: `r${i}` }, i)
    const page1 = (await (await call(`/tasks/${task.id}/runs?limit=2`)).json()) as any
    expect(page1.runs.map((r: any) => r.error)).toEqual(['r3', 'r2'])
    expect(page1.nextBefore).toBe(`2:${page1.runs[1].id}`)
    const page2 = (await (await call(`/tasks/${task.id}/runs?limit=2&before=${encodeURIComponent(page1.nextBefore)}`)).json()) as any
    expect(page2.runs.map((r: any) => r.error)).toEqual(['r1'])
    expect(page2.nextBefore).toBeNull()
    expect((await call(`/runs/${page2.runs[0].id}`)).status).toBe(200)
  })

  it('pages through timestamp ties without duplicates or omissions', async () => {
    const task = await create()
    const now = Date.now()
    for (const offset of [1, 0, 0, 0, -1]) {
      await insertSkippedRun(env.DB, { taskId: task.id, scheduledAt: now + offset, reason: 'tie' }, now + offset)
    }
    const ids: string[] = []
    let cursor: string | null = null
    do {
      const page = await (await call(`/tasks/${task.id}/runs?limit=2${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`)).json() as any
      ids.push(...page.runs.map((run: { id: string }) => run.id))
      cursor = page.nextBefore
    } while (cursor)
    expect(ids).toHaveLength(5)
    expect(new Set(ids).size).toBe(5)
    for (const invalid of ['123', `NaN:${ids[0]}`, `9007199254740992:${ids[0]}`, '123:not-an-id']) {
      expect((await call(`/tasks/${task.id}/runs?before=${encodeURIComponent(invalid)}`)).status).toBe(422)
    }
  })
})

describe('variables API', () => {
  it('stores values encrypted and never returns them', async () => {
    const put = await call('/variables/BOT_TOKEN', {
      method: 'PUT',
      body: JSON.stringify({ value: 'plain-secret-value', description: 'telegram' }),
    })
    expect(put.status).toBe(204)
    const listText = await (await call('/variables')).text()
    expect(listText).toContain('BOT_TOKEN')
    expect(listText).not.toContain('plain-secret-value')
    const row = await env.DB.prepare(`SELECT value_encrypted FROM variables WHERE name = 'BOT_TOKEN'`).first<{
      value_encrypted: string
    }>()
    expect(row?.value_encrypted).not.toContain('plain-secret-value')
    expect((await call('/variables/BOT_TOKEN', { method: 'DELETE' })).status).toBe(204)
    expect((await call('/variables/BOT_TOKEN', { method: 'DELETE' })).status).toBe(404)
  })

  it('rejects invalid names', async () => {
    const res = await call('/variables/bad-name', { method: 'PUT', body: JSON.stringify({ value: 'x' }) })
    expect(res.status).toBe(422)
  })
})

describe('settings API', () => {
  it('reads and writes the global alert target', async () => {
    const initial = await (await call('/settings/alert')).json() as { alert: { mode: string; url: string; bodyTemplate: string; senderTopic: string } }
    expect(initial.alert).toMatchObject({ mode: 'webhook', url: '', senderTopic: '' })
    expect(JSON.parse(initial.alert.bodyTemplate)).toMatchObject({ title: '云吉 Task: {{task.name}}', group: 'yunji-task' })
    const res = await call('/settings/alert', {
      method: 'PUT',
      body: JSON.stringify({ url: 'https://alerts.test/x', bodyTemplate: '{"t":"{{task.name}}"}' }),
    })
    expect(res.status).toBe(200)
    expect(await (await call('/settings/alert')).json()).toEqual({
      alert: { mode: 'webhook', url: 'https://alerts.test/x', bodyTemplate: '{"t":"{{task.name}}"}', senderTopic: '' },
    })
  })
})
