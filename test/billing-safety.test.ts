import { env } from 'cloudflare:workers'
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { verifyAccessJwt } from '../src/auth/access'
import { cachedStats, STATS_REBUILDS_PER_MINUTE } from '../src/domain/stats-cache'
import { MAX_TASKS, TASK_CREATES_PER_MINUTE } from '../src/domain/tasks-repo'
import { runMaintenance, MAINTENANCE_TASK_BATCH } from '../src/maintenance/maintenance'
import { createTaskRow, toSnapshot } from './helpers'

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tasks'), env.DB.prepare('DELETE FROM runs'), env.DB.prepare('DELETE FROM run_stats'),
    env.DB.prepare("DELETE FROM settings WHERE key LIKE 'maintenance:%'"),
  ])
})

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

it('coalesces failed Access refreshes and cools down across requests before retrying', async () => {
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('offline', { status: 503 }))
  const team = `${crypto.randomUUID()}.cloudflareaccess.com`
  expect(await Promise.all(Array.from({ length: 20 }, () => verifyAccessJwt('invalid', team, 'aud')))).toEqual(Array(20).fill(null))
  expect(fetch).toHaveBeenCalledOnce()
  await verifyAccessJwt('invalid', team, 'aud')
  expect(fetch).toHaveBeenCalledOnce()
  vi.mocked(Date.now).mockReturnValue(now + 60001)
  await verifyAccessJwt('invalid', team, 'aud')
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('bounds a hung Access fetch and does not immediately launch a second request', async () => {
  vi.useFakeTimers()
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}))
  const pending = verifyAccessJwt('invalid', `${crypto.randomUUID()}.cloudflareaccess.com`, 'aud')
  await vi.advanceTimersByTimeAsync(5001)
  expect(await pending).toBeNull()
  expect(fetch).toHaveBeenCalledOnce()
})

it('opens the cron circuit after five infrastructure failures; reconciliation cannot reopen it', async () => {
  const start = Date.now() + 86400000
  vi.spyOn(Date, 'now').mockReturnValue(start)
  const task = await createTaskRow({ schedule: { type: 'cron', cron: '* * * * * *', timezone: 'UTC' } })
  const stub = env.TASK_SCHEDULER.getByName(task.id)
  await stub.sync(toSnapshot(task))
  const failure = vi.fn(() => { throw new Error('settings unavailable') })
  await runInDurableObject(stub, (instance) => {
    const real = (instance as unknown as { env: CloudflareBindings }).env
    Object.defineProperty(instance, 'env', { value: Object.create(real, { DB: { value: {
      prepare: (sql: string) => sql.includes("key = 'safety'") ? failure() : real.DB.prepare(sql),
      batch: real.DB.batch.bind(real.DB),
    } } }) })
  })
  for (let n = 1; n <= 5; n++) {
    const at = (await stub.status()).alarmAt!
    vi.mocked(Date.now).mockReturnValue(at)
    await runDurableObjectAlarm(stub)
    const state = await stub.status()
    expect(state.dispatchFailures).toBe(n)
    if (n < 5) expect(state.alarmAt! - at).toBeGreaterThanOrEqual(30000 * 2 ** (n - 1))
  }
  expect(failure).toHaveBeenCalledTimes(5)
  expect((await stub.status()).alarmAt).toBeNull()
  await stub.sync(toSnapshot(task))
  await runMaintenance(env, Date.now())
  expect(await stub.status()).toMatchObject({ alarmAt: null, dispatchFailures: 5 })
  expect(await runDurableObjectAlarm(stub)).toBe(false)
  await stub.sync(toSnapshot({ ...task, version: task.version + 1 }))
  expect(await stub.status()).toMatchObject({ dispatchFailures: 0, alarmAt: expect.any(Number) })
})

it('enforces the creation rate atomically, including delete/recreate loops', async () => {
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const attempts = await Promise.allSettled(Array.from({ length: 45 }, () => createTaskRow({ schedule: { type: 'manual' } })))
  expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(TASK_CREATES_PER_MINUTE)
  await env.DB.prepare('DELETE FROM tasks').run()
  await expect(createTaskRow()).rejects.toThrow('task creation limit')
  vi.mocked(Date.now).mockReturnValue(now + 60000)
  await expect(createTaskRow()).resolves.toBeDefined()
})

async function seedTasks(count: number) {
  const stmt = env.DB.prepare(`INSERT INTO tasks(id,name,schedule_type,executor_type,executor_config,created_at,updated_at)
    VALUES(?,?,'manual','http','{"url":"https://example.test","method":"GET","headers":{},"body":"","timeoutMs":1000,"successKeyword":""}',0,0)`)
  for (let n = 0; n < count; n += 100) {
    await env.DB.batch(Array.from({ length: Math.min(100, count - n) }, (_, i) => stmt.bind(`seed-${String(n + i).padStart(4, '0')}`, 'seed')))
  }
}

it('enforces the total task cap under concurrent creates', async () => {
  await seedTasks(MAX_TASKS - 1)
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => createTaskRow()))
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM tasks').first('n')).toBe(MAX_TASKS)
})

it('advances bounded maintenance pages instead of reprocessing the first page', async () => {
  await seedTasks(MAINTENANCE_TASK_BATCH + 5)
  const now = Date.now()
  expect(await runMaintenance(env, now)).toMatchObject({ tasks: MAINTENANCE_TASK_BATCH, fullReconcile: true })
  expect(await runMaintenance(env, now + 300000)).toMatchObject({ tasks: 5, fullReconcile: true })
  expect(await runMaintenance(env, now + 600000)).toMatchObject({ tasks: 0, fullReconcile: false })
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM tasks WHERE scheduler_synced_version < version').first('n')).toBe(0)
})

it('shares cached statistics and a refresh lease across concurrent requests', async () => {
  const build = vi.fn(async () => ({ total: 42 }))
  const responses = await Promise.allSettled(Array.from({ length: 20 }, () => cachedStats(env.DB, 'same', build)))
  expect(responses.some((r) => r.status === 'fulfilled')).toBe(true)
  expect(build).toHaveBeenCalledOnce()
  expect(await cachedStats(env.DB, 'same', build)).toEqual({ total: 42 })
  expect(build).toHaveBeenCalledOnce()
})

it('limits different cache keys globally and permits fresh cache hits after exhaustion', async () => {
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const build = vi.fn(async () => ({ total: 42 }))
  const responses = await Promise.allSettled(Array.from({ length: 40 }, (_, n) => cachedStats(env.DB, `key-${n}`, build)))
  expect(responses.filter((r) => r.status === 'fulfilled')).toHaveLength(STATS_REBUILDS_PER_MINUTE)
  expect(build).toHaveBeenCalledTimes(STATS_REBUILDS_PER_MINUTE)
  const successful = responses.findIndex((r) => r.status === 'fulfilled')
  await expect(cachedStats(env.DB, `key-${successful}`, build)).resolves.toEqual({ total: 42 })
  vi.mocked(Date.now).mockReturnValue(now + 60001)
  await expect(cachedStats(env.DB, `key-${successful}`, build)).resolves.toEqual({ total: 42 })
  expect(build).toHaveBeenCalledTimes(STATS_REBUILDS_PER_MINUTE + 1)
})

it('failed statistics rebuilds retain a cooldown rather than spinning on errors', async () => {
  const build = vi.fn(async () => { throw new Error('database unavailable') })
  await expect(cachedStats(env.DB, 'failure', build)).rejects.toThrow('database unavailable')
  await expect(cachedStats(env.DB, 'failure', build)).rejects.toThrow('statistics are refreshing')
  expect(build).toHaveBeenCalledOnce()
})

it('maintains exact hourly sums and maxima when minute rows update or expire', async () => {
  const task = await createTaskRow()
  const hour = Date.UTC(2026, 9, 18)
  await env.DB.batch([
    env.DB.prepare('INSERT INTO run_stats(task_id,bucket,success,duration_count,duration_sum,duration_max) VALUES(?,?,1,1,10,10)').bind(task.id, hour),
    env.DB.prepare('INSERT INTO run_stats(task_id,bucket,success,duration_count,duration_sum,duration_max) VALUES(?,?,1,1,20,20)').bind(task.id, hour + 60000),
  ])
  await env.DB.prepare('UPDATE run_stats SET success=2,duration_count=2,duration_sum=40,duration_max=30 WHERE task_id=? AND bucket=?').bind(task.id, hour).run()
  const read = () => env.DB.prepare('SELECT success,duration_sum,duration_max FROM run_stats_hourly WHERE task_id=?').bind(task.id).first()
  expect(await read()).toEqual({ success: 3, duration_sum: 60, duration_max: 30 })
  await env.DB.prepare('DELETE FROM run_stats WHERE task_id=? AND bucket=?').bind(task.id, hour).run()
  expect(await read()).toEqual({ success: 1, duration_sum: 20, duration_max: 20 })
  await env.DB.prepare('DELETE FROM run_stats WHERE task_id=?').bind(task.id).run()
  expect(await read()).toBeNull()
})

it('rejects stale quota windows without resetting a newer exhausted window', async () => {
  const now = Math.floor(Date.now() / 60000) * 60000 + 1000
  vi.spyOn(Date, 'now').mockReturnValue(now)
  await env.DB.batch([
    env.DB.prepare("INSERT INTO resource_budgets(name,window,count) VALUES('task-create',?,?)").bind(Math.floor(now / 60000), TASK_CREATES_PER_MINUTE),
    env.DB.prepare("INSERT INTO resource_budgets(name,window,count) VALUES('stats-rebuild',?,?)").bind(Math.floor(now / 60000), STATS_REBUILDS_PER_MINUTE),
  ])
  const build = vi.fn(async () => 1)
  for (const at of [now - 60000, now]) {
    vi.mocked(Date.now).mockReturnValue(at)
    await expect(createTaskRow()).rejects.toThrow('task creation limit')
    await expect(cachedStats(env.DB, `late-${at}`, build)).rejects.toThrow('query budget exhausted')
  }
  expect(build).not.toHaveBeenCalled()
  vi.mocked(Date.now).mockReturnValue(now + 60000)
  await expect(createTaskRow()).resolves.toBeDefined()
  await expect(cachedStats(env.DB, 'next-minute', build)).resolves.toBe(1)
})

it('resumes purge at the first unvisited task when the row budget is exhausted', async () => {
  await seedTasks(25)
  const now = Date.now()
  const old = now - 40 * 86400000
  for (let t = 0; t < 20; t++) {
    await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<999)
      INSERT INTO runs(id,task_id,trigger,status,scheduled_at,created_at,updated_at)
      SELECT ?||':'||x,?,'manual','success',?,?,? FROM n`)
      .bind(`old-${t}`, `seed-${String(t).padStart(4, '0')}`, old, old, old).run()
  }
  await env.DB.prepare("INSERT INTO runs(id,task_id,trigger,status,scheduled_at,created_at,updated_at) VALUES('unvisited','seed-0020','manual','success',?,?,?)").bind(old, old, old).run()
  expect((await runMaintenance(env, now)).purgedRuns).toBe(20000)
  const cursor = await env.DB.prepare("SELECT json_extract(value,'$.purge') AS id FROM settings WHERE key='maintenance:cursors'").first('id')
  expect(cursor).toBe('seed-0019')
  expect(await env.DB.prepare("SELECT id FROM runs WHERE id='unvisited'").first()).not.toBeNull()
  expect((await runMaintenance(env, now + 300000)).purgedRuns).toBe(1)
  expect(await env.DB.prepare("SELECT id FROM runs WHERE id='unvisited'").first()).toBeNull()
})

it('visits every task when a partial purge budget shrinks the chunk size', async () => {
  await seedTasks(45)
  const now = Date.now()
  const old = now - 40 * 86400000
  for (let t = 0; t < 19; t++) {
    const count = t < 18 ? 1000 : 500
    await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<?)
      INSERT INTO runs(id,task_id,trigger,status,scheduled_at,created_at,updated_at)
      SELECT ?||':'||x,?,'manual','success',?,?,? FROM n`)
      .bind(count - 1, `partial-${t}`, `seed-${String(t).padStart(4, '0')}`, old, old, old).run()
  }
  await env.DB.prepare("INSERT INTO runs(id,task_id,trigger,status,scheduled_at,created_at,updated_at) VALUES('after-empty','seed-0021','manual','success',?,?,?)").bind(old, old, old).run()
  expect((await runMaintenance(env, now)).purgedRuns).toBe(18501)
  expect(await env.DB.prepare("SELECT id FROM runs WHERE id='after-empty'").first()).toBeNull()
})
