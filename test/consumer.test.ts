import { createExecutionContext, createMessageBatch, getQueueResult, runDurableObjectAlarm } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRun, type RunMessage } from '../src/domain/runs-repo'
import { putAlertSettings } from '../src/domain/settings'
import { upsertVariable } from '../src/domain/variables'
import { handleRunBatch, processRun } from '../src/executor/consumer'
import worker from '../src/index'
import { captureQueue, createTaskRow, toSnapshot } from './helpers'

beforeEach(async () => {
  // D1 is isolated per file, not per test; global alert settings would leak.
  await env.DB.prepare("DELETE FROM settings WHERE key = 'alert'").run()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function envWithQueue() {
  const sent: { body: RunMessage; options?: QueueSendOptions }[] = []
  const fake = Object.create(env, {
    RUN_QUEUE: { value: { send: async (body: RunMessage, options?: QueueSendOptions) => void sent.push({ body, options }) } },
  }) as CloudflareBindings
  return { env: fake, sent }
}

function mockFetch(handler: (req: Request) => Response | Promise<Response>) {
  const calls: Pick<Request, 'url' | 'method' | 'headers' | 'text'>[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init)
    const body = await req.clone().text()
    calls.push({ url: req.url, method: req.method, headers: req.headers, text: async () => body })
    return handler(req)
  })
  return calls
}

const message = (taskId: string, overrides: Partial<RunMessage> = {}): RunMessage => ({
  runId: crypto.randomUUID(),
  taskId,
  trigger: 'manual',
  scheduledAt: Date.now(),
  attempt: 1,
  ...overrides,
})

describe('processRun', () => {
  it('renders an accepted __proto__ variable and redacts its echoed value', async () => {
    const secret = 'prototype-variable-value'
    await upsertVariable(env.DB, env.ENCRYPTION_KEY, { name: '__proto__', value: secret, description: '' }, Date.now())
    const task = await createTaskRow({
      schedule: { type: 'manual' }, alert: { mode: 'off' },
      executor: { type: 'http', config: { url: 'https://downstream.test', method: 'POST', body: '{{__proto__}}' } },
    })
    const calls = mockFetch(() => Response.json({ echo: secret }))
    const msg = message(task.id)
    await processRun(msg, envWithQueue().env)
    expect(await calls[0].text()).toBe(secret)
    expect(JSON.parse((await getRun(env.DB, msg.runId))!.responseBody!)).toEqual({ echo: '***' })
  })

  it('never persists a JSON-escaped variable echoed by the downstream', async () => {
    const secret = 'private-line-1\nprivate-"line-2"\\end'
    await upsertVariable(env.DB, env.ENCRYPTION_KEY, { name: 'MULTILINE', value: secret, description: '' }, Date.now())
    const task = await createTaskRow({
      schedule: { type: 'manual' },
      executor: { type: 'http', config: { url: 'https://downstream.test', method: 'POST', body: '{{MULTILINE}}' } },
      alert: { mode: 'off' },
    })
    const calls = mockFetch(() => Response.json({ echo: secret }))
    const msg = message(task.id)
    await processRun(msg, envWithQueue().env)
    expect(await calls[0].text()).toBe(secret)
    const run = await getRun(env.DB, msg.runId)
    expect(run?.status).toBe('success')
    expect(JSON.parse(run!.responseBody!)).toEqual({ echo: '***' })
  })

  it('retries a 200 response when its JSON business result fails, then records success', async () => {
    const task = await createTaskRow({
      retry: { count: 1, intervalSeconds: 7 }, alert: { mode: 'off' },
      executor: { type: 'http', config: { url: 'https://downstream.test', successCondition: { match: 'all', rules: [
        { type: 'status', operator: 'between', value: 200, valueTo: 299 },
        { type: 'json', path: 'code', operator: 'eq', value: 0 },
      ] } } },
    })
    let attempts = 0
    mockFetch(() => new Response(JSON.stringify({ code: ++attempts === 1 ? 1 : 0 })))
    const { env: e, sent } = envWithQueue()
    const msg = message(task.id)
    await processRun(msg, e)
    expect(await getRun(env.DB, msg.runId)).toMatchObject({ status: 'retrying', httpStatus: 200, error: expect.stringContaining('第 2 条') })
    expect(sent).toEqual([{ body: { ...msg, attempt: 2 }, options: { delaySeconds: 7 } }])
    await processRun(sent[0].body, e)
    expect(await getRun(env.DB, msg.runId)).toMatchObject({ status: 'success', attempt: 2, httpStatus: 200, error: null })
  })

  it('records success, renders variables and releases the scheduler slot', async () => {
    await upsertVariable(env.DB, env.ENCRYPTION_KEY, { name: 'TOKEN', value: 's3cr3t-token', description: '' }, Date.now())
    const task = await createTaskRow({
      executor: {
        type: 'http',
        config: {
          url: 'https://downstream.test/run?k={{TOKEN}}',
          method: 'POST',
          headers: { authorization: 'Bearer {{TOKEN}}' },
          body: '{"a":1}',
        },
      },
    })
    const stub = env.TASK_SCHEDULER.getByName(task.id)
    await stub.sync(toSnapshot(task))
    const dispatched = await captureQueue(stub)
    await runDurableObjectAlarm(stub)
    expect((await stub.status()).running).not.toBeNull()

    const calls = mockFetch(() => new Response('ok, token was s3cr3t-token', { status: 200 }))
    const { env: e } = envWithQueue()
    await processRun(dispatched[0], e)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://downstream.test/run?k=s3cr3t-token')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].headers.get('authorization')).toBe('Bearer s3cr3t-token')
    expect(await calls[0].text()).toBe('{"a":1}')

    const run = await getRun(env.DB, dispatched[0].runId)
    expect(run).toMatchObject({ status: 'success', httpStatus: 200, attempt: 1, error: null, trigger: 'schedule' })
    expect(run?.responseBody).toBe('ok, token was ***')
    expect(run?.finishedAt).not.toBeNull()
    expect((await stub.status()).running).toBeNull()
  })

  it('fails a 2xx response that lacks the success keyword', async () => {
    const task = await createTaskRow({
      executor: { type: 'http', config: { url: 'https://downstream.test/', successKeyword: '"code":0' } },
    })
    mockFetch(() => new Response('{"code":500}'))
    const msg = message(task.id)
    await processRun(msg, envWithQueue().env)
    const run = await getRun(env.DB, msg.runId)
    expect(run?.status).toBe('failed')
    expect(run?.error).toContain('success keyword')
  })

  it('retries with the configured delay, then succeeds', async () => {
    const task = await createTaskRow({ retry: { count: 2, intervalSeconds: 7 } })
    let n = 0
    mockFetch(() => new Response('', { status: ++n === 1 ? 503 : 200 }))
    const { env: e, sent } = envWithQueue()
    const msg = message(task.id)

    await processRun(msg, e)
    let run = await getRun(env.DB, msg.runId)
    expect(run).toMatchObject({ status: 'retrying', httpStatus: 503, error: 'HTTP 503', finishedAt: null })
    expect(sent).toEqual([{ body: { ...msg, attempt: 2 }, options: { delaySeconds: 7 } }])

    await processRun(sent[0].body, e)
    run = await getRun(env.DB, msg.runId)
    expect(run).toMatchObject({ status: 'success', attempt: 2, httpStatus: 200, error: null })
  })

  it('after the last attempt fails, marks failed and sends the templated alert', async () => {
    await putAlertSettings(
      env.DB,
      { mode: 'webhook', url: 'https://alerts.test/hook', bodyTemplate: '{"text":"{{task.name}} #{{run.attempt}}: {{run.error}}"}', senderTopic: '' },
      Date.now(),
    )
    const task = await createTaskRow({ name: 'nightly "sync"', retry: { count: 1, intervalSeconds: 1 } })
    const calls = mockFetch((req) =>
      req.url.startsWith('https://alerts.test') ? new Response('ok') : new Response('boom', { status: 500 }),
    )
    const msg = message(task.id, { attempt: 2 })
    // Simulate that attempt 1 already happened.
    const { env: e, sent } = envWithQueue()
    await processRun({ ...msg, attempt: 1 }, e)
    await processRun(sent[0].body, e)

    const run = await getRun(env.DB, msg.runId)
    expect(run).toMatchObject({ status: 'failed', attempt: 2, httpStatus: 500 })
    await runDurableObjectAlarm(env.TASK_SCHEDULER.getByName(task.id))
    await vi.waitFor(() => expect(calls.some((c) => c.url === 'https://alerts.test/hook')).toBe(true))
    const alert = calls.find((c) => c.url === 'https://alerts.test/hook')!
    expect(alert.method).toBe('POST')
    expect(JSON.parse(await alert.text())).toEqual({ text: 'nightly "sync" #2: HTTP 500' })
  })

  it('task alert "off" suppresses the global alert', async () => {
    await putAlertSettings(env.DB, { mode: 'webhook', url: 'https://alerts.test/hook', bodyTemplate: '', senderTopic: '' }, Date.now())
    const task = await createTaskRow({ alert: { mode: 'off' } })
    const calls = mockFetch(() => new Response('', { status: 500 }))
    await processRun(message(task.id), envWithQueue().env)
    expect(calls.map((c) => c.url)).toEqual(['https://downstream.test/hook'])
  })

  it('custom alert without template posts the default JSON payload', async () => {
    const task = await createTaskRow({ alert: { mode: 'custom', url: 'https://alerts.test/custom' } })
    const calls = mockFetch((req) => new Response('', { status: req.url.includes('alerts') ? 200 : 404 }))
    const msg = message(task.id)
    await processRun(msg, envWithQueue().env)
    await runDurableObjectAlarm(env.TASK_SCHEDULER.getByName(task.id))
    await vi.waitFor(() => expect(calls.some((c) => c.url === 'https://alerts.test/custom')).toBe(true))
    const alert = calls.find((c) => c.url === 'https://alerts.test/custom')!
    expect(JSON.parse(await alert.text())).toMatchObject({
      event: 'task.failed',
      task: { id: task.id, name: 'demo' },
      run: { id: msg.runId, attempt: 1, trigger: 'manual', httpStatus: 404, error: 'HTTP 404' },
    })
  })

  it('executes a duplicate delivery only once', async () => {
    const task = await createTaskRow()
    const calls = mockFetch(() => new Response('ok'))
    const msg = message(task.id)
    await processRun(msg, envWithQueue().env)
    await processRun(msg, envWithQueue().env)
    expect(calls).toHaveLength(1)
  })

  it('fails without calling downstream when a variable is missing', async () => {
    const task = await createTaskRow({
      executor: { type: 'http', config: { url: 'https://downstream.test/', headers: { x: '{{NOPE}}' } } },
    })
    const calls = mockFetch(() => new Response('ok'))
    const msg = message(task.id)
    await processRun(msg, envWithQueue().env)
    expect(calls).toHaveLength(0)
    expect((await getRun(env.DB, msg.runId))?.error).toBe('unknown variable(s): NOPE')
  })

  it('times out slow requests', async () => {
    const task = await createTaskRow({
      executor: { type: 'http', config: { url: 'https://downstream.test/', timeoutMs: 1000 } },
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))),
    )
    const msg = message(task.id)
    await processRun(msg, envWithQueue().env)
    expect((await getRun(env.DB, msg.runId))?.error).toBe('timeout after 1000ms')
  })

  it('truncates stored response bodies to 4KB', async () => {
    const task = await createTaskRow()
    mockFetch(() => new Response('x'.repeat(10_000)))
    const msg = message(task.id)
    await processRun(msg, envWithQueue().env)
    const body = (await getRun(env.DB, msg.runId))!.responseBody!
    expect(body.startsWith('x'.repeat(4096))).toBe(true)
    expect(body.endsWith('…[truncated]')).toBe(true)
    expect(body.length).toBe(4096 + '…[truncated]'.length)
  })

  it('ignores messages for deleted tasks', async () => {
    const calls = mockFetch(() => new Response('ok'))
    const msg = message('does-not-exist')
    await processRun(msg, envWithQueue().env)
    expect(calls).toHaveLength(0)
    expect(await getRun(env.DB, msg.runId)).toBeNull()
  })
})

describe('queue handler', () => {
  it('acks processed messages and retries on infrastructure errors', async () => {
    const task = await createTaskRow()
    mockFetch(() => new Response('ok'))
    const ok = createMessageBatch<RunMessage>('yunji-task-runs', [
      { id: 'm1', timestamp: new Date(), attempts: 1, body: message(task.id) },
    ])
    const ctx1 = createExecutionContext()
    await worker.queue(ok, env)
    expect((await getQueueResult(ok, ctx1)).explicitAcks).toEqual(['m1'])

    const broken = Object.create(env, {
      DB: { value: { prepare: () => { throw new Error('D1 down') } } },
    }) as CloudflareBindings
    const bad = createMessageBatch<RunMessage>('yunji-task-runs', [
      { id: 'm2', timestamp: new Date(), attempts: 1, body: message(task.id) },
    ])
    const ctx2 = createExecutionContext()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await worker.queue(bad, broken)
    const result = await getQueueResult(bad, ctx2)
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(['m2'])
  })
})

describe('orphan scheduler', () => {
  it('a scheduled message for a deleted task destroys its DO', async () => {
    const taskId = crypto.randomUUID()
    const stub = env.TASK_SCHEDULER.getByName(taskId)
    await stub.sync({
      taskId, version: 1, enabled: true, scheduleType: 'cron', cron: '* * * * * *',
      timezone: 'UTC', runAt: null, overlapPolicy: 'skip', leaseMs: 1000, executionMode: 'inherit', timeoutMs: 30_000,
    })
    expect((await stub.status()).alarmAt).not.toBeNull()
    await processRun(message(taskId, { trigger: 'schedule' }), envWithQueue().env)
    expect(await stub.status()).toEqual({ version: null, alarmAt: null, running: null })
  })
})
