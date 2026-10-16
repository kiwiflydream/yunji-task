// Pure statistics helpers: duration histogram, percentile estimation and
// bucketing of hourly aggregates into chart series. No D1 access here.
import type {
  DurationBucket,
  StatsGranularity,
  StatsPoint,
  StatsRange,
  StatsSummary,
  TaskStatsRow,
} from '../shared/types'
import { zonedTimeToEpoch } from '../lib/time'

export const STATS_RANGES = ['24h', '7d', '30d', '90d'] as const satisfies readonly StatsRange[]

/** Inclusive upper bounds (ms) of the duration histogram; a final overflow bucket follows. */
export const DURATION_BOUNDS = [50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000] as const
export const BUCKET_COUNT = DURATION_BOUNDS.length + 1

export const HOUR_MS = 60 * 60_000

export function bucketIndex(durationMs: number): number {
  const i = DURATION_BOUNDS.findIndex((bound) => durationMs <= bound)
  return i === -1 ? DURATION_BOUNDS.length : i
}

export function floorHour(epochMs: number): number {
  return epochMs - (epochMs % HOUR_MS)
}

/** Additive aggregate of any number of hourly rows. */
export interface Agg {
  success: number
  failed: number
  skipped: number
  durationCount: number
  durationSum: number
  durationMax: number
  buckets: number[]
  delayCount: number
  delaySum: number
  delayMax: number
}

export function emptyAgg(): Agg {
  return {
    success: 0,
    failed: 0,
    skipped: 0,
    durationCount: 0,
    durationSum: 0,
    durationMax: 0,
    buckets: new Array(BUCKET_COUNT).fill(0),
    delayCount: 0,
    delaySum: 0,
    delayMax: 0,
  }
}

export function addAgg(into: Agg, a: Agg): Agg {
  into.success += a.success
  into.failed += a.failed
  into.skipped += a.skipped
  into.durationCount += a.durationCount
  into.durationSum += a.durationSum
  into.durationMax = Math.max(into.durationMax, a.durationMax)
  a.buckets.forEach((n, i) => (into.buckets[i] += n))
  into.delayCount += a.delayCount
  into.delaySum += a.delaySum
  into.delayMax = Math.max(into.delayMax, a.delayMax)
  return into
}

/**
 * Estimate the q-quantile (0..1) of durations by linear interpolation inside
 * the histogram bucket that contains it. The overflow bucket is bounded by the
 * observed maximum. Returns null without samples.
 */
export function percentile(agg: Agg, q: number): number | null {
  const total = agg.buckets.reduce((s, n) => s + n, 0)
  if (total === 0) return null
  const target = q * total
  let cumulative = 0
  for (let i = 0; i < agg.buckets.length; i++) {
    const n = agg.buckets[i]
    if (n === 0 || cumulative + n < target) {
      cumulative += n
      continue
    }
    const lower = i === 0 ? 0 : DURATION_BOUNDS[i - 1]
    const upper = i < DURATION_BOUNDS.length ? DURATION_BOUNDS[i] : Math.max(agg.durationMax, lower)
    const value = lower + ((upper - lower) * (target - cumulative)) / n
    return Math.round(Math.min(value, agg.durationMax))
  }
  return agg.durationMax
}

const avg = (sum: number, count: number) => (count === 0 ? null : Math.round(sum / count))

export function summarize(agg: Agg): StatsSummary {
  const finished = agg.success + agg.failed
  return {
    total: finished + agg.skipped,
    success: agg.success,
    failed: agg.failed,
    skipped: agg.skipped,
    successRate: finished === 0 ? null : agg.success / finished,
    durationAvg: avg(agg.durationSum, agg.durationCount),
    durationP50: percentile(agg, 0.5),
    durationP95: percentile(agg, 0.95),
    durationMax: agg.durationCount === 0 ? null : agg.durationMax,
    delayAvg: avg(agg.delaySum, agg.delayCount),
    delayMax: agg.delayCount === 0 ? null : agg.delayMax,
  }
}

export interface StatsWindow {
  range: StatsRange
  granularity: StatsGranularity
  from: number
  to: number
  /** Ascending bucket start times; the last bucket contains `to`. */
  buckets: number[]
}

/** Local calendar date (`YYYY-MM-DD`) of `epochMs` in `tz`. */
function localDate(epochMs: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(epochMs),
  )
}

/**
 * 24h / 7d are hourly (UTC hours, which are local hours for whole-hour
 * offsets); 30d / 90d are local calendar days in `tz`, today included.
 */
export function statsWindow(range: StatsRange, now: number, tz: string): StatsWindow {
  if (range === '24h' || range === '7d') {
    const hours = range === '24h' ? 24 : 7 * 24
    const last = floorHour(now)
    const buckets = Array.from({ length: hours }, (_, i) => last - (hours - 1 - i) * HOUR_MS)
    return { range, granularity: 'hour', from: buckets[0], to: now, buckets }
  }
  const days = range === '30d' ? 30 : 90
  const [y, m, d] = localDate(now, tz).split('-').map(Number)
  const buckets = Array.from({ length: days }, (_, i) => {
    const date = new Date(Date.UTC(y, m - 1, d - (days - 1 - i))).toISOString().slice(0, 10)
    return zonedTimeToEpoch(`${date}T00:00`, tz)!
  })
  return { range, granularity: 'day', from: buckets[0], to: now, buckets }
}

/** Assign each hourly aggregate to the window bucket containing it; empty buckets stay zero. */
export function bucketize(window: StatsWindow, hourly: { hour: number; agg: Agg }[]): Agg[] {
  const out = window.buckets.map(() => emptyAgg())
  const { buckets } = window
  for (const { hour, agg } of hourly) {
    if (hour < window.from || hour > window.to) continue
    // Last bucket whose start is <= hour.
    let lo = 0
    let hi = buckets.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (buckets[mid] <= hour) lo = mid
      else hi = mid - 1
    }
    addAgg(out[lo], agg)
  }
  return out
}

export function toPoints(window: StatsWindow, aggs: Agg[]): StatsPoint[] {
  return aggs.map((agg, i) => {
    const s = summarize(agg)
    return {
      t: window.buckets[i],
      success: s.success,
      failed: s.failed,
      skipped: s.skipped,
      durationAvg: s.durationAvg,
      durationP50: s.durationP50,
      durationP95: s.durationP95,
      delayAvg: s.delayAvg,
      delayMax: s.delayMax,
    }
  })
}

export function histogram(agg: Agg): DurationBucket[] {
  return agg.buckets.map((count, i) => ({ upTo: i < DURATION_BOUNDS.length ? DURATION_BOUNDS[i] : null, count }))
}

export const RANKING_SIZE = 5

/** Tasks with the most failures, and tasks with the highest P95 duration. */
export function rankTasks(rows: { taskId: string; name: string; agg: Agg }[]): {
  topFailing: TaskStatsRow[]
  slowest: TaskStatsRow[]
} {
  const all = rows.map(({ taskId, name, agg }): TaskStatsRow => {
    const s = summarize(agg)
    return {
      taskId,
      name,
      total: s.total,
      failed: s.failed,
      successRate: s.successRate,
      durationP95: s.durationP95,
    }
  })
  const topFailing = all
    .filter((r) => r.failed > 0)
    .sort((a, b) => b.failed - a.failed || (a.successRate ?? 1) - (b.successRate ?? 1))
    .slice(0, RANKING_SIZE)
  const slowest = all
    .filter((r) => r.durationP95 !== null)
    .sort((a, b) => b.durationP95! - a.durationP95!)
    .slice(0, RANKING_SIZE)
  return { topFailing, slowest }
}
