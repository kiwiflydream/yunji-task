import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../src/app'
import { claimRun, DAY_MS, getRun, insertSkippedRun, markLostRuns, recordAttempt, RUNNING_STALE_MS, type RunMessage } from '../src/domain/runs-repo'
import {
  addAgg,
  bucketize,
  bucketIndex,
  emptyAgg,
  floorMinute,
  HOUR_MS,
  percentile,
  rankTasks,
  statsWindow,
  summarize,
  type Agg,
} from '../src/domain/stats'
import { deleteTask } from '../src/domain/tasks-repo'
import { processRun } from '../src/executor/consumer'
import { runMaintenance } from '../src/maintenance/maintenance'
import type { StatsOverview, TaskStats } from '../src/shared/types'
import { createTaskRow, setRuntimeSettings } from './helpers'

function agg(patch: Partial<Agg> & { at?: Record<number, number> } = {}): Agg {
  const { at, ...rest } = patch
  const a = { ...emptyAgg(), ...rest }
  if (at) {
    a.buckets = emptyAgg().buckets
    for (const [i, n] of Object.entries(at)) a.buckets[Number(i)] = n
    a.durationCount = Object.values(at).reduce((s, n) => s + n, 0)
  }
  return a
}

describe('duration histogram', () => {
  it('assigns inclusive upper bounds and an overflow bucket', () => {
    expect(bucketIndex(0)).toBe(0)
    expect(bucketIndex(50)).toBe(0)
    expect(bucketIndex(51)).toBe(1)
    expect(bucketIndex(1000)).toBe(4)
    expect(bucketIndex(60_000)).toBe(9)
    expect(bucketIndex(60_001)).toBe(10)
  })

  it('interpolates percentiles inside the containing bucket', () => {
    // 100 samples in (100, 250]: P50 sits half-way through the bucket.
    expect(percentile(agg({ at: { 2: 100 }, durationMax: 250 }), 0.5)).toBe(175)
    // 90 fast + 10 slow: P50 is in the first bucket, P95 in (1000, 2500].
    const mixed = agg({ at: { 0: 90, 5: 10 }, durationMax: 2400 })
    expect(percentile(mixed, 0.5)).toBe(28)
    expect(percentile(mixed, 0.95)).toBe(1750)
  })

  it('bounds the overflow bucket and every estimate by the observed max', () => {
    expect(percentile(agg({ at: { 10: 4 }, durationMax: 100_000 }), 0.5)).toBe(80_000)
    expect(percentile(agg({ at: { 4: 1 }, durationMax: 600 }), 0.99)).toBe(600)
    expect(percentile(emptyAgg(), 0.5)).toBeNull()
  })
})

describe('summarize', () => {
  it('excludes skipped runs from the success rate', () => {
    const s = summarize(agg({ success: 3, failed: 1, skipped: 6, durationSum: 400, at: { 1: 4 }, durationMax: 100 }))
    expect(s).toMatchObject({ total: 10, successRate: 0.75, durationAvg: 100, durationMax: 100 })
  })

  it('reports null rates and durations without samples', () => {
    expect(summarize(agg({ skipped: 2 }))).toMatchObject({
      total: 2,
      successRate: null,
      durationAvg: null,
      durationP95: null,
      durationMax: null,
      delayAvg: null,
      delayMax: null,
    })
  })
})

describe('statsWindow', () => {
  const now = Date.UTC(2026, 9, 16, 8, 20) // 2026-10-16 16:20 Asia/Shanghai

  it('24h is 24 hourly buckets ending with the current hour', () => {
    const w = statsWindow('24h', now, 'UTC')
    expect(w.granularity).toBe('hour')
    expect(w.buckets).toHaveLength(24)
    expect(w.buckets[23]).toBe(Date.UTC(2026, 9, 16, 8))
    expect(w.from).toBe(Date.UTC(2026, 9, 15, 9))
  })

  it('30d is 30 local calendar days in the viewer timezone, today included', () => {
    const evening = Date.UTC(2026, 9, 16, 20) // already 2026-10-17 04:00 in Shanghai
    const w = statsWindow('30d', evening, 'Asia/Shanghai')
    expect(w.granularity).toBe('day')
    expect(w.buckets).toHaveLength(30)
    expect(w.buckets[29]).toBe(Date.UTC(2026, 9, 16, 16)) // 2026-10-17 00:00 +08:00
    expect(w.buckets[0]).toBe(Date.UTC(2026, 8, 17, 16))
    expect(statsWindow('30d', evening, 'UTC').buckets[29]).toBe(Date.UTC(2026, 9, 16))
  })

  it('day buckets follow DST (23h and 25h days)', () => {
    const w = statsWindow('90d', Date.UTC(2026, 10, 20, 12), 'America/New_York')
    const lengths = new Set(w.buckets.slice(1).map((b, i) => (b - w.buckets[i]) / HOUR_MS))
    expect(lengths).toEqual(new Set([24, 25])) // 2026-11-01 falls back
  })
})

describe('bucketize', () => {
  it('sums hours into their day bucket, zero-fills gaps and drops out-of-window hours', () => {
    const now = Date.UTC(2026, 9, 16, 8, 20)
    const w = statsWindow('30d', now, 'Asia/Shanghai')
    const today = w.buckets[29]
    const out = bucketize(w, [
      { start: today, agg: agg({ success: 1 }) },
      { start: today + 5 * HOUR_MS, agg: agg({ failed: 2 }) },
      { start: today - HOUR_MS, agg: agg({ success: 4 }) }, // 23:00 yesterday
      { start: w.from - HOUR_MS, agg: agg({ success: 100 }) },
    ])
    expect(out).toHaveLength(30)
    expect(out[29]).toMatchObject({ success: 1, failed: 2 })
    expect(out[28]).toMatchObject({ success: 4 })
    expect(out.reduce((s, a) => s + a.success, 0)).toBe(5)
  })
})

describe('rankTasks', () => {
  it('ranks by failures (then lower success rate) and by P95', () => {
    const { topFailing, slowest } = rankTasks([
      { taskId: 'a', name: 'A', agg: agg({ success: 9, failed: 1, at: { 1: 10 }, durationMax: 100 }) },
      { taskId: 'b', name: 'B', agg: agg({ success: 1, failed: 3, at: { 6: 4 }, durationMax: 5000 }) },
      { taskId: 'c', name: 'C', agg: agg({ success: 0, failed: 1 }) },
      { taskId: 'd', name: 'D', agg: agg({ success: 5 }) },
    ])
    expect(topFailing.map((r) => r.taskId)).toEqual(['b', 'c', 'a'])
    expect(slowest.map((r) => r.taskId)).toEqual(['b', 'a'])
  })
})

interface StatsRow {
  bucket: number
  success: number
  failed: number
  skipped: number
  duration_count: number
  duration_sum: number
  duration_max: number
  dur_b0: number
  delay_count: number
  delay_sum: number
  delay_max: number
}

async function statsRows(taskId: string) {
  const { results } = await env.DB.prepare('SELECT * FROM run_stats WHERE task_id = ? ORDER BY bucket')
    .bind(taskId)
    .all<StatsRow>()
  return results
}

const totals = (rows: StatsRow[]) => rows.reduce((t, r) => addAgg(t, { ...emptyAgg(), success: r.success, failed: r.failed, skipped: r.skipped }), emptyAgg())

function message(taskId: string, overrides: Partial<RunMessage> = {}): RunMessage {
  return { runId: crypto.randomUUID(), taskId, trigger: 'manual', scheduledAt: Date.now(), attempt: 1, ...overrides }
}

function envWithQueue() {
  const sent: RunMessage[] = []
  const fake = Object.create(env, {
    RUN_QUEUE: { value: { send: async (body: RunMessage) => void sent.push(body) } },
  }) as CloudflareBindings
  return { env: fake, sent }
}

const result = (durationMs: number) => ({ httpStatus: 200, responseBody: null, error: null, durationMs })

describe('stats accumulation', () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare('DELETE FROM run_stats'), env.DB.prepare("DELETE FROM settings WHERE key = 'alert'")])
  })
  afterEach(() => vi.restoreAllMocks())

  it('counts a scheduled success with its duration and scheduling delay in the scheduled minute', async () => {
    const task = await createTaskRow()
    const scheduledAt = Date.UTC(2026, 9, 16, 8, 59, 58)
    const msg = message(task.id, { trigger: 'schedule', scheduledAt })
    await claimRun(env.DB, msg, scheduledAt + 1500)
    expect(await recordAttempt(env.DB, msg.runId, 'success', result(120), scheduledAt + 1620)).toBe(true)

    const [row] = await statsRows(task.id)
    expect(row).toMatchObject({
      bucket: Date.UTC(2026, 9, 16, 8, 59),
      success: 1,
      failed: 0,
      duration_count: 1,
      duration_sum: 120,
      dur_b0: 0,
      delay_count: 1,
      delay_sum: 1500,
      delay_max: 1500,
    })
    expect((row as unknown as Record<string, number>).dur_b2).toBe(1)
  })

  it('keeps the maximum duration and delay across runs in the same minute', async () => {
    const task = await createTaskRow()
    const hour = Date.UTC(2026, 9, 16, 5)
    for (const [delay, duration] of [[500, 300], [100, 100]]) {
      const msg = message(task.id, { trigger: 'schedule', scheduledAt: hour + 1000 })
      await claimRun(env.DB, msg, hour + 1000 + delay)
      await recordAttempt(env.DB, msg.runId, 'success', result(duration), hour + 5000)
    }
    expect(await statsRows(task.id)).toMatchObject([
      { success: 2, duration_count: 2, duration_sum: 400, duration_max: 300, delay_count: 2, delay_sum: 600, delay_max: 500 },
    ])
  })

  it('does not record a scheduling delay for manual runs', async () => {
    const task = await createTaskRow()
    const msg = message(task.id)
    await claimRun(env.DB, msg, msg.scheduledAt + 5000)
    await recordAttempt(env.DB, msg.runId, 'failed', result(10), msg.scheduledAt + 5010)
    expect(await statsRows(task.id)).toMatchObject([{ failed: 1, delay_count: 0, delay_sum: 0 }])
  })

  it('counts a retried run once, as its final outcome', async () => {
    const task = await createTaskRow({ retry: { count: 1, intervalSeconds: 1 } })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('boom', { status: 500 }))
    const { env: e, sent } = envWithQueue()
    const msg = message(task.id)
    await processRun(msg, e)
    expect(await getRun(env.DB, msg.runId)).toMatchObject({ status: 'retrying' })
    expect(await statsRows(task.id)).toEqual([])

    await processRun(sent[0], e)
    expect(await getRun(env.DB, msg.runId)).toMatchObject({ status: 'failed', attempt: 2 })
    expect(totals(await statsRows(task.id))).toMatchObject({ success: 0, failed: 1 })
  })

  it('a late result for a run already closed as lost changes nothing and is not counted twice', async () => {
    const task = await createTaskRow({ alert: { mode: 'custom', url: 'https://alerts.test/hook' } })
    const msg = message(task.id)
    const startedAt = Date.now() - RUNNING_STALE_MS - 1000
    await claimRun(env.DB, { ...msg, scheduledAt: startedAt }, startedAt)
    expect(await markLostRuns(env.DB, Date.now())).toBe(1)
    expect(totals(await statsRows(task.id))).toMatchObject({ failed: 1 })

    expect(await recordAttempt(env.DB, msg.runId, 'success', result(5), Date.now())).toBe(false)
    expect(await getRun(env.DB, msg.runId)).toMatchObject({ status: 'failed' })
    expect(totals(await statsRows(task.id))).toMatchObject({ success: 0, failed: 1 })

  })

  it('does not alert when the run was closed as lost while executing', async () => {
    const task = await createTaskRow({ alert: { mode: 'custom', url: 'https://alerts.test/hook' } })
    const urls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new Request(input).url
      urls.push(url)
      // The lost-run sweep wins the race while the downstream call is in flight.
      if (url.startsWith('https://downstream.test')) await markLostRuns(env.DB, Date.now() + RUNNING_STALE_MS + 1000)
      return new Response('boom', { status: 500 })
    })
    const msg = message(task.id)
    await processRun(msg, envWithQueue().env)
    expect(urls).toEqual(['https://downstream.test/hook'])
    expect(await getRun(env.DB, msg.runId)).toMatchObject({ status: 'failed', httpStatus: null })
    expect(totals(await statsRows(task.id))).toMatchObject({ failed: 1 })
  })

  it('lost-run sweeps count each lost run once, without a duration', async () => {
    const task = await createTaskRow()
    const at = floorMinute(Date.now() - RUNNING_STALE_MS - 60_000) + 2000
    for (let i = 0; i < 3; i++) await claimRun(env.DB, message(task.id, { trigger: 'schedule', scheduledAt: at - 200 }), at)
    await claimRun(env.DB, message(task.id, { scheduledAt: at - 900 }), at) // manual: no delay
    await markLostRuns(env.DB, Date.now())
    await markLostRuns(env.DB, Date.now())
    expect(await statsRows(task.id)).toMatchObject([
      { failed: 4, duration_count: 0, delay_count: 3, delay_sum: 600, delay_max: 200 },
    ])
  })

  it('counts skipped runs', async () => {
    const task = await createTaskRow()
    const at = Date.UTC(2026, 9, 16, 3, 10)
    await insertSkippedRun(env.DB, { taskId: task.id, scheduledAt: at, reason: 'busy' }, at)
    await insertSkippedRun(env.DB, { taskId: task.id, scheduledAt: at + 1000, reason: 'busy' }, at + 1000)
    expect(await statsRows(task.id)).toMatchObject([{ bucket: Date.UTC(2026, 9, 16, 3, 10), skipped: 2, success: 0 }])
  })

  it('deleting a task deletes its stats', async () => {
    const task = await createTaskRow()
    await insertSkippedRun(env.DB, { taskId: task.id, scheduledAt: Date.now(), reason: 'busy' }, Date.now())
    await deleteTask(env.DB, task.id)
    expect(await statsRows(task.id)).toEqual([])
  })

  it('maintenance uses saved statistics retention independently of logs', async () => {
    const task = await createTaskRow()
    const now = Date.now()
    await insertSkippedRun(env.DB, { taskId: task.id, scheduledAt: now - 11 * DAY_MS, reason: 'old' }, now)
    await insertSkippedRun(env.DB, { taskId: task.id, scheduledAt: now - 9 * DAY_MS, reason: 'kept' }, now)
    await setRuntimeSettings({ statsRetentionDays: 10 })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const report = await runMaintenance(env, now)
    expect(report.purgedStats).toBe(1)
    expect(await statsRows(task.id)).toHaveLength(1)
  })

})

describe('stats API', () => {
  const AUTH = { authorization: `Bearer ${env.API_TOKEN}` }
  const get = (path: string) => app.request(`http://yunji-task.test/api${path}`, { headers: AUTH }, env)
  afterEach(() => vi.restoreAllMocks())

  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare('DELETE FROM run_stats'), env.DB.prepare('DELETE FROM runs')])
  })

  async function seed(taskId: string, outcomes: ('success' | 'failed')[], durationMs: number) {
    for (const outcome of outcomes) {
      const msg = message(taskId, { trigger: 'schedule', scheduledAt: Date.now() - 1000 })
      await claimRun(env.DB, msg, msg.scheduledAt + 200)
      await recordAttempt(env.DB, msg.runId, outcome, result(durationMs), Date.now())
    }
  }

  it('overview summarises all tasks with a zero-filled series and rankings', async () => {
    const fast = await createTaskRow({ name: 'fast' })
    const slow = await createTaskRow({ name: 'slow' })
    await seed(fast.id, ['success', 'success', 'success'], 20)
    await seed(slow.id, ['success', 'failed'], 3000)
    await insertSkippedRun(env.DB, { taskId: fast.id, scheduledAt: Date.now(), reason: 'busy' }, Date.now())

    const res = await get('/stats/overview?range=24h&tz=Asia/Shanghai')
    expect(res.status).toBe(200)
    const body = (await res.json()) as StatsOverview
    expect(body.summary).toMatchObject({ total: 6, success: 4, failed: 1, skipped: 1, successRate: 0.8, delayAvg: 200 })
    expect(body.summary.durationMax).toBe(3000)
    expect(body.series).toHaveLength(24)
    expect(body.series.reduce((s, p) => s + p.success + p.failed + p.skipped, 0)).toBe(6)
    expect(body.series[23]).toMatchObject({ success: 4, failed: 1 })
    expect(body.series[0]).toMatchObject({ success: 0, durationP95: null })
    expect(body.topFailing).toEqual([{ taskId: slow.id, name: 'slow', total: 2, failed: 1, successRate: 0.5, durationP95: expect.any(Number) }])
    expect(body.slowest.map((r) => r.name)).toEqual(['slow', 'fast'])
  })

  it('30d/90d use daily buckets', async () => {
    const body = (await (await get('/stats/overview?range=90d&tz=UTC')).json()) as StatsOverview
    expect(body.granularity).toBe('day')
    expect(body.series).toHaveLength(90)
  })

  it.each(['30d', '90d'] as const)('%s keeps fractional-timezone boundaries exact after run logs expire', async (range) => {
    const now = Date.UTC(2026, 10, 20, 12)
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const task = await createTaskRow()
    for (const tz of ['Asia/Kathmandu', 'Asia/Kolkata', 'America/St_Johns', 'Australia/Lord_Howe', 'Pacific/Chatham', '+05:17']) {
      await env.DB.batch([env.DB.prepare('DELETE FROM run_stats'), env.DB.prepare('DELETE FROM runs')])
      const window = statsWindow(range, now, tz)
      await insertSkippedRun(env.DB, { taskId: task.id, scheduledAt: window.from - 1, reason: 'outside' }, now)
      for (const [at, outcome] of [
        [window.from + 60_000, 'success'],
        [window.buckets[1] - 1, 'failed'],
        [window.buckets[1], 'success'],
      ] as const) {
        const msg = message(task.id, { scheduledAt: at })
        await claimRun(env.DB, msg, at)
        await recordAttempt(env.DB, msg.runId, outcome, result(120), at + 120)
      }
      await insertSkippedRun(env.DB, { taskId: task.id, scheduledAt: window.buckets[1] + 1000, reason: 'inside' }, now)
      await env.DB.prepare('DELETE FROM runs').run()

      const overview = (await (await get(`/stats/overview?range=${range}&tz=${encodeURIComponent(tz)}`)).json()) as StatsOverview
      const details = (await (await get(`/tasks/${task.id}/stats?range=${range}&tz=${encodeURIComponent(tz)}`)).json()) as TaskStats
      for (const body of [overview, details]) {
        expect(body.summary, tz).toMatchObject({ total: 4, success: 2, failed: 1, skipped: 1 })
        expect(body.series[0], tz).toMatchObject({ t: window.from, success: 1, failed: 1, skipped: 0 })
        expect(body.series[1], tz).toMatchObject({ t: window.buckets[1], success: 1, failed: 0, skipped: 1 })
        expect(body.series.reduce((sum, p) => sum + p.success + p.failed + p.skipped, 0), tz).toBe(4)
      }
      expect(overview.topFailing, tz).toMatchObject([{ taskId: task.id, total: 4, failed: 1 }])
      expect(details.histogram.reduce((sum, b) => sum + b.count, 0), tz).toBe(3)
    }
  })

  it('keeps runs on the right date through a half-hour DST transition', async () => {
    const now = Date.UTC(2026, 9, 16, 12)
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const task = await createTaskRow()
    const window = statsWindow('30d', now, 'Australia/Lord_Howe')
    const shortDay = window.buckets.findIndex((start, i) => window.buckets[i + 1] - start === 23.5 * HOUR_MS)
    expect(shortDay).toBeGreaterThanOrEqual(0)
    for (const at of [window.buckets[shortDay], window.buckets[shortDay + 1] - 1, window.buckets[shortDay + 1]]) {
      const msg = message(task.id, { scheduledAt: at })
      await claimRun(env.DB, msg, at)
      await recordAttempt(env.DB, msg.runId, 'success', result(10), at + 10)
    }
    const body = (await (await get(`/tasks/${task.id}/stats?range=30d&tz=Australia%2FLord_Howe`)).json()) as TaskStats
    expect(body.summary.success).toBe(3)
    expect(body.series[shortDay].success).toBe(2)
    expect(body.series[shortDay + 1].success).toBe(1)
  })

  it('task stats cover only that task and include the histogram', async () => {
    const a = await createTaskRow()
    const b = await createTaskRow()
    await seed(a.id, ['success', 'success'], 700)
    await seed(b.id, ['failed'], 10)
    const body = (await (await get(`/tasks/${a.id}/stats?range=7d`)).json()) as TaskStats
    expect(body.summary).toMatchObject({ total: 2, success: 2, failed: 0 })
    expect(body.series).toHaveLength(7 * 24)
    expect(body.histogram).toHaveLength(11)
    expect(body.histogram[4]).toEqual({ upTo: 1000, count: 2 })
    expect(body.histogram[10]).toEqual({ upTo: null, count: 0 })
  })

  it('validates range and timezone and 404s unknown tasks', async () => {
    expect((await get('/stats/overview?range=1y')).status).toBe(422)
    expect((await get('/stats/overview?tz=Mars/Base')).status).toBe(422)
    expect((await get('/tasks/nope/stats')).status).toBe(404)
  })
})
