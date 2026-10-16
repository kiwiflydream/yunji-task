import type { ExecutionMode } from '../shared/types'

/**
 * EXECUTION_MODE selects how runs reach the executor:
 * - `queue` (default): the scheduler DO enqueues a message; the queue consumer
 *   executes it and retries via delayed messages.
 * - `direct`: the scheduler DO executes runs itself (in `waitUntil`) and keeps
 *   pending retries in its own storage. No Queues needed: cheaper for fast
 *   endpoints, but the DO is billed for the wall time of each HTTP call.
 * Unknown values fall back to `queue`.
 */
export function executionMode(env: { EXECUTION_MODE?: string }): ExecutionMode {
  const value = env.EXECUTION_MODE?.trim() ?? ''
  if (value === '' || value === 'queue') return 'queue'
  if (value === 'direct') return 'direct'
  console.warn(`invalid EXECUTION_MODE "${value}", using queue`)
  return 'queue'
}

/**
 * The run queue; fails with a clear message when queue mode is selected without
 * the binding. The only place that reads RUN_QUEUE, typed loosely so the code
 * still compiles after the "queues" section is removed and types regenerated.
 */
export function runQueue(env: CloudflareBindings): Queue {
  const queue = (env as { RUN_QUEUE?: Queue }).RUN_QUEUE
  if (!queue) {
    throw new Error('EXECUTION_MODE is "queue" but the RUN_QUEUE binding is not configured (see wrangler.jsonc "queues")')
  }
  return queue
}
