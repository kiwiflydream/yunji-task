import type { Task, TaskInputRaw } from '../../../src/domain/task'
import { DEFAULT_TIMEZONE, toDatetimeLocal, zonedTimeToEpoch } from '../../../src/lib/time'
import type { Issue, TaskExecutionMode } from '../../../src/shared/types'
import { successConditionSchema, type SuccessCondition } from '../../../src/executor/success-condition'
import { newSuccessRule, successRuleToForm, successRuleToInput, type SuccessRuleForm } from './success-rules'

export interface HeaderRow {
  key: string
  value: string
}

export type ScheduleKind = 'cron' | 'once' | 'manual'
export type AlertMode = 'inherit' | 'off' | 'custom' | 'sender'

/** Editable form state; numbers stay strings until submit so inputs can be cleared. */
export interface TaskFormState {
  name: string
  description: string
  enabled: boolean
  scheduleType: ScheduleKind
  cron: string
  timezone: string
  runAt: string
  originalRunAt: number | null
  originalRunAtLocal: string
  originalTimezone: string
  method: string
  url: string
  headers: HeaderRow[]
  body: string
  timeoutSeconds: string
  successKeyword: string
  successMode: 'simple' | 'advanced'
  successMatch: 'all' | 'any'
  successRules: SuccessRuleForm[]
  overlapPolicy: 'skip' | 'parallel'
  retryCount: string
  retryIntervalSeconds: string
  alertMode: AlertMode
  alertUrl: string
  alertBodyTemplate: string
  alertChannelGroup: string
  executionMode: TaskExecutionMode
}

export type FormField = keyof TaskFormState

export const emptyTaskForm: TaskFormState = {
  name: '',
  description: '',
  enabled: true,
  scheduleType: 'cron',
  cron: '0 */5 * * * *',
  timezone: DEFAULT_TIMEZONE,
  runAt: '',
  originalRunAt: null,
  originalRunAtLocal: '',
  originalTimezone: '',
  method: 'GET',
  url: '',
  headers: [],
  body: '',
  timeoutSeconds: '25',
  successKeyword: '',
  successMode: 'simple',
  successMatch: 'all',
  successRules: [newSuccessRule('status')],
  overlapPolicy: 'skip',
  retryCount: '0',
  retryIntervalSeconds: '10',
  alertMode: 'inherit',
  alertUrl: '',
  alertBodyTemplate: '',
  alertChannelGroup: '',
  executionMode: 'inherit',
}

export function taskToForm(task: Task): TaskFormState {
  const s = task.schedule
  const cfg = task.executor.config
  const runAt = s.type === 'once' ? toDatetimeLocal(s.runAt, s.timezone) : ''
  return {
    name: task.name,
    description: task.description,
    enabled: task.enabled,
    scheduleType: s.type,
    cron: s.type === 'cron' ? s.cron : emptyTaskForm.cron,
    timezone: s.timezone,
    runAt,
    originalRunAt: s.type === 'once' && runAt !== '' ? s.runAt : null,
    originalRunAtLocal: runAt,
    originalTimezone: s.timezone,
    method: cfg.method,
    url: cfg.url,
    headers: Object.entries(cfg.headers).map(([key, value]) => ({ key, value })),
    body: cfg.body,
    timeoutSeconds: String(cfg.timeoutMs / 1000),
    successKeyword: cfg.successKeyword,
    successMode: cfg.successCondition ? 'advanced' : 'simple',
    successMatch: cfg.successCondition?.match ?? 'all',
    successRules: cfg.successCondition?.rules.map(successRuleToForm) ?? [newSuccessRule('status')],
    overlapPolicy: task.overlapPolicy,
    retryCount: String(task.retry.count),
    retryIntervalSeconds: String(task.retry.intervalSeconds),
    alertMode: task.alert.mode,
    alertUrl: task.alert.mode === 'custom' ? task.alert.url : '',
    alertBodyTemplate: task.alert.mode === 'custom' ? task.alert.bodyTemplate : '',
    alertChannelGroup: task.alert.mode === 'sender' ? task.alert.channelGroup : '',
    executionMode: task.executionMode,
  }
}

const num = (s: string) => (s.trim() === '' ? Number.NaN : Number(s))

/**
 * Build the API payload. Only problems the server cannot see (e.g. an
 * unparseable local date) are reported here; everything else is validated
 * server-side and mapped back with `mapIssues`.
 */
export function formToPayload(f: TaskFormState): { payload: TaskInputRaw } | { issues: Issue[] } {
  const issues: Issue[] = []
  const timezone = f.timezone.trim() || DEFAULT_TIMEZONE

  let schedule: TaskInputRaw['schedule']
  if (f.scheduleType === 'cron') schedule = { type: 'cron', cron: f.cron, timezone }
  else if (f.scheduleType === 'once') {
    const unchanged = f.originalRunAt !== null && f.runAt === f.originalRunAtLocal && timezone === f.originalTimezone
    const runAt = unchanged ? f.originalRunAt : zonedTimeToEpoch(f.runAt, timezone)
    if (runAt === null) issues.push({ path: 'schedule.runAt', message: f.runAt ? '执行时间无效或在所选时区不存在，请重新选择' : '请选择执行时间' })
    schedule = { type: 'once', runAt: runAt ?? 0, timezone }
  } else schedule = { type: 'manual', timezone }

  const headers: Record<string, string> = {}
  f.headers.forEach((h, i) => {
    const key = h.key.trim()
    if (!key && !h.value.trim()) return
    if (!key) issues.push({ path: 'executor.config.headers', message: `第 ${i + 1} 个请求头缺少名称` })
    else headers[key] = h.value
  })

  let successCondition: SuccessCondition | undefined
  if (f.successMode === 'advanced') {
    // Validate before JSON serialization can turn an invalid numeric input (NaN) into null.
    const parsed = successConditionSchema.safeParse({ match: f.successMatch, rules: f.successRules.map(successRuleToInput) })
    if (parsed.success) successCondition = parsed.data
    else issues.push(...parsed.error.issues.map((issue) => ({ path: `executor.config.successCondition.${issue.path.join('.')}`, message: issue.message })))
  }

  if (issues.length) return { issues }
  return {
    payload: {
      name: f.name,
      description: f.description,
      enabled: f.enabled,
      schedule,
      executor: {
        type: 'http',
        config: {
          url: f.url,
          method: f.method as 'GET',
          headers,
          body: f.body,
          timeoutMs: Math.round(num(f.timeoutSeconds) * 1000),
          successKeyword: f.successMode === 'simple' ? f.successKeyword : '',
          ...(successCondition ? { successCondition } : {}),
        },
      },
      overlapPolicy: f.overlapPolicy,
      retry: { count: num(f.retryCount), intervalSeconds: num(f.retryIntervalSeconds) },
      alert:
        f.alertMode === 'custom'
          ? { mode: 'custom', url: f.alertUrl, bodyTemplate: f.alertBodyTemplate }
          : f.alertMode === 'sender'
            ? { mode: 'sender', channelGroup: f.alertChannelGroup }
            : { mode: f.alertMode },
      executionMode: f.executionMode,
    },
  }
}

const PATH_TO_FIELD: [prefix: string, field: FormField][] = [
  ['name', 'name'],
  ['description', 'description'],
  ['schedule.cron', 'cron'],
  ['schedule.timezone', 'timezone'],
  ['schedule.runAt', 'runAt'],
  ['executor.config.url', 'url'],
  ['executor.config.method', 'method'],
  ['executor.config.headers', 'headers'],
  ['executor.config.body', 'body'],
  ['executor.config.timeoutMs', 'timeoutSeconds'],
  ['executor.config.successKeyword', 'successKeyword'],
  ['executor.config.successCondition', 'successRules'],
  ['overlapPolicy', 'overlapPolicy'],
  ['retry.count', 'retryCount'],
  ['retry.intervalSeconds', 'retryIntervalSeconds'],
  ['alert.url', 'alertUrl'],
  ['alert.bodyTemplate', 'alertBodyTemplate'],
  ['alert.channelGroup', 'alertChannelGroup'],
  ['executionMode', 'executionMode'],
]

/** The server validates milliseconds; the form edits seconds. */
const FIELD_MESSAGES: Partial<Record<FormField, string>> = {
  timeoutSeconds: '超时需在 1–300 秒之间',
}

/** Attach server issues to form fields; anything unmatched is returned for a banner. */
export function mapIssues(issues: Issue[]): { fields: Partial<Record<FormField, string>>; other: Issue[] } {
  const fields: Partial<Record<FormField, string>> = {}
  const other: Issue[] = []
  for (const issue of issues) {
    const hit = PATH_TO_FIELD.find(([prefix]) => issue.path === prefix || issue.path.startsWith(prefix + '.'))
    if (hit && !fields[hit[1]]) {
      const ruleIndex = hit[1] === 'successRules' ? issue.path.match(/\.rules\.(\d+)(?:\.|$)/)?.[1] : undefined
      fields[hit[1]] = FIELD_MESSAGES[hit[1]] ?? (ruleIndex === undefined ? issue.message : `第 ${Number(ruleIndex) + 1} 条条件：${issue.message}`)
    }
    else if (!hit) other.push(issue)
  }
  return { fields, other }
}
