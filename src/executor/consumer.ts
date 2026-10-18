import { claimRun, recordAttempt, type RunMessage } from '../domain/runs-repo'
import { getTask } from '../domain/tasks-repo'
import { resolveVariables } from '../domain/variables'
import { redact, referencedVariables } from '../lib/template'
import { deliverAction, recoverRunActions } from './actions'
import type { RunAction } from '../domain/actions-repo'
import type { ExecutionMode } from '../shared/types'
import { runQueue } from './mode'
import { getExecutor } from './registry'
import type { ExecutionResult } from './types'
import { resolveAlertTarget, targetToAlert } from './alert'

export async function handleRunBatch(batch: MessageBatch<RunMessage>, env: CloudflareBindings): Promise<void> {
  await Promise.all(
    batch.messages.map(async (message) => {
      try {
        await processRun(message.body, env)
        message.ack()
      } catch (err) {
        console.error('run processing failed', message.body.runId, err)
        message.retry()
      }
    }),
  )
}

/**
 * What differs between execution modes once an attempt has a result. Queue
 * mode talks to the queue and the task's scheduler DO; direct mode runs inside
 * that DO and handles all three locally.
 */
export interface RunTransport {
  mode: ExecutionMode
  /** Schedule `next` (the following attempt) to run after `delaySeconds`. */
  retry(next: RunMessage, delaySeconds: number): Promise<void>
  /** The run reached a final outcome: free the skip-mode slot. Best effort. */
  finished(msg: RunMessage): Promise<void>
  /** The task no longer exists: stop its scheduler. Best effort. */
  orphaned(msg: RunMessage): Promise<void>
}

export function queueTransport(env: CloudflareBindings): RunTransport {
  return {
    mode: 'queue',
    retry: async (next, delaySeconds) => {
      await runQueue(env).send(next, { delaySeconds })
    },
    finished: (msg) => releaseSlot(env, msg),
    orphaned: (msg) => destroyOrphanScheduler(env, msg),
  }
}

/** Execute one attempt of a run. Throws only on infrastructure errors (D1/queue). */
export async function processRun(
  msg: RunMessage,
  env: CloudflareBindings,
  transport: RunTransport = queueTransport(env),
  maxTimeoutMs?: number,
): Promise<void> {
  const task = await getTask(env.DB, msg.taskId)
  if (!task) {
    await transport.orphaned(msg)
    return
  }
  const config = maxTimeoutMs === undefined
    ? task.executor.config
    : { ...task.executor.config, timeoutMs: Math.min(task.executor.config.timeoutMs, maxTimeoutMs) }
  if (!(await claimRun(env.DB, msg, Date.now(), { executionMode: transport.mode, effectiveTimeoutMs: config.timeoutMs }))) {
    await recoverRunActions(env, msg.runId, transport)
    return
  }

  const executor = getExecutor(task.executor.type)
  let variables: Record<string, string> = {}
  let result: ExecutionResult
  try {
    const names = referencedVariables(...executor.templatedFields(task.executor.config))
    variables = await resolveVariables(env.DB, env.ENCRYPTION_KEY, names)
    result = await executor.execute(config, variables, { env, run: msg })
  } catch (err) {
    result = {
      ok: false,
      httpStatus: null,
      responseBody: null,
      error: err instanceof Error ? err.message : String(err),
      durationMs: 0,
    }
  }
  const secrets = Object.values(variables)
  result = {
    ...result,
    responseBody: result.responseBody === null ? null : redact(result.responseBody, secrets),
    error: result.error === null ? null : redact(result.error, secrets),
  }

  const now = Date.now()
  if (result.ok) {
    await recordAttempt(env.DB, msg.runId, 'success', result, now)
    await transport.finished(msg)
    return
  }
  if (msg.attempt <= task.retry.count) {
    const action: RunAction = {
      id: `${msg.runId}:retry:${msg.attempt + 1}`, taskId: task.id, runId: msg.runId, dueAt: now, attempts: 0,
      payload: { kind: 'retry', msg: { ...msg, attempt: msg.attempt + 1 }, mode: transport.mode,
        runAt: now + task.retry.intervalSeconds * 1000 },
    }
    if (await recordAttempt(env.DB, msg.runId, 'retrying', result, now, action)) {
      await deliverAction(action.id, env, transport)
    }
    return
  }
  const alertTarget = await resolveAlertTarget(env.DB, task)
  const action: RunAction | undefined = !alertTarget ? undefined : {
    id: `${msg.runId}:alert`, taskId: task.id, runId: msg.runId, dueAt: now, attempts: 0,
    payload: { kind: 'alert', task: { id: task.id, name: task.name, alert: targetToAlert(alertTarget) }, run: {
      id: msg.runId, attempt: msg.attempt, trigger: msg.trigger,
      httpStatus: result.httpStatus, error: result.error, finishedAt: now,
    } },
  }
  const recorded = await recordAttempt(env.DB, msg.runId, 'failed', result, now, action)
  await transport.finished(msg)
  // Not recorded: the run was already closed as lost; don't alert on an outcome the log doesn't show.
  if (!recorded) return
  if (action) await env.TASK_SCHEDULER.getByName(task.id).scheduleAction(action.id, now)
}

/** Free the skip-mode slot in the task's scheduler. Best effort: the lease expires anyway. */
async function releaseSlot(env: CloudflareBindings, msg: RunMessage): Promise<void> {
  if (msg.trigger !== 'schedule') return
  try {
    await env.TASK_SCHEDULER.getByName(msg.taskId).complete(msg.runId)
  } catch (err) {
    console.error('failed to release scheduler slot', msg.taskId, err)
  }
}

/** A scheduled message for a deleted task means its DO outlived the task; stop it. */
async function destroyOrphanScheduler(env: CloudflareBindings, msg: RunMessage): Promise<void> {
  if (msg.trigger !== 'schedule') return
  try {
    await env.TASK_SCHEDULER.getByName(msg.taskId).destroy()
  } catch (err) {
    console.error('failed to destroy orphan scheduler', msg.taskId, err)
  }
}
