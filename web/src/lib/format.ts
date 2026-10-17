import { getLocale, tr } from '../locale'
import type { BadgeVariant } from '@cloudflare/kumo'
import type { Task } from '../../../src/domain/task'
import { formatInZone } from '../../../src/lib/time'
import type { RunStatus } from '../../../src/shared/types'

/** Times are shown in the viewer's timezone; schedules keep their own. */
export const viewerTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone

export function fmtTime(ms: number | null | undefined, tz = viewerTimezone) {
  if (ms == null) return '—'
  return getLocale() === 'zh-CN' ? formatInZone(ms, tz) : new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(ms)
}

export function fmtRelative(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '—'
  const diff = ms - now
  const abs = Math.abs(diff)
  if (abs < 5_000) return diff > 0 ? tr("即将") : tr("刚刚")
  const relative = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'always' })
  if (abs < 60_000) return relative.format(Math.round(diff / 1000), 'second')
  if (abs < 3_600_000) return relative.format(Math.round(diff / 60_000), 'minute')
  if (abs < 86_400_000) return relative.format(Math.round(diff / 3_600_000), 'hour')
  return fmtTime(ms)
}

export function fmtDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`
  const s = Math.round(ms / 1000)
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

/** Rates are floored so 99.96% never reads as 100%. */
export const fmtPercent = (rate: number | null) =>
  rate === null ? '—' : rate === 1 ? '100%' : `${(Math.floor(rate * 1000) / 10).toFixed(1)}%`

export const fmtCount = (n: number) => n.toLocaleString(getLocale() === 'en' ? 'en-US' : 'zh-CN')

/** Stats bucket label: `MM-DD HH:00` for hourly buckets, `MM-DD` for daily ones. */
export const fmtBucket = (ms: number, granularity: 'hour' | 'day') =>
  formatInZone(ms, viewerTimezone).slice(5, granularity === 'hour' ? 16 : 10)

export const RUN_STATUS: Record<RunStatus, { label: string; variant: BadgeVariant }> = {
  success: { label: '成功', variant: 'success' },
  failed: { label: '失败', variant: 'error' },
  running: { label: '执行中', variant: 'info' },
  retrying: { label: '等待重试', variant: 'warning' },
  skipped: { label: '已跳过', variant: 'neutral' },
}

export function scheduleSummary(task: Task): string {
  const s = task.schedule
  if (s.type === 'cron') return s.cron
  if (s.type === 'once') return tr("一次性 · {0}", fmtTime(s.runAt, s.timezone))
  return tr("仅手动 / API")
}
