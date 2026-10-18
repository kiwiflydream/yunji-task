import { WorkerEntrypoint } from 'cloudflare:workers'
import { actionsForRun, claimAction, completeAction, failAction } from '../domain/actions-repo'
import { sendFailureAlert } from './alert'
import type { RunTransport } from './consumer'
import { runQueue } from './mode'

/** Each handoff/notification gets its own invocation, independent of the task's HTTP deadline. */
export class ActionExecutor extends WorkerEntrypoint<CloudflareBindings> {
  async start(id: string): Promise<void> {
    this.ctx.waitUntil(deliverAction(id, this.env))
  }
}

export async function deliverAction(id: string, env: CloudflareBindings, transport?: RunTransport): Promise<void> {
  const action = await claimAction(env.DB, id, Date.now())
  if (!action) return
  try {
    const payload = action.payload
    if (payload.kind === 'alert') {
      await sendFailureAlert(env, payload.task, payload.run)
    } else if (payload.kind === 'release') {
      await env.TASK_SCHEDULER.getByName(action.taskId).complete(payload.run.id)
    } else {
      const delaySeconds = Math.max(0, Math.ceil((payload.runAt - Date.now()) / 1000))
      if (transport?.mode === payload.mode) await transport.retry(payload.msg, delaySeconds)
      else if (payload.mode === 'queue') await runQueue(env).send(payload.msg, { delaySeconds })
      else await env.TASK_SCHEDULER.getByName(action.taskId).schedule({
        msg: payload.msg, dueAt: Math.max(Date.now(), payload.runAt), deliveries: 0, mode: payload.mode,
      })
    }
    await completeAction(env.DB, action, Date.now())
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const dueAt = await failAction(env.DB, action, message, Date.now())
    console.error('run action failed', action.id, message)
    if (dueAt !== null) {
      try {
        await env.TASK_SCHEDULER.getByName(action.taskId).scheduleAction(action.id, Math.max(dueAt, Date.now() + 30_000))
      } catch (wakeError) {
        console.error('action wake failed; maintenance will recover', action.id, wakeError)
      }
    }
    if (transport) throw err
  }
}

export async function recoverRunActions(env: CloudflareBindings, runId: string, transport: RunTransport): Promise<void> {
  for (const action of await actionsForRun(env.DB, runId)) {
    if (action.payload.kind === 'retry') await deliverAction(action.id, env, transport)
    else await env.TASK_SCHEDULER.getByName(action.taskId).scheduleAction(action.id, action.dueAt)
  }
}
