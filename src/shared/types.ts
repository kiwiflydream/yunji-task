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
  version: number | null
  alarmAt: number | null
  running: RunningSlot | null
}

export interface AlertSettings {
  url: string
  bodyTemplate: string
}

export interface Issue {
  path: string
  message: string
}

export type AdminAuthMode = 'basic' | 'access'
export type ExecutionMode = 'queue' | 'direct'
/** A task's own setting; `inherit` follows EXECUTION_MODE. */
export type TaskExecutionMode = 'inherit' | ExecutionMode

/** GET /admin/api/me */
export interface AdminMe {
  user: string
  authMode: AdminAuthMode
  retentionDays: number
  statsRetentionDays: number
  /** The global default (EXECUTION_MODE). */
  executionMode: ExecutionMode
  /** Whether the RUN_QUEUE binding is configured, i.e. tasks may use queue mode. */
  queueAvailable: boolean
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
