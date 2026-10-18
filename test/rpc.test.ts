import { runDurableObjectAlarm } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rpcBindings, rpcConfigSchema, rpcExecutor, encodeRpcJson } from '../src/executor/rpc'
import { processRun, type RunTransport } from '../src/executor/consumer'
import { getRun, listRuns } from '../src/domain/runs-repo'
import { app } from '../src/app'
import { parseTaskInput } from '../src/domain/task-service'
import { upsertVariable } from '../src/domain/variables'
import { captureQueue, createTaskRow, taskInput, toSnapshot } from './helpers'

const run = () => ({ taskId: crypto.randomUUID(), runId: crypto.randomUUID(), attempt: 1 })
const config = (extra: Record<string, unknown> = {}) => rpcConfigSchema.parse({ binding: 'RPC_TEST', method: 'echo', ...extra })
const execute = (extra: Record<string, unknown> = {}, variables: Record<string, string> = {}) => rpcExecutor.execute(config(extra), variables, { env, run: run() })
afterEach(() => vi.useRealTimers())

describe('RPC executor', () => {
  it('calls a real WorkerEntrypoint with multiple typed JSON arguments', async () => {
    const result = await execute({ args: [{ batchSize: 100 }, 0, false, null, ['a', 'b']] })
    expect(result).toMatchObject({ ok: true, httpStatus: null, error: null })
    expect(JSON.parse(result.responseBody!)).toEqual({ args: [{ batchSize: 100 }, 0, false, null, ['a', 'b']] })
    expect(await execute({ method: 'cleanupExpiredSessions', args: [{ batchSize: 42 }] })).toMatchObject({ responseBody: '{"deleted":42}' })
  })
  it('accepts a void return and reports remote exceptions or missing methods as failures', async () => {
    expect(await execute({ method: 'noResult' })).toMatchObject({ ok: true, responseBody: null })
    expect(await execute({ method: 'fail', args: ['business failure'] })).toMatchObject({ ok: false, error: 'business failure' })
    expect(await execute({ method: 'missingMethod' })).toMatchObject({ ok: false })
    expect(await execute({ method: 'nonJson' })).toMatchObject({ ok: false, error: expect.stringContaining('JSON-compatible') })
  })
  it('interpolates only string values, retaining JSON types, quotes and __proto__ keys', async () => {
    const current = run()
    const args = JSON.parse('[{"__proto__":"{{TOKEN}}","count":0,"nested":[false,"{{run.id}}","{{run.attempt}}","{{task.id}}"]}]')
    const secret = 'token"\\\n值'
    const result = await rpcExecutor.execute(config({ args }), { TOKEN: secret }, { env, run: current })
    expect(result.ok).toBe(true)
    const decoded = JSON.parse(result.responseBody!).args[0]
    expect(decoded.__proto__).toBe('***')
    expect(decoded.count).toBe(0)
    expect(decoded.nested).toEqual([false, current.runId, '1', current.taskId])
    expect(rpcExecutor.templatedFields(config({ args }))).toContain('{{TOKEN}}')
  })
  it('evaluates JSON conditions without treating business false as an automatic exception', async () => {
    const condition = { match: 'all', rules: [{ type: 'json', path: 'deleted', operator: 'eq', value: 42 }] }
    expect(await execute({ method: 'cleanupExpiredSessions', args: [{ batchSize: 42 }], successCondition: condition })).toMatchObject({ ok: true })
    expect(await execute({ method: 'cleanupExpiredSessions', args: [{ batchSize: 0 }], successCondition: condition })).toMatchObject({ ok: false, responseBody: '{"deleted":0}' })
    expect(await execute({ method: 'noResult', successCondition: condition })).toMatchObject({ ok: false })
    expect(rpcConfigSchema.safeParse({ binding: 'RPC_TEST', method: 'echo', successCondition: { match: 'all', rules: [{ type: 'status', operator: 'eq', value: 200 }] } }).success).toBe(false)
  })
  it.each(['constructor', '__proto__', 'fetch', 'connect', 'then', 'dup', 'service.method', 'echo[0]', '_private'])('rejects reserved or nested method %s', (method) => {
    expect(rpcConfigSchema.safeParse({ binding: 'RPC_TEST', method }).success).toBe(false)
  })
  it('rejects invalid/oversized arguments before calling the target, including after expansion', async () => {
    for (const args of [{}, [undefined], [NaN], ['字'.repeat(22_000)], Array(51).fill(0)]) {
      expect(rpcConfigSchema.safeParse({ binding: 'RPC_TEST', method: 'echo', args }).success).toBe(false)
    }
    expect(await execute({ args: ['{{UNKNOWN}}'] })).toMatchObject({ ok: false, error: expect.stringContaining('unknown variable') })
    expect(await execute({ args: ['{{TOKEN}}'.repeat(40)] }, { TOKEN: 'x'.repeat(2000) })).toMatchObject({ ok: false, error: expect.stringContaining('65536') })
    const cycle: any = {}; cycle.self = cycle
    expect(() => encodeRpcJson(cycle, 100)).toThrow('circular')
    expect(await execute({ args: ['x'.repeat(5000)] })).toMatchObject({ ok: true, responseBody: expect.stringContaining('[truncated]') })
  })
  it('only exposes explicitly configured service bindings, blocking internal bindings and missing services', async () => {
    const fake = { RPC_BINDINGS: 'DB,ASSETS,RUN_QUEUE,TASK_SCHEDULER,APP, APP,MISSING,SECRET', DB: {}, ASSETS: {}, RUN_QUEUE: {}, TASK_SCHEDULER: {}, APP: { fetch: vi.fn(), echo: vi.fn() }, SECRET: 'secret' }
    expect(rpcBindings(fake)).toEqual(['APP'])
    expect(await rpcExecutor.execute(config(), {}, { env: fake, run: run() })).toMatchObject({ ok: false })
    expect(fake.APP.echo).not.toHaveBeenCalled()
    expect(await rpcExecutor.execute(config(), {})).toMatchObject({ ok: false })
  })
  it('expires the local deadline, disposes the RPC call and ignores late completion', async () => {
    vi.useFakeTimers()
    let finish!: (value: unknown) => void
    const pending = new Promise((resolve) => { finish = resolve })
    const dispose = vi.fn()
    Object.defineProperty(pending, Symbol.dispose, { value: dispose })
    const target = { RPC_BINDINGS: 'APP', APP: { fetch: vi.fn(), echo: () => pending } }
    const result = rpcExecutor.execute(config({ binding: 'APP', timeoutMs: 1000 }), {}, { env: target, run: run() })
    await vi.advanceTimersByTimeAsync(1001)
    expect(await result).toMatchObject({ ok: false, error: expect.stringContaining('target may still be running') })
    expect(dispose).toHaveBeenCalledOnce()
    finish({ late: true })
    await Promise.resolve()
    expect((await result).ok).toBe(false)
  })
  it('rejects unavailable bindings at the API validation boundary', async () => {
    const raw = taskInput({ executor: { type: 'rpc', config: { binding: 'MISSING', method: 'echo' } } })
    await expect(parseTaskInput(raw, Date.now(), env)).rejects.toMatchObject({ issues: [expect.objectContaining({ path: 'executor.config.binding' })] })
    raw.executor = { type: 'rpc', config: config() }
    await expect(parseTaskInput(raw, Date.now(), env)).resolves.toMatchObject({ executor: { type: 'rpc' } })
  })
  it.each(['worker', 'queue', 'direct'] as const)('runs RPC through the shared %s pipeline, redacts secrets and deduplicates attempts', async (mode) => {
    const secret = 'rpc-private-value'
    await upsertVariable(env.DB, env.ENCRYPTION_KEY, { name: 'RPC_SECRET', value: secret, description: '' }, Date.now())
    const task = await createTaskRow({ schedule: { type: 'manual' }, alert: { mode: 'off' }, executor: { type: 'rpc', config: { binding: 'RPC_TEST', method: 'echo', args: ['{{RPC_SECRET}}', '{{run.id}}'] } } })
    const msg = { ...run(), taskId: task.id, scheduledAt: Date.now(), trigger: 'manual' as const }
    const transport: RunTransport = { mode, retry: vi.fn(), finished: vi.fn(), orphaned: vi.fn() }
    await processRun(msg, env, transport, mode === 'worker' ? 25_000 : undefined)
    const saved = await getRun(env.DB, msg.runId)
    expect(saved).toMatchObject({ status: 'success', httpStatus: null, executionMode: mode, effectiveTimeoutMs: 25_000 })
    expect(JSON.parse(saved!.responseBody!)).toEqual({ args: ['***', msg.runId] })
    await processRun(msg, env, transport)
    expect(await getRun(env.DB, msg.runId)).toEqual(saved)
  })
  it('retries remote business failures with the same run id and records a final failure', async () => {
    const task = await createTaskRow({ schedule: { type: 'manual' }, alert: { mode: 'off' }, retry: { count: 1, intervalSeconds: 1 }, executor: { type: 'rpc', config: { binding: 'RPC_TEST', method: 'fail', args: ['failure {{run.id}}'] } } })
    const msg = { ...run(), taskId: task.id, scheduledAt: Date.now(), trigger: 'manual' as const }
    const transport: RunTransport = { mode: 'queue', retry: vi.fn(), finished: vi.fn(), orphaned: vi.fn() }
    await processRun(msg, env, transport)
    expect(await getRun(env.DB, msg.runId)).toMatchObject({ status: 'retrying', attempt: 1 })
    expect(transport.retry).toHaveBeenCalledWith({ ...msg, attempt: 2 }, expect.any(Number))
    await processRun({ ...msg, attempt: 2 }, env, transport)
    expect(await getRun(env.DB, msg.runId)).toMatchObject({ status: 'failed', attempt: 2, error: `failure ${msg.runId}` })
  })
})


describe('scheduled RPC integration', () => {
  it.each(['worker', 'direct', 'queue'] as const)('dispatches from the real scheduler using %s', async (mode) => {
    const task = await createTaskRow({ schedule: { type: 'once', runAt: Date.now() + 60_000 }, executionMode: mode, alert: { mode: 'off' },
      executor: { type: 'rpc', config: { binding: 'RPC_TEST', method: 'cleanupExpiredSessions', args: [{ batchSize: 7 }] } },
    })
    const scheduler = env.TASK_SCHEDULER.getByName(task.id)
    await scheduler.sync(toSnapshot(task))
    const messages = await captureQueue(scheduler)
    await runDurableObjectAlarm(scheduler)
    if (mode === 'queue') {
      expect(messages).toHaveLength(1)
      await processRun(messages[0], env)
    }
    await vi.waitFor(async () => {
      const [saved] = await listRuns(env.DB, task.id, { limit: 10 })
      expect(saved).toMatchObject({ status: 'success', trigger: 'schedule', executionMode: mode, responseBody: '{"deleted":7}', httpStatus: null })
      expect((await scheduler.status()).running).toBeNull()
    }, { interval: 20, timeout: 3000 })
    await scheduler.destroy()
  })
  it('accepts API create/read/update with RPC configuration and rejects an unexposed target', async () => {
    const headers = { authorization: `Bearer ${env.API_TOKEN}`, 'content-type': 'application/json' }
    const raw = { name: 'API RPC', schedule: { type: 'manual' }, executor: { type: 'rpc', config: { binding: 'RPC_TEST', method: 'echo', args: [{ x: 1 }] } } }
    const response = await app.request('http://task.test/api/tasks', { method: 'POST', headers, body: JSON.stringify(raw) }, env)
    expect(response.status).toBe(201)
    const { task } = await response.json() as any
    const read = await app.request(`http://task.test/api/tasks/${task.id}`, { headers }, env)
    expect((await read.json() as any).task.executor).toEqual(task.executor)
    const update = await app.request(`http://task.test/api/tasks/${task.id}`, { method: 'PUT', headers: { ...headers, 'if-match': response.headers.get('etag')! }, body: JSON.stringify({ ...raw, executor: { type: 'rpc', config: { binding: 'RPC_TEST', method: 'noResult', args: [] } } }) }, env)
    expect(update.status).toBe(200)
    const bad = await app.request('http://task.test/api/tasks', { method: 'POST', headers, body: JSON.stringify({ ...raw, executor: { type: 'rpc', config: { binding: 'DB', method: 'exec', args: ['DROP TABLE tasks'] } } }) }, env)
    expect(bad.status).toBe(422)
  })
  it.each([false, 0, null])('records the JSON return value %s as success', async (value) => {
    expect(await execute({ method: 'identity', args: [value] })).toMatchObject({ ok: true, responseBody: JSON.stringify(value) })
  })
  it('rejects oversized return values instead of applying conditions to truncated JSON', async () => {
    expect(await execute({ method: 'large', args: [1024 * 1024] })).toMatchObject({ ok: false, error: expect.stringContaining('1048576') })
  })
})
