import type { RunTrigger } from '../domain/runs-repo'
import { getAlertSettings } from '../domain/settings'
import type { Task } from '../domain/task'
import { resolveVariables } from '../domain/variables'
import { jsonStringEscape, redact, referencedVariables, renderTemplate } from '../lib/template'

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

/** Resolve the effective alert target: the task override, else the global default. */
export async function resolveAlertTarget(
  db: D1Database,
  task: AlertTask,
): Promise<{ url: string; bodyTemplate: string } | null> {
  if (task.alert.mode === 'off') return null
  if (task.alert.mode === 'custom') return { url: task.alert.url, bodyTemplate: task.alert.bodyTemplate }
  const global = await getAlertSettings(db)
  return global.url ? global : null
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

/** Called only from the independent action worker; failures are retried from the durable outbox. */
export async function sendFailureAlert(env: CloudflareBindings, task: AlertTask, run: FailedRun): Promise<void> {
  let secrets: string[] = []
  try {
    const target = await resolveAlertTarget(env.DB, task)
    if (!target) return
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
