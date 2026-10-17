import type { RunTrigger } from '../domain/runs-repo'
import { getAlertSettings } from '../domain/settings'
import type { Task } from '../domain/task'
import { resolveVariables } from '../domain/variables'
import { jsonStringEscape, redact, referencedVariables, renderTemplate } from '../lib/template'
import { senderService } from './sender'

export interface FailedRun {
  id: string
  attempt: number
  trigger: RunTrigger
  httpStatus: number | null
  error: string | null
  finishedAt: number
}

export type AlertTask = Pick<Task, 'id' | 'name' | 'alert'>

const ALERT_TIMEOUT_MS = 10_000

export type AlertTarget =
  | { kind: 'webhook'; url: string; bodyTemplate: string }
  | { kind: 'sender'; topic: string }

/** Resolve the task override, else the explicitly selected global target. */
export async function resolveAlertTarget(
  db: D1Database,
  task: AlertTask,
): Promise<AlertTarget | null> {
  if (task.alert.mode === 'off') return null
  if (task.alert.mode === 'custom') return { kind: 'webhook', url: task.alert.url, bodyTemplate: task.alert.bodyTemplate }
  if (task.alert.mode === 'sender') return { kind: 'sender', topic: task.alert.topic }
  const global = await getAlertSettings(db)
  if (global.mode === 'off') return null
  if (global.mode === 'sender') return { kind: 'sender', topic: global.senderTopic }
  return global.url ? { kind: 'webhook', url: global.url, bodyTemplate: global.bodyTemplate } : null
}

/** The persisted form of a resolved target, so a queued alert keeps the target chosen at failure time. */
export function targetToAlert(target: AlertTarget): AlertTask['alert'] {
  return target.kind === 'sender'
    ? { mode: 'sender', topic: target.topic }
    : { mode: 'custom', url: target.url, bodyTemplate: target.bodyTemplate }
}

export function defaultAlertPayload(task: AlertTask, run: FailedRun) {
  return {
    event: 'task.failed',
    task: { id: task.id, name: task.name },
    run: {
      id: run.id,
      attempt: run.attempt,
      trigger: run.trigger,
      httpStatus: run.httpStatus,
      error: run.error,
      finishedAt: new Date(run.finishedAt).toISOString(),
    },
  }
}

const TRIGGER_LABEL = { schedule: '定时', manual: '手动' } as const

/** Markdown alert for cf-sender; values are inline code so task output cannot inject formatting. */
export function senderAlertMessage(task: AlertTask, run: FailedRun) {
  const code = (v: string) => `\`${v.replace(/`/g, "'").replace(/\s+/g, ' ').slice(0, 500)}\``
  return {
    title: `任务失败：${task.name}`,
    body: [
      `- 错误：${code(run.error ?? '未知错误')}`,
      run.httpStatus === null ? null : `- HTTP 状态：${run.httpStatus}`,
      `- 第 ${run.attempt} 次尝试 · ${TRIGGER_LABEL[run.trigger]}触发`,
      `- 结束时间：${new Date(run.finishedAt).toISOString()}`,
      `- 任务 ID：${code(task.id)} · 执行 ID：${code(run.id)}`,
    ]
      .filter((l) => l !== null)
      .join('\n'),
    format: 'markdown' as const,
    level: 'error' as const,
    tags: ['yunji-task'],
  }
}

/** Called only from the independent action worker; failures are retried from the durable outbox. */
export async function sendFailureAlert(env: CloudflareBindings, task: AlertTask, run: FailedRun): Promise<void> {
  const target = await resolveAlertTarget(env.DB, task)
  if (!target) return
  if (target.kind === 'sender') {
    const sender = senderService(env)
    if (!sender) throw new Error('alert targets cf-sender but the SENDER service binding is not configured (see wrangler.jsonc "services")')
    // The key makes outbox retries safe: cf-sender returns the first message instead of sending again.
    await sender.send({ topic: target.topic, ...senderAlertMessage(task, run) }, { idempotencyKey: `yunji-task:alert:${run.id}` })
    return
  }
  await sendWebhookAlert(env, target, task, run)
}

async function sendWebhookAlert(
  env: CloudflareBindings,
  target: Extract<AlertTarget, { kind: 'webhook' }>,
  task: AlertTask,
  run: FailedRun,
): Promise<void> {
  let secrets: string[] = []
  try {
    const variables = await resolveVariables(
      env.DB,
      env.ENCRYPTION_KEY,
      referencedVariables(target.url, target.bodyTemplate),
    )
    secrets = Object.values(variables)
    const builtins: Record<string, string> = {
      'task.id': task.id,
      'task.name': task.name,
      'run.id': run.id,
      'run.status': 'failed',
      'run.attempt': String(run.attempt),
      'run.trigger': run.trigger,
      'run.http_status': run.httpStatus === null ? '' : String(run.httpStatus),
      'run.error': run.error ?? '',
      'run.finished_at': new Date(run.finishedAt).toISOString(),
    }
    const body = target.bodyTemplate
      ? renderTemplate(target.bodyTemplate, { ...variables, ...builtins }, jsonStringEscape)
      : JSON.stringify(defaultAlertPayload(task, run))
    const res = await fetch(renderTemplate(target.url, variables), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    })
    await res.body?.cancel()
    if (!res.ok) throw new Error(`alert webhook returned HTTP ${res.status}`)
  } catch (err) {
    throw new Error(redact(err instanceof Error ? err.message : String(err), secrets))
  }
}
