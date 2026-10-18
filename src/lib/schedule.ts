import { Cron } from 'croner'

/** workerd converts alarm dates to signed 64-bit nanoseconds. */
export const MAX_ALARM_TIME_MS = 9_223_372_036_854

export type ScheduleType = 'cron' | 'once' | 'manual'

export interface ScheduleSpec {
  scheduleType: ScheduleType
  cron: string | null
  timezone: string
  runAt: number | null
}

export function parseCron(pattern: string, timezone: string): Cron {
  return new Cron(pattern.trim(), { timezone, mode: '6-part', paused: true })
}

/** Returns an error message, or null if the 6-field pattern is valid. */
export function validateCron(pattern: string, timezone: string): string | null {
  try {
    parseCron(pattern, timezone)
    return null
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const parts = pattern.trim().split(/\s+/).length
    if (/requires exactly 6 parts|exactly five, six, or seven/.test(message)) {
      return `需要 6 段（秒 分 时 日 月 周），当前是 ${parts} 段`
    }
    return `无效的 cron 表达式：${message}`
  }
}

/** Next fire time strictly after `after` (epoch ms), or null if the schedule never fires again. */
export function nextFireTime(spec: ScheduleSpec, after: number): number | null {
  switch (spec.scheduleType) {
    case 'cron': {
      if (!spec.cron) return null
      return parseCron(spec.cron, spec.timezone).nextRun(new Date(after))?.getTime() ?? null
    }
    case 'once':
      return spec.runAt
    case 'manual':
      return null
  }
}
