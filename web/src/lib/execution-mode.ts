import { tr } from "../locale"
import { WORKER_MAX_TIMEOUT_MS, type AdminMe, type ExecutionMode, type TaskExecutionMode } from '../../../src/shared/types'
import { fmtDuration } from './format'

export const MODE_LABEL: Record<ExecutionMode, string> = { get queue() { return tr('队列') }, get direct() { return tr('直接执行') }, get worker() { return tr('Worker 异步') } }

export const WORKER_MAX_TIMEOUT_SECONDS = WORKER_MAX_TIMEOUT_MS / 1000

/**
 * Workers Paid overage per million runs, from the published prices.
 * - Queue: 3 queue operations ($0.40/M each) + 1 Worker request ($0.30/M); a
 *   Worker waiting on HTTP is not billed.
 * - Direct: the DO is billed 128 MB × wall time at $12.50 per million GB-s,
 *   i.e. ≈ $1.56 per million runs per second of waiting.
 * - Worker: 1 Worker request + 1 DO request ($0.15/M) to release the slot.
 */
export const QUEUE_COST_PER_MILLION = 1.5
export const DIRECT_COST_PER_MILLION_PER_SECOND = 1.5625
export const WORKER_COST_PER_MILLION = 0.45

/** Response time above which queue mode is cheaper than direct on Workers Paid. */
export const DIRECT_BREAK_EVEN_MS = 1000

type ModeContext = Pick<AdminMe, 'executionMode' | 'queueAvailable'>

/** Mirrors effectiveMode() on the server. */
export function effectiveTaskMode(taskMode: TaskExecutionMode, timeoutMs: number, me: ModeContext) {
  const mode = taskMode === 'inherit' ? me.executionMode : taskMode
  return {
    mode,
    timeoutMs: mode === 'worker' ? Math.min(timeoutMs, WORKER_MAX_TIMEOUT_MS) : timeoutMs,
    unavailable: mode === 'queue' && !me.queueAvailable,
  }
}

export function describeTaskMode(taskMode: TaskExecutionMode, timeoutMs: number, me: ModeContext): string {
  const { mode, unavailable } = effectiveTaskMode(taskMode, timeoutMs, me)
  if (unavailable) return tr("{0}（未配置 Queue，无法执行）", MODE_LABEL.queue)
  if (mode === 'worker' && timeoutMs > WORKER_MAX_TIMEOUT_MS) {
    return tr("{0}（{1}执行超时上限 {2} 秒）", MODE_LABEL.worker, taskMode === 'inherit' ? tr("跟随全局，") : '', WORKER_MAX_TIMEOUT_SECONDS)
  }
  return taskMode === 'inherit' ? tr("{0}（跟随全局）", MODE_LABEL[mode]) : MODE_LABEL[mode]
}

/** The cheapest mode for a task, as far as it can be told; null without enough data. */
export function suggestMode(p95: number | null, timeoutMs: number): ExecutionMode | null {
  if (timeoutMs <= WORKER_MAX_TIMEOUT_MS) return 'worker'
  if (p95 === null) return null
  return p95 < DIRECT_BREAK_EVEN_MS ? 'direct' : 'queue'
}

const fmtCost = (usd: number) => (usd < 0.1 ? tr("不到 $0.1") : tr("约 ${0}", usd.toFixed(1)))

const FREE_PLAN_NOTE = 'Free 套餐优先选「直接执行」：Queue 的免费额度每天只够约 3300 次执行。'
const FREE_ALLOWANCE_NOTE = '执行量在免费额度内时都不花钱。'

export function suggestionText(p95: number | null, timeoutMs: number, queueAvailable: boolean): string {
  const mode = suggestMode(p95, timeoutMs)
  const typical = p95 === null ? '' : tr("这个接口一般 {0} 返回（近 7 天 P95）。", fmtDuration(p95))
  if (mode === 'worker') {
    return (
      typical +
      tr("超时在 {0} 秒以内，建议「{1}」：等待由普通 Worker 承担、不按时长计费，", WORKER_MAX_TIMEOUT_SECONDS, MODE_LABEL.worker) +
      tr("每百万次约 ${0}，适合 Paid 和 Free 的短任务。{1}", WORKER_COST_PER_MILLION, tr(FREE_ALLOWANCE_NOTE))
    )
  }
  const noWorker = tr("超时超过 {0} 秒，不能用「{1}」。", WORKER_MAX_TIMEOUT_SECONDS, MODE_LABEL.worker)
  if (mode === null) {
    return tr("{0}还没有耗时数据。Paid 套餐：接口一般 1 秒内返回选「直接执行」，更慢选「队列」。{1}", noWorker, tr(FREE_PLAN_NOTE))
  }
  const direct = fmtCost((p95! / 1000) * DIRECT_COST_PER_MILLION_PER_SECOND)
  const lines = [
    noWorker,
    typical,
    tr("直接执行时这段等待按 DO 运行时长计费，每百万次{0}；走队列每百万次约 ${1}，", direct, QUEUE_COST_PER_MILLION),
    tr("所以 Paid 套餐建议「{0}」{1}。", MODE_LABEL[mode], mode === 'queue' && !queueAvailable ? tr("（但当前部署没有配置 Queue）") : ''),
    tr(FREE_ALLOWANCE_NOTE),
  ]
  if (mode === 'queue') lines.push(tr(FREE_PLAN_NOTE))
  return lines.join('')
}
