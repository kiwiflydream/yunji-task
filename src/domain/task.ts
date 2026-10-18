import { z } from 'zod'
import { executorSpecSchema, type ExecutorSpec } from '../executor/registry'
import { MAX_ALARM_TIME_MS, validateCron, type ScheduleSpec, type ScheduleType } from '../lib/schedule'
import { DEFAULT_TIMEZONE, isValidTimezone } from '../lib/time'
import type { TaskExecutionMode } from '../shared/types'

// Validation messages surface in the (Chinese) admin UI.
z.config(z.locales.zhCN())

export type OverlapPolicy = 'skip' | 'parallel'

const timezoneSchema = z
  .string()
  .trim()
  .default(DEFAULT_TIMEZONE)
  .refine(isValidTimezone, '无效的 IANA 时区')

const runAtSchema = z.union([
  z.number().int().positive(),
  z.iso.datetime({ offset: true }).transform((s) => Date.parse(s)),
]).pipe(z.number().int().positive().max(MAX_ALARM_TIME_MS, '执行时间超出支持范围'))

export const scheduleSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('cron'), cron: z.string().trim().min(1), timezone: timezoneSchema }),
    z.object({ type: z.literal('once'), runAt: runAtSchema, timezone: timezoneSchema }),
    z.object({ type: z.literal('manual'), timezone: timezoneSchema }),
  ])
  .superRefine((s, ctx) => {
    if (s.type !== 'cron' || !isValidTimezone(s.timezone)) return
    const err = validateCron(s.cron, s.timezone)
    if (err) ctx.addIssue({ code: 'custom', path: ['cron'], message: err })
  })

/** Channel-group slug, matching Yunji Sender. */
export const SENDER_CHANNEL_GROUP_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const senderChannelGroupSchema = z.string().trim().regex(SENDER_CHANNEL_GROUP_RE, '渠道组标识只能包含小写字母、数字、点、下划线和连字符')

export const alertSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('inherit') }),
  z.strictObject({ mode: z.literal('off') }),
  z.strictObject({
    mode: z.literal('custom'),
    url: z.string().trim().min(1).max(2048),
    bodyTemplate: z.string().max(8000).default(''),
  }),
  z.strictObject({ mode: z.literal('sender'), channelGroup: senderChannelGroupSchema }),
])

export const taskInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).default(''),
  enabled: z.boolean().default(true),
  schedule: scheduleSchema,
  executor: executorSpecSchema,
  overlapPolicy: z.enum(['skip', 'parallel']).default('skip'),
  retry: z
    .object({
      count: z.number().int().min(0).max(10).default(0),
      intervalSeconds: z.number().int().min(1).max(3600).default(10),
    })
    .default({ count: 0, intervalSeconds: 10 }),
  alert: alertSchema.default({ mode: 'inherit' }),
  executionMode: z.enum(['inherit', 'queue', 'direct', 'worker']).default('inherit'),
})

export type TaskInput = z.output<typeof taskInputSchema>
export type TaskInputRaw = z.input<typeof taskInputSchema>
export type Schedule = z.output<typeof scheduleSchema>
export type AlertConfig = z.output<typeof alertSchema>

export interface Task extends TaskInput {
  id: string
  version: number
  createdAt: number
  updatedAt: number
}

export interface TaskSummary extends Task {
  lastRunAt: number | null
  lastStatus: string | null
}

export interface TaskRow {
  id: string
  name: string
  description: string
  enabled: number
  schedule_type: ScheduleType
  cron: string | null
  timezone: string
  run_at: number | null
  executor_type: string
  executor_config: string
  overlap_policy: OverlapPolicy
  retry_count: number
  retry_interval_seconds: number
  alert_config: string
  execution_mode: TaskExecutionMode
  version: number
  created_at: number
  updated_at: number
}

export function rowToTask(row: TaskRow): Task {
  let schedule: Schedule
  if (row.schedule_type === 'cron') schedule = { type: 'cron', cron: row.cron ?? '', timezone: row.timezone }
  else if (row.schedule_type === 'once') schedule = { type: 'once', runAt: row.run_at ?? 0, timezone: row.timezone }
  else schedule = { type: 'manual', timezone: row.timezone }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled === 1,
    schedule,
    executor: { type: row.executor_type, config: JSON.parse(row.executor_config) } as ExecutorSpec,
    overlapPolicy: row.overlap_policy,
    retry: { count: row.retry_count, intervalSeconds: row.retry_interval_seconds },
    alert: alertSchema.parse(JSON.parse(row.alert_config)),
    executionMode: row.execution_mode,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function scheduleSpec(task: Pick<Task, 'schedule'>): ScheduleSpec {
  const s = task.schedule
  return {
    scheduleType: s.type,
    cron: s.type === 'cron' ? s.cron : null,
    timezone: s.timezone,
    runAt: s.type === 'once' ? s.runAt : null,
  }
}

/** What a TaskScheduler DO needs to know about a task. */
export interface ScheduleSnapshot extends ScheduleSpec {
  taskId: string
  version: number
  enabled: boolean
  overlapPolicy: OverlapPolicy
  /** How long a dispatched run may hold the skip-mode "running" slot. */
  leaseMs: number
  executionMode: TaskExecutionMode
  /** The configured executor timeout; worker execution caps it at 25 seconds. */
  timeoutMs: number
}

export function toSnapshot(task: Task): ScheduleSnapshot {
  const timeoutMs = task.executor.config.timeoutMs
  const leaseMs = (timeoutMs + task.retry.intervalSeconds * 1000) * (task.retry.count + 1) + 60_000
  return {
    ...scheduleSpec(task),
    taskId: task.id,
    version: task.version,
    enabled: task.enabled,
    overlapPolicy: task.overlapPolicy,
    leaseMs,
    executionMode: task.executionMode,
    timeoutMs,
  }
}
