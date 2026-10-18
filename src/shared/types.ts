// Types shared by the Worker and the admin SPA. Must not depend on Workers
// runtime types (D1Database, DurableObject, ...).

export type RunStatus = 'running' | 'retrying' | 'success' | 'failed' | 'skipped'
export type RunTrigger = 'schedule' | 'manual'

export interface Run {
  id: string
  taskId: string
  trigger: RunTrigger
  status: RunStatus
  attempt: number
  /** Actual transport and deadline for the current/latest attempt; skipped fires have neither. */
  executionMode: ExecutionMode | null
  effectiveTimeoutMs: number | null
  scheduledAt: number
  startedAt: number | null
  finishedAt: number | null
  durationMs: number | null
  httpStatus: number | null
  responseBody: string | null
  error: string | null
  createdAt: number
  updatedAt: number
}

export interface VariableInfo {
  name: string
  description: string
  createdAt: number
  updatedAt: number
}

export interface RunningSlot {
  runId: string
  leaseUntil: number
}

export interface SchedulerStatus {
  dispatchFailures: number
  terminalPending: number
  terminalExhausted: number
  version: number | null
  alarmAt: number | null
  running: RunningSlot | null
}

export interface AlertSettings {
  mode: 'webhook' | 'sender' | 'off'
  url: string
  bodyTemplate: string
  senderChannelGroup: string
}

export const BARK_ALERT_TEMPLATE = JSON.stringify({
  title: '云吉 Task: {{task.name}}',
  body: '{{run.error}}\nHTTP {{run.http_status}} | #{{run.attempt}} | {{run.finished_at}}',
  group: 'yunji-task',
}, null, 2)

export interface Issue {
  path: string
  message: string
}

export type AdminAuthMode = 'basic' | 'access'
export type ExecutionMode = 'queue' | 'direct' | 'worker'
/**
 * Worker mode runs in `waitUntil`, which may continue for 30 s after the
 * entrypoint returns; this leaves headroom for claiming, recording and reporting back.
 */
export const WORKER_MAX_TIMEOUT_MS = 25_000
/** A task's own setting; `inherit` follows the global runtime setting. */
export type TaskExecutionMode = 'inherit' | ExecutionMode

export interface RuntimeSettings {
  executionMode: ExecutionMode
  retentionDays: number
  statsRetentionDays: number
}

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  executionMode: 'worker',
  retentionDays: 30,
  statsRetentionDays: 90,
}

/** GET /admin/api/me */
export interface AdminMe extends RuntimeSettings {
  runtimeSettingsVersion: number
  user: string
  authMode: AdminAuthMode
  /** Whether the RUN_QUEUE binding is configured, i.e. tasks may use queue mode. */
  queueAvailable: boolean
  /** Available service bindings explicitly exposed to RPC tasks. */
  rpcBindings: string[]
  /** Whether the SENDER (Yunji Sender) service binding is configured. */
  senderAvailable: boolean
}

export type StatsRange = '24h' | '7d' | '30d' | '90d'
export type StatsGranularity = 'hour' | 'day'

/** Durations and delays are in ms; null when there are no samples. */
export interface StatsSummary {
  total: number
  success: number
  failed: number
  skipped: number
  /** success / (success + failed); skipped runs are excluded. */
  successRate: number | null
  durationAvg: number | null
  durationP50: number | null
  durationP95: number | null
  durationMax: number | null
  delayAvg: number | null
  delayMax: number | null
}

export interface StatsPoint {
  /** Bucket start (epoch ms). */
  t: number
  success: number
  failed: number
  skipped: number
  durationAvg: number | null
  durationP50: number | null
  durationP95: number | null
  delayAvg: number | null
  delayMax: number | null
}

export interface TaskStatsRow {
  taskId: string
  name: string
  total: number
  failed: number
  successRate: number | null
  durationP95: number | null
}

export interface DurationBucket {
  /** Inclusive upper bound in ms; null for the overflow bucket. */
  upTo: number | null
  count: number
}

interface StatsBase {
  range: StatsRange
  granularity: StatsGranularity
  from: number
  to: number
  summary: StatsSummary
  series: StatsPoint[]
}

/** GET /stats/overview */
export interface StatsOverview extends StatsBase {
  topFailing: TaskStatsRow[]
  slowest: TaskStatsRow[]
}

/** GET /tasks/:id/stats */
export interface TaskStats extends StatsBase {
  histogram: DurationBucket[]
}

/** Marks task-originated HTTP requests so trigger endpoints can reject cycles. */
export const RUN_HEADER = 'x-yunji-task-run'

export interface SafetySettings {
  paused: boolean
  taskDailyLimit: number
  globalDailyLimit: number
}

export const DEFAULT_SAFETY_SETTINGS: SafetySettings = {
  paused: false,
  taskDailyLimit: 10_000,
  globalDailyLimit: 100_000,
}
