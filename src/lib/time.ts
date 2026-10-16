export const DEFAULT_TIMEZONE = 'Asia/Shanghai'

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function zonedParts(epochMs: number, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(epochMs))
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

function offsetMs(epochMs: number, tz: string): number {
  const p = zonedParts(epochMs, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(epochMs / 1000) * 1000
}

/** Interpret a wall-clock time `YYYY-MM-DDTHH:mm[:ss]` in `tz` and return epoch ms. */
export function zonedTimeToEpoch(local: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local)
  if (!m) return null
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0))
  let result = guess - offsetMs(guess, tz)
  // Second pass corrects for DST transitions between the guess and the result.
  result = guess - offsetMs(result, tz)
  return result
}

/** Format epoch ms as `YYYY-MM-DD HH:mm:ss` in `tz`. */
export function formatInZone(epochMs: number, tz: string): string {
  const p = zonedParts(epochMs, tz)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
}

/** Format epoch ms as a `datetime-local` input value in `tz`. */
export function toDatetimeLocal(epochMs: number, tz: string): string {
  return formatInZone(epochMs, tz).replace(' ', 'T')
}
