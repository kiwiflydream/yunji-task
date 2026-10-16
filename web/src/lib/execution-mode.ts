import type { AdminMe, ExecutionMode, TaskExecutionMode } from '../../../src/shared/types'
import { fmtDuration } from './format'

export const MODE_LABEL: Record<ExecutionMode, string> = { queue: '队列', direct: '直接执行' }

/**
 * Average response time above which queue mode is cheaper: a Worker waiting on
 * HTTP is not billed, a Durable Object is (≈ $1.56 per million runs per second
 * of waiting vs ≈ $1.5 per million runs for queue operations + Worker request).
 */
export const DIRECT_BREAK_EVEN_MS = 1000

type ModeContext = Pick<AdminMe, 'executionMode' | 'queueAvailable'>

/** Mirrors effectiveMode() on the server. */
export function effectiveTaskMode(taskMode: TaskExecutionMode, me: ModeContext) {
  const wanted = taskMode === 'inherit' ? me.executionMode : taskMode
  const fallback = wanted === 'queue' && !me.queueAvailable
  return { mode: fallback ? ('direct' as const) : wanted, fallback }
}

export function describeTaskMode(taskMode: TaskExecutionMode, me: ModeContext): string {
  const { mode, fallback } = effectiveTaskMode(taskMode, me)
  if (fallback) return `${MODE_LABEL.direct}（未配置 Queue，已回退）`
  return taskMode === 'inherit' ? `${MODE_LABEL[mode]}（跟随全局）` : MODE_LABEL[mode]
}

/** The cheaper mode for a task whose runs take `p95` ms; null without data. */
export function suggestMode(p95: number | null): ExecutionMode | null {
  if (p95 === null) return null
  return p95 < DIRECT_BREAK_EVEN_MS ? 'direct' : 'queue'
}

export function suggestionText(p95: number | null, queueAvailable: boolean): string {
  const mode = suggestMode(p95)
  if (mode === null) return '还没有耗时数据。接口一般在 1 秒内响应时，「直接执行」更便宜。'
  const head = `近 7 天 P95 耗时 ${fmtDuration(p95)}，建议「${MODE_LABEL[mode]}」`
  if (mode === 'direct') return `${head}：低于 1 秒时比队列便宜。`
  return `${head}：直接执行要为等待时间支付 DO 时长费用，慢接口走队列更便宜${queueAvailable ? '' : '（但当前部署没有配置 Queue）'}。`
}
