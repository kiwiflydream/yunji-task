import { z } from 'zod'
import type { RunMessage } from './runs-repo'
import { scheduleSpec, taskInputSchema, toSnapshot, type Task, type TaskInput } from './task'
import * as repo from './tasks-repo'
import { effectiveMode, hasRunQueue, runQueue, WORKER_MAX_TIMEOUT_MS } from '../executor/mode'
import { nextFireTime } from '../lib/schedule'

import type { Issue } from '../shared/types'

export type { Issue }

export class ValidationError extends Error {
  constructor(readonly issues: Issue[]) {
    super(issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; '))
  }
}

export function zodIssues(error: z.ZodError): Issue[] {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
}

/** Validate raw input (JSON or form-derived) into a TaskInput. */
export async function parseTaskInput(raw: unknown, now: number, env: CloudflareBindings): Promise<TaskInput> {
  const parsed = taskInputSchema.safeParse(raw)
  if (!parsed.success) throw new ValidationError(zodIssues(parsed.error))
  assertRunnable(parsed.data, now)
  const timeoutMs = parsed.data.executor.config.timeoutMs
  const mode = await effectiveMode(env, { executionMode: parsed.data.executionMode, timeoutMs })
  if (mode === 'worker' && timeoutMs > WORKER_MAX_TIMEOUT_MS) {
    throw new ValidationError([
      {
        path: 'executionMode',
        message: `Worker 异步只支持 ${WORKER_MAX_TIMEOUT_MS / 1000} 秒以内的超时（当前 ${timeoutMs / 1000} 秒）`,
      },
    ])
  }
  if (mode === 'queue' && !hasRunQueue(env)) {
    throw new ValidationError([
      { path: 'executionMode', message: '当前部署没有配置 Queue（wrangler.jsonc 的 queues），不能选择队列执行' },
    ])
  }
  return parsed.data
}

function assertRunnable(task: Pick<TaskInput, 'enabled' | 'schedule'>, now: number) {
  if (task.enabled && task.schedule.type === 'once' && task.schedule.runAt <= now) {
    throw new ValidationError([{ path: 'schedule.runAt', message: '执行时间必须晚于当前时间' }])
  }
}

/** Next planned fire time, for display. Computed, not stored. */
export function nextRunAt(task: Task, now: number): number | null {
  if (!task.enabled) return null
  return nextFireTime(scheduleSpec(task), now)
}

/** Push the D1 state to the task's DO. Failures are healed by the reconcile cron. */
export async function syncScheduler(env: CloudflareBindings, task: Task): Promise<boolean> {
  try {
    await env.TASK_SCHEDULER.getByName(task.id).sync(toSnapshot(task))
    return true
  } catch (err) {
    console.error('scheduler sync failed; reconcile will retry', task.id, err)
    return false
  }
}

export async function createTask(env: CloudflareBindings, raw: unknown): Promise<Task> {
  const now = Date.now()
  const task = await repo.insertTask(env.DB, await parseTaskInput(raw, now, env), now)
  await syncScheduler(env, task)
  return task
}

export async function updateTask(env: CloudflareBindings, id: string, raw: unknown): Promise<Task | null> {
  const now = Date.now()
  const task = await repo.updateTask(env.DB, id, await parseTaskInput(raw, now, env), now)
  if (task) await syncScheduler(env, task)
  return task
}

export async function setTaskEnabled(env: CloudflareBindings, id: string, enabled: boolean): Promise<Task | null> {
  const now = Date.now()
  const existing = await repo.getTask(env.DB, id)
  if (!existing) return null
  assertRunnable({ enabled, schedule: existing.schedule }, now)
  const task = await repo.setTaskEnabled(env.DB, id, enabled, now)
  if (task) await syncScheduler(env, task)
  return task
}

export async function deleteTask(env: CloudflareBindings, id: string): Promise<boolean> {
  const deleted = await repo.deleteTask(env.DB, id)
  if (!deleted) return false
  try {
    await env.TASK_SCHEDULER.getByName(id).destroy()
  } catch (err) {
    // The next scheduled message for this task destroys the orphan DO.
    console.error('failed to destroy scheduler', id, err)
  }
  return true
}

/** Manual trigger: enqueue directly, without touching the DO's schedule. */
export async function triggerTask(env: CloudflareBindings, id: string): Promise<string | null> {
  const task = await repo.getTask(env.DB, id)
  if (!task) return null
  const now = Date.now()
  const msg: RunMessage = { runId: crypto.randomUUID(), taskId: id, trigger: 'manual', scheduledAt: now, attempt: 1 }
  const mode = await effectiveMode(env, { executionMode: task.executionMode, timeoutMs: task.executor.config.timeoutMs })
  if (mode === 'queue') await runQueue(env).send(msg)
  else await env.TASK_SCHEDULER.getByName(id).execute(msg, mode)
  return msg.runId
}
