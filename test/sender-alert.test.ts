import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../src/app'
import { putAlertSettings } from '../src/domain/settings'
import type { AlertSettings } from '../src/shared/types'
import { resolveAlertTarget, sendFailureAlert, senderAlertMessage, type FailedRun } from '../src/executor/alert'
import { processRun } from '../src/executor/consumer'
import { deliverAction } from '../src/executor/actions'
import type { RunAction } from '../src/domain/actions-repo'
import type { SenderService } from '../src/executor/sender'
import { claimRun, recordAttempt, type RunMessage } from '../src/domain/runs-repo'
import { taskInputSchema } from '../src/domain/task'
import { emptyTaskForm, formToPayload, mapIssues, taskToForm } from '../web/src/lib/task-form'
import { createTaskRow } from './helpers'

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM settings WHERE key = 'alert'").run()
})

afterEach(() => vi.restoreAllMocks())

type SendCall = { input: Parameters<SenderService['send']>[0]; options: Parameters<SenderService['send']>[1] }

function envWithSender(fail = false) {
  const calls: SendCall[] = []
  const sender: SenderService = {
    send: async (input, options) => {
      calls.push({ input, options })
      if (fail) throw new Error('Yunji Sender unavailable')
      return { messageId: 'msg-1' }
    },
  }
  return { env: Object.create(env, { SENDER: { value: sender } }) as CloudflareBindings, calls }
}

const run: FailedRun = {
  id: 'run-1',
  attempt: 2,
  trigger: 'schedule',
  httpStatus: 502,
  error: 'HTTP 502 `bad` gateway',
  finishedAt: Date.UTC(2026, 9, 17, 1, 2, 3),
}

const settings = (s: { mode: AlertSettings['mode']; url?: string; senderChannelGroup?: string }) =>
  putAlertSettings(env.DB, { mode: s.mode, url: s.url ?? '', bodyTemplate: '', senderChannelGroup: s.senderChannelGroup ?? '' }, Date.now())

describe('resolveAlertTarget', () => {
  const task = (alert: any) => ({ id: 't', name: 'n', alert })

  it('uses the selected global mode when both targets are saved', async () => {
    await settings({ mode: 'webhook', url: 'https://alerts.test/hook', senderChannelGroup: 'ops-alert' })
    expect(await resolveAlertTarget(env.DB, task({ mode: 'inherit' }))).toMatchObject({
      kind: 'webhook',
      url: 'https://alerts.test/hook',
    })
    await settings({ mode: 'sender', url: 'https://alerts.test/hook', senderChannelGroup: 'ops-alert' })
    expect(await resolveAlertTarget(env.DB, task({ mode: 'inherit' }))).toEqual({ kind: 'sender', channelGroup: 'ops-alert' })
    await settings({ mode: 'off', url: 'https://alerts.test/hook', senderChannelGroup: 'ops-alert' })
    expect(await resolveAlertTarget(env.DB, task({ mode: 'inherit' }))).toBeNull()
  })

  it('keeps a channel-group-only global target without the binding, so the failure is visible', async () => {
    await settings({ mode: 'sender', senderChannelGroup: 'ops-alert', url: 'https://alerts.test/hook' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(sendFailureAlert(env, task({ mode: 'inherit' }), run)).rejects.toThrow(/SENDER service binding/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('honors task overrides', async () => {
    await settings({ mode: 'off', senderChannelGroup: 'ops-alert' })
    expect(await resolveAlertTarget(env.DB, task({ mode: 'sender', channelGroup: 'db' }))).toEqual({ kind: 'sender', channelGroup: 'db' })
    expect(await resolveAlertTarget(env.DB, task({ mode: 'custom', url: 'https://x.test', bodyTemplate: '' }))).toMatchObject({
      kind: 'webhook',
    })
    expect(await resolveAlertTarget(env.DB, task({ mode: 'off' }))).toBeNull()
  })
})

describe('sendFailureAlert via Yunji Sender', () => {
  it('sends a Markdown alert with a per-run idempotency key', async () => {
    const { env: e, calls } = envWithSender()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await sendFailureAlert(e, { id: 'task-1', name: '夜间同步', alert: { mode: 'sender', channelGroup: 'ops-alert' } }, run)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    expect(calls[0].options).toEqual({ idempotencyKey: 'yunji-task:alert:run-1' })
    expect(calls[0].input).toMatchObject({ channelGroup: 'ops-alert', title: '任务失败：夜间同步', format: 'markdown', level: 'error', tags: ['yunji-task'] })
    expect(calls[0].input).not.toHaveProperty('topic')
    expect(calls[0].input.body).toContain("- 错误：`HTTP 502 'bad' gateway`")
    expect(calls[0].input.body).toContain('- HTTP 状态：502')
    expect(calls[0].input.body).toContain('- 第 2 次尝试 · 定时触发')
    expect(calls[0].input.body).toContain('2026-10-17T01:02:03.000Z')
  })

  it('propagates Yunji Sender errors so the outbox retries', async () => {
    const { env: e } = envWithSender(true)
    await expect(sendFailureAlert(e, { id: 't', name: 'n', alert: { mode: 'sender', channelGroup: 'ops' } }, run)).rejects.toThrow(
      'Yunji Sender unavailable',
    )
  })

  it('fails clearly when the binding is missing', async () => {
    await expect(sendFailureAlert(env, { id: 't', name: 'n', alert: { mode: 'sender', channelGroup: 'ops' } }, run)).rejects.toThrow(
      /SENDER service binding/,
    )
  })

  it('omits the HTTP line for network errors', () => {
    const msg = senderAlertMessage({ id: 't', name: 'n', alert: { mode: 'off' } }, { ...run, httpStatus: null, error: null })
    expect(msg.body).not.toContain('HTTP 状态')
    expect(msg.body).toContain('未知错误')
  })
})

describe('failed runs', () => {
  it('persist the resolved Yunji Sender target in the alert action', async () => {
    await settings({ mode: 'sender', url: 'https://alerts.test/hook', senderChannelGroup: 'ops-alert' })
    const task = await createTaskRow()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }))
    const sent: RunMessage[] = []
    const { env: withSender } = envWithSender()
    const e = Object.create(withSender, { RUN_QUEUE: { value: { send: async (m: RunMessage) => void sent.push(m) } } })
    const msg: RunMessage = { runId: crypto.randomUUID(), taskId: task.id, trigger: 'manual', scheduledAt: Date.now(), attempt: 1 }
    await processRun(msg, e)
    const row = await env.DB.prepare('SELECT payload FROM run_actions WHERE run_id = ?').bind(msg.runId).first<{ payload: string }>()
    expect(JSON.parse(row!.payload).task.alert).toEqual({ mode: 'sender', channelGroup: 'ops-alert' })
  })
})

describe('validation and UI mapping', () => {
  const AUTH = { authorization: `Bearer ${env.API_TOKEN}`, 'content-type': 'application/json' }

  it('validates channel groups in settings and task alerts', async () => {
    const bad = await app.request('http://x/api/settings/alert', { method: 'PUT', headers: AUTH, body: JSON.stringify({ mode: 'sender', senderChannelGroup: 'Ops Alert' }) }, env)
    expect(bad.status).toBe(422)
    const missing = await app.request('http://x/api/settings/alert', { method: 'PUT', headers: AUTH, body: JSON.stringify({ mode: 'sender' }) }, env)
    expect(missing.status).toBe(422)
    const ok = await app.request('http://x/api/settings/alert', { method: 'PUT', headers: AUTH, body: JSON.stringify({ mode: 'sender', senderChannelGroup: 'ops-alert' }) }, env)
    expect(await ok.json()).toMatchObject({ alert: { mode: 'sender', url: '', senderChannelGroup: 'ops-alert' } })
    expect(taskInputSchema.safeParse({ ...baseTask, alert: { mode: 'sender', channelGroup: '' } }).success).toBe(false)
  })

  it('sends the default global webhook body as Bark JSON with escaped values', async () => {
    await app.request('http://x/api/settings/alert', {
      method: 'PUT', headers: AUTH, body: JSON.stringify({ mode: 'webhook', url: 'https://api.day.app/test-key' }),
    }, env)
    let request: { url: string; method: string; contentType: string | null; body: unknown } | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const req = new Request(input, init)
      request = { url: req.url, method: req.method, contentType: req.headers.get('content-type'), body: await req.json() }
      return new Response('{"code":200}', { headers: { 'content-type': 'application/json' } })
    })
    await sendFailureAlert(env, { id: 't', name: '夜间"同步"', alert: { mode: 'inherit' } }, { ...run, error: 'bad "response"\nnext line' })
    expect(request).toEqual({
      url: 'https://api.day.app/test-key', method: 'POST', contentType: 'application/json',
      body: { title: '云吉 Task: 夜间"同步"', body: 'bad "response"\nnext line\nHTTP 502 | #2 | 2026-10-17T01:02:03.000Z', group: 'yunji-task' },
    })
  })

  it('round-trips the sender mode through the task form', async () => {
    const out = formToPayload({ ...emptyTaskForm, name: 'n', url: 'https://d.test', alertMode: 'sender', alertChannelGroup: 'ops-alert' })
    if (!('payload' in out)) throw new Error('unexpected issues')
    expect(out.payload.alert).toEqual({ mode: 'sender', channelGroup: 'ops-alert' })
    const task = await createTaskRow({ alert: { mode: 'sender', channelGroup: 'ops-alert' } })
    expect(taskToForm(task)).toMatchObject({ alertMode: 'sender', alertChannelGroup: 'ops-alert' })
    expect(mapIssues([{ path: 'alert.channelGroup', message: 'bad' }]).fields).toEqual({ alertChannelGroup: 'bad' })
  })
})

describe('legacy sender configuration compatibility', () => {
  const AUTH = { authorization: `Bearer ${env.API_TOKEN}`, 'content-type': 'application/json' }

  it('reads old global settings with a canonical channel group and unchanged version', async () => {
    await env.DB.prepare('INSERT INTO settings (key, value, version, updated_at) VALUES (?, ?, ?, ?)')
      .bind('alert', JSON.stringify({ mode: 'sender', senderTopic: 'legacy-ops', url: '', bodyTemplate: '' }), 7, Date.now()).run()
    const response = await app.request('/api/settings/alert', { headers: AUTH }, env)
    expect(response.headers.get('ETag')).toBe('"7"')
    const body = await response.json() as { alert: unknown; version: number }
    expect(body).toMatchObject({ alert: { mode: 'sender', senderChannelGroup: 'legacy-ops' }, version: 7 })
    expect(body.alert).not.toHaveProperty('senderTopic')
    const { env: withSender, calls } = envWithSender()
    await sendFailureAlert(withSender, { id: 't', name: 'n', alert: { mode: 'inherit' } }, run)
    expect(calls[0].input.channelGroup).toBe('legacy-ops')
  })

  it('normalizes persisted task alerts before returning them to the editor', async () => {
    const task = await createTaskRow()
    await env.DB.prepare('UPDATE tasks SET alert_config = ? WHERE id = ?')
      .bind(JSON.stringify({ mode: 'sender', topic: 'legacy-task' }), task.id).run()
    const response = await app.request(`/api/tasks/${task.id}`, { headers: AUTH }, env)
    const { task: loaded } = await response.json() as { task: typeof task }
    expect(loaded.alert).toEqual({ mode: 'sender', channelGroup: 'legacy-task' })
    expect(loaded.version).toBe(task.version)
    expect(taskToForm(loaded).alertChannelGroup).toBe('legacy-task')
  })

  it('delivers an old persisted outbox snapshot using the new RPC field and original idempotency key', async () => {
    const task = await createTaskRow()
    const now = Date.now()
    const runId = crypto.randomUUID()
    const msg: RunMessage = { runId, taskId: task.id, trigger: 'manual', scheduledAt: now, attempt: 1 }
    await claimRun(env.DB, msg, now)
    const action = {
      id: `${runId}:alert`, taskId: task.id, runId, dueAt: now, attempts: 0,
      payload: { kind: 'alert', task: { id: task.id, name: task.name, alert: { mode: 'sender', topic: 'legacy-pending' } }, run: { ...run, id: runId, attempt: 1 } },
    } as unknown as RunAction
    await recordAttempt(env.DB, runId, 'failed', { httpStatus: 502, responseBody: '', error: 'HTTP 502', durationMs: 1 }, now, action)
    const { env: withSender, calls } = envWithSender()
    await deliverAction(action.id, withSender)
    expect(calls).toHaveLength(1)
    expect(calls[0].input.channelGroup).toBe('legacy-pending')
    expect(calls[0].input).not.toHaveProperty('topic')
    expect(calls[0].options?.idempotencyKey).toBe(`yunji-task:alert:${runId}`)
    expect(await env.DB.prepare('SELECT id FROM run_actions WHERE id = ?').bind(action.id).first()).toBeNull()
  })

  it('accepts legacy request aliases but gives explicit new fields precedence', async () => {
    const parsed = taskInputSchema.parse({ ...baseTask, alert: { mode: 'sender', topic: 'old' } })
    expect(parsed.alert).toEqual({ mode: 'sender', channelGroup: 'old' })
    expect(taskInputSchema.parse({ ...baseTask, alert: { mode: 'sender', topic: 'old', channelGroup: 'new' } }).alert)
      .toEqual({ mode: 'sender', channelGroup: 'new' })
    expect(taskInputSchema.safeParse({ ...baseTask, alert: { mode: 'sender', topic: 'old', channelGroup: '' } }).success).toBe(false)
    const legacy = await app.request('/api/settings/alert', { method: 'PUT', headers: AUTH,
      body: JSON.stringify({ mode: 'sender', senderTopic: 'old' }) }, env)
    expect(await legacy.json()).toMatchObject({ alert: { senderChannelGroup: 'old' } })
    const current = await app.request('/api/settings/alert', { method: 'PUT', headers: AUTH,
      body: JSON.stringify({ mode: 'sender', senderTopic: 'old', senderChannelGroup: 'new' }) }, env)
    expect(await current.json()).toMatchObject({ alert: { senderChannelGroup: 'new' } })
    const invalid = await app.request('/api/settings/alert', { method: 'PUT', headers: AUTH,
      body: JSON.stringify({ mode: 'sender', senderTopic: 'old', senderChannelGroup: '' }) }, env)
    expect(invalid.status).toBe(422)
  })
})

const baseTask = {
  name: 'n',
  schedule: { type: 'manual' },
  executor: { type: 'http', config: { url: 'https://d.test' } },
}
