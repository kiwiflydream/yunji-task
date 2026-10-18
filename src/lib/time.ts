export const DEFAULT_TIMEZONE = 'Asia/Shanghai'

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

// Bound caches because timezone strings and dates can come from API requests.
const formatters = new Map<string, Intl.DateTimeFormat>()
const offsetsByDay = new Map<string, number[]>()

function cacheSet<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): V {
  if (cache.size >= limit) cache.delete(cache.keys().next().value!)
  cache.set(key, value)
  return value
}

function formatter(tz: string): Intl.DateTimeFormat {
  const cached = formatters.get(tz)
  if (cached) return cached
  return cacheSet(formatters, tz, new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }), 64)
}

function zonedParts(epochMs: number, tz: string) {
  const parts = formatter(tz).formatToParts(new Date(epochMs))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  }
}

// Date.UTC treats years 0..99 as 1900..1999; calendar input must not do that.
function utcEpoch(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, 0)
  return date.getTime()
}

function wallEpoch(epochMs: number, tz: string): number {
  const p = zonedParts(epochMs, tz)
  return utcEpoch(p.year, p.month, p.day, p.hour, p.minute, p.second)
}

function offsetMs(epochMs: number, tz: string): number {
  return wallEpoch(epochMs, tz) - Math.floor(epochMs / 1000) * 1000
}

function parseLocal(local: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local)
  if (!m) return null
  const [year, month, day, hour, minute, second] = m.slice(1).map((s) => Number(s ?? 0))
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null
  const epoch = utcEpoch(year, month, day, hour, minute, second)
  const date = new Date(epoch)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? epoch : null
}

function nearbyOffsets(wall: number, tz: string): number[] {
  const day = Math.floor(wall / DAY_MS) * DAY_MS
  const key = `${tz}:${day}`
  const cached = offsetsByDay.get(key)
  if (cached) return cached
  const offsets = new Set<number>()
  // Enclose both sides of IANA transitions, including half-hour changes and
  // 24-hour date-line jumps. Six-hour probes avoid assuming a one-hour DST step.
  for (let at = day - 2 * DAY_MS; at <= day + 3 * DAY_MS; at += 6 * HOUR_MS) offsets.add(offsetMs(at, tz))
  return cacheSet(offsetsByDay, key, [...offsets], 512)
}

/**
 * Interpret `YYYY-MM-DDTHH:mm[:ss]` in `tz`. Invalid dates and DST gaps return
 * null; a repeated wall time deterministically selects the earlier instant.
 */
export function zonedTimeToEpoch(local: string, tz: string): number | null {
  const wall = parseLocal(local)
  if (wall === null) return null
  try {
    const matches = nearbyOffsets(wall, tz).map((offset) => wall - offset)
      .filter((epoch) => wallEpoch(epoch, tz) === wall)
    return matches.length ? Math.min(...matches) : null
  } catch {
    return null
  }
}

/**
 * First instant on a local calendar date. If midnight is skipped, use the
 * transition itself; if the entire date is skipped, use the following day's
 * start (a zero-length calendar bucket). Repeated midnights use the first one.
 */
export function startOfZonedDay(date: string, tz: string): number {
  const local = `${date}T00:00`
  const wall = parseLocal(local)
  if (wall === null) throw new RangeError('Invalid calendar date')
  const midnight = zonedTimeToEpoch(local, tz)
  if (midnight !== null) return midnight

  const candidates = nearbyOffsets(wall, tz).map((offset) => wall - offset).sort((a, b) => a - b)
  // A forward jump that skips midnight brackets the first valid instant:
  // one offset projects before the gap, the other projects after it. Search
  // the transition to second precision, without assuming its size or hour.
  for (let i = 1; i < candidates.length; i++) {
    let lo = candidates[i - 1]
    let hi = candidates[i]
    if (wallEpoch(lo, tz) >= wall || wallEpoch(hi, tz) < wall) continue
    while (hi - lo > 1000) {
      const mid = Math.floor((lo + hi) / 2000) * 1000
      if (wallEpoch(mid, tz) < wall) lo = mid
      else hi = mid
    }
    return hi
  }
  throw new RangeError('Unable to resolve calendar day in timezone')
}

/** Format epoch ms as `YYYY-MM-DD HH:mm:ss` in `tz`. */
export function formatInZone(epochMs: number, tz: string): string {
  const p = zonedParts(epochMs, tz)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${String(p.year).padStart(4, '0')}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
}

/** Format epoch ms as a `datetime-local` input value in `tz`. */
export function toDatetimeLocal(epochMs: number, tz: string): string {
  if (!Number.isFinite(new Date(epochMs).getTime())) return ''
  return formatInZone(epochMs, tz).replace(' ', 'T')
}
