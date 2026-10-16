import { claimRun, recordAttempt, type RunMessage } from '../domain/runs-repo'
import { getTask } from '../domain/tasks-repo'
import { resolveVariables } from '../domain/variables'
import { redact, referencedVariables } from '../lib/template'
import { sendFailureAlert } from './alert'
import { getExecutor } from './registry'
import type { ExecutionResult } from './types'

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

/** Execute one attempt of a run. Throws only on infrastructure errors (D1/queue). */
export async function processRun(msg: RunMessage, env: CloudflareBindings): Promise<void> {
  const task = await getTask(env.DB, msg.taskId)
  if (!task) {
    await destroyOrphanScheduler(env, msg)
    return
  }
  if (!(await claimRun(env.DB, msg, Date.now()))) return // duplicate delivery

  const executor = getExecutor(task.executor.type)
  let variables: Record<string, string> = {}
  let result: ExecutionResult
  try {
    const names = referencedVariables(...executor.templatedFields(task.executor.config))
    variables = await resolveVariables(env.DB, env.ENCRYPTION_KEY, names)
    result = await executor.execute(task.executor.config, variables)
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
    await releaseSlot(env, msg)
    return
  }
  if (msg.attempt <= task.retry.count) {
    if (await recordAttempt(env.DB, msg.runId, 'retrying', result, now)) {
      await env.RUN_QUEUE.send({ ...msg, attempt: msg.attempt + 1 }, { delaySeconds: task.retry.intervalSeconds })
    }
    return
  }
  const recorded = await recordAttempt(env.DB, msg.runId, 'failed', result, now)
  await releaseSlot(env, msg)
  // Not recorded: the run was already closed as lost; don't alert on an outcome the log doesn't show.
  if (!recorded) return
  await sendFailureAlert(env, task, {
    id: msg.runId,
    attempt: msg.attempt,
    trigger: msg.trigger,
    httpStatus: result.httpStatus,
    error: result.error,
    finishedAt: now,
  })
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
