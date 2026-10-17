import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { app } from '../src/app'
import { listRuns } from '../src/domain/runs-repo'
import { getRuntimeSettings } from '../src/domain/settings'
import { DEFAULT_RUNTIME_SETTINGS } from '../src/shared/types'
import type { TaskScheduler } from '../src/scheduler/task-scheduler'
import { captureQueue, createTaskRow, toSnapshot } from './helpers'

afterEach(() => vi.restoreAllMocks())

const AUTH = { authorization: `Bearer ${env.API_TOKEN}`, 'content-type': 'application/json' }
const call = (method: string, body?: unknown, e: CloudflareBindings = env) =>
  app.request('https://yunji-task.test/api/settings/runtime', {
    method,
    headers: AUTH,
    body: body === undefined ? undefined : JSON.stringify(body),
  }, e)
const saved = { executionMode: 'direct', retentionDays: 7, statsRetentionDays: 365 } as const

describe('runtime settings', () => {
  it('uses application defaults on a fresh database', async () => {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'runtime'").run()
    const res = await call('GET')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ settings: DEFAULT_RUNTIME_SETTINGS })
  })

  it('round-trips all three settings without touching the independent alert settings', async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('alert', ?, ?)")
      .bind('{"url":"https://alert.test","bodyTemplate":""}', Date.now()).run()
    const res = await call('PUT', saved)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ settings: saved })
    expect(await (await call('GET')).json()).toEqual({ settings: saved })
    expect(await getRuntimeSettings(env.DB)).toEqual(saved)
    const alert = await env.DB.prepare("SELECT value FROM settings WHERE key = 'alert'").first<{ value: string }>()
    expect(JSON.parse(alert!.value).url).toBe('https://alert.test')
  })

  it.each([
    { executionMode: 'automatic' },
    { executionMode: null },
    { retentionDays: 0 },
    { retentionDays: 3651 },
    { retentionDays: 1.5 },
    { retentionDays: '7' },
    { retentionDays: null },
    { statsRetentionDays: -1 },
    { statsRetentionDays: 3651 },
    { statsRetentionDays: 1.5 },
    { statsRetentionDays: '' },
  ])('rejects invalid values atomically: %j', async (invalid) => {
    await call('PUT', saved)
    const res = await call('PUT', { ...saved, ...invalid })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({
      error: 'validation_failed',
      issues: [{ path: Object.keys(invalid)[0] }],
    })
    expect(await getRuntimeSettings(env.DB)).toEqual(saved)
  })

  it('requires the complete settings object instead of resetting omitted fields', async () => {
    await call('PUT', saved)
    expect((await call('PUT', { executionMode: 'worker' })).status).toBe(422)
    expect(await getRuntimeSettings(env.DB)).toEqual(saved)
  })

  it.each([1, 3650])('accepts the retention boundary %i', async (days) => {
    expect((await call('PUT', { ...saved, retentionDays: days, statsRetentionDays: days })).status).toBe(200)
  })

  it('rejects queue mode without a binding and preserves the saved configuration', async () => {
    await call('PUT', saved)
    const noQueue = Object.create(env, { RUN_QUEUE: { value: undefined } }) as CloudflareBindings
    const rejected = await call('PUT', { ...saved, executionMode: 'queue' }, noQueue)
    expect(rejected.status).toBe(422)
    expect(await rejected.json()).toMatchObject({ issues: [{ path: 'executionMode' }] })
    expect(await getRuntimeSettings(env.DB)).toEqual(saved)
    expect((await call('PUT', { ...saved, executionMode: 'worker' }, noQueue)).status).toBe(200)
  })

  it('requires authentication for reads and writes', async () => {
    for (const method of ['GET', 'PUT']) {
      const res = await app.request('https://yunji-task.test/api/settings/runtime', { method }, env)
      expect(res.status).toBe(401)
    }
  })

  it('shares the same settings with the authenticated admin API', async () => {
    const authorization = `Basic ${btoa(`admin:${env.ADMIN_PASSWORD}`)}`
    const res = await app.request('https://yunji-task.test/admin/api/settings/runtime', {
      method: 'PUT',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(saved),
    }, env)
    expect(res.status).toBe(200)
    const me = await app.request('https://yunji-task.test/admin/api/me', { headers: { authorization } }, env)
    expect(await me.json()).toMatchObject(saved)
    expect(await (await call('GET')).json()).toEqual({ settings: saved })
  })

  it('uses newly saved modes on the same existing scheduler without resyncing or restarting', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok'))
    const task = await createTaskRow({
      schedule: { type: 'cron', cron: '0 0 0 1 1 *', timezone: 'UTC' },
      overlapPolicy: 'parallel',
    })
    const stub = env.TASK_SCHEDULER.getByName(task.id)
    await stub.sync(toSnapshot(task))
    const sent = await captureQueue(stub)
    await runDurableObjectAlarm(stub)
    expect(sent).toHaveLength(1)

    for (const [index, mode] of ['direct', 'worker'].entries()) {
      expect((await call('PUT', { ...saved, executionMode: mode })).status).toBe(200)
      await runDurableObjectAlarm(stub)
      await vi.waitFor(async () => {
        const runs = await listRuns(env.DB, task.id, { limit: 10 })
        expect(runs.filter((run) => run.status === 'success')).toHaveLength(index + 1)
      })
      expect(sent).toHaveLength(1)
    }
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(timeout.mock.calls).toEqual([[25_000], [25_000]])
    expect((await stub.status()).version).toBe(task.version)
  })

  it('does not occupy the running slot when reading the global setting fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetch = vi.spyOn(globalThis, 'fetch')
    const task = await createTaskRow()
    const stub = env.TASK_SCHEDULER.getByName(task.id)
    await stub.sync(toSnapshot(task))
    await runInDurableObject(stub, (instance: TaskScheduler) => {
      const real = (instance as unknown as { env: CloudflareBindings }).env
      const brokenDb = { prepare: () => ({ first: async () => { throw new Error('runtime settings unavailable') } }) }
      Object.defineProperty(instance, 'env', { value: Object.create(real, { DB: { value: brokenDb } }) })
    })
    await runDurableObjectAlarm(stub)
    expect((await stub.status()).running).toBeNull()
    expect((await stub.status()).alarmAt).not.toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    expect(error.mock.calls.some(([message]) => message === 'dispatch failed')).toBe(true)
  })
})
