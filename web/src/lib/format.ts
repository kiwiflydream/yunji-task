import type { BadgeVariant } from '@cloudflare/kumo'
import type { Task } from '../../../src/domain/task'
import { formatInZone } from '../../../src/lib/time'
import type { RunStatus } from '../../../src/shared/types'

/** Times are shown in the viewer's timezone; schedules keep their own. */
export const viewerTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone

export const fmtTime = (ms: number | null | undefined, tz = viewerTimezone) => (ms ? formatInZone(ms, tz) : '—')

export function fmtRelative(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '—'
  const diff = ms - now
  const abs = Math.abs(diff)
  const suffix = diff > 0 ? '后' : '前'
  if (abs < 5_000) return diff > 0 ? '即将' : '刚刚'
  if (abs < 60_000) return `${Math.round(abs / 1000)} 秒${suffix}`
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} 分钟${suffix}`
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)} 小时${suffix}`
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

export const fmtCount = (n: number) => n.toLocaleString('zh-CN')

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
  if (s.type === 'once') return `一次性 · ${fmtTime(s.runAt, s.timezone)}`
  return '仅手动 / API'
}
