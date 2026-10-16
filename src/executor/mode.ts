import { WORKER_MAX_TIMEOUT_MS, type ExecutionMode, type TaskExecutionMode } from '../shared/types'
import { getRuntimeSettings } from '../domain/settings'

export { WORKER_MAX_TIMEOUT_MS }

/**
 * The global runtime setting selects how runs reach the executor:
 * - `queue`: the scheduler DO enqueues a message; the queue consumer
 *   executes it and retries via delayed messages.
 * - `direct`: the scheduler DO executes runs itself (in `waitUntil`) and keeps
 *   pending retries in its own storage. No Queues needed, but the DO is billed
 *   for the wall time of each HTTP call.
 * - `worker` (default): the scheduler DO hands each run to the RunExecutor entrypoint
 *   over `ctx.exports`, which executes it in its own `waitUntil` (billed by CPU
 *   only). Retries are kept by the DO as in direct mode. Each request's timeout
 *   is capped at WORKER_MAX_TIMEOUT_MS to fit waitUntil's 30 s budget.
 */
export async function executionMode(env: Pick<CloudflareBindings, 'DB'>): Promise<ExecutionMode> {
  return (await getRuntimeSettings(env.DB)).executionMode
}

/** Whether the RUN_QUEUE binding is configured. */
export function hasRunQueue(env: CloudflareBindings): boolean {
  return !!(env as { RUN_QUEUE?: Queue }).RUN_QUEUE
}

/**
 * The mode a task's runs actually use: the task's own setting, else
 * the saved global runtime setting.
 * Timeout and binding availability never change the selected mode.
 */
export async function effectiveMode(
  env: CloudflareBindings,
  task: { executionMode: TaskExecutionMode; timeoutMs: number },
): Promise<ExecutionMode> {
  return task.executionMode === 'inherit' ? executionMode(env) : task.executionMode
}

/**
 * The run queue; fails with a clear message when queue mode is selected without
 * the binding. The only place that reads RUN_QUEUE, typed loosely so the code
 * still compiles after the "queues" section is removed and types regenerated.
 */
export function runQueue(env: CloudflareBindings): Queue {
  const queue = (env as { RUN_QUEUE?: Queue }).RUN_QUEUE
  if (!queue) {
    throw new Error('queue mode selected but the RUN_QUEUE binding is not configured (see wrangler.jsonc "queues")')
  }
  return queue
}
