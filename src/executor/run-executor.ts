import { WorkerEntrypoint } from 'cloudflare:workers'
import type { RunMessage } from '../domain/runs-repo'
import { processRun, queueTransport, type RunTransport } from './consumer'
import { WORKER_MAX_TIMEOUT_MS } from './mode'

/** Infrastructure errors (D1) are redelivered this many times in total, like the queue's max_retries. */
export const MAX_DELIVERIES = 3
export const REDELIVERY_DELAY_MS = 30_000

/**
 * Worker mode: the scheduler DO calls `start()` over `ctx.exports` and gets an
 * answer immediately; the run continues in this invocation's `waitUntil`, so
 * waiting on the HTTP call is billed as Worker CPU time (none), not DO wall time.
 * Retries and redeliveries go back to the task's DO, which hands them out again when due.
 */
export class RunExecutor extends WorkerEntrypoint<CloudflareBindings> {
  async start(msg: RunMessage, deliveries: number): Promise<void> {
    this.ctx.waitUntil(executeInWorker(this.env, msg, deliveries))
  }
}

export async function executeInWorker(env: CloudflareBindings, msg: RunMessage, deliveries: number): Promise<void> {
  const scheduler = env.TASK_SCHEDULER.getByName(msg.taskId)
  const transport: RunTransport = {
    ...queueTransport(env),
    mode: 'worker',
    retry: (next, delaySeconds) =>
      scheduler.schedule({ msg: next, dueAt: Date.now() + delaySeconds * 1000, deliveries: 0, mode: 'worker' }),
  }
  try {
    await processRun(msg, env, transport, WORKER_MAX_TIMEOUT_MS)
  } catch (err) {
    // Redelivery recovers pending handoffs without repeating a claimed HTTP
    // attempt. A claimed attempt with no recorded result is closed by the lost-run sweep.
    console.error('worker run failed', msg.runId, err)
    if (deliveries + 1 < MAX_DELIVERIES) {
      await scheduler.schedule({ msg, dueAt: Date.now() + REDELIVERY_DELAY_MS, deliveries: deliveries + 1, mode: 'worker' })
    }
  }
}
