import { DurableObject } from 'cloudflare:workers'
import type { ScheduleSnapshot } from '../domain/task'
import { disableFiredOnceTask } from '../domain/tasks-repo'
import { insertSkippedRun, type RunMessage } from '../domain/runs-repo'
import { nextFireTime } from '../lib/schedule'

import type { RunningSlot, SchedulerStatus } from '../shared/types'

export type { SchedulerStatus }

const K_SNAPSHOT = 'snapshot'
const K_NEXT = 'nextRunAt'
const K_RUNNING = 'running'
/** Version of a once task that already fired; it must never be re-armed. */
const K_ONCE_FIRED = 'onceFiredVersion'

/**
 * One instance per task (name = taskId). Owns the task's alarm; never executes
 * the task itself, only dispatches RunMessages to the queue.
 */
export class TaskScheduler extends DurableObject<CloudflareBindings> {
  /** Apply a snapshot from D1. Idempotent; stale versions are ignored. */
  async sync(snapshot: ScheduleSnapshot): Promise<SchedulerStatus> {
    const storage = this.ctx.storage
    const current = await storage.get<ScheduleSnapshot>(K_SNAPSHOT)
    if (current && current.version > snapshot.version) return this.status()

    const onceFired = await storage.get<number>(K_ONCE_FIRED)
    const firedThisVersion = snapshot.scheduleType === 'once' && onceFired === snapshot.version
    if (firedThisVersion && snapshot.enabled) {
      // The post-fire D1 update failed earlier; finish it now.
      await this.disableFiredOnce(snapshot)
    }

    const armed = (await storage.getAlarm()) !== null
    const wantArmed = snapshot.enabled && snapshot.scheduleType !== 'manual' && !firedThisVersion
    if (current && current.version === snapshot.version && armed === wantArmed) return this.status()

    await storage.put(K_SNAPSHOT, snapshot)
    const next = wantArmed ? nextFireTime(snapshot, Date.now()) : null
    await this.arm(next)
    return this.status()
  }

  async alarm(): Promise<void> {
    const storage = this.ctx.storage
    const snapshot = await storage.get<ScheduleSnapshot>(K_SNAPSHOT)
    if (!snapshot || !snapshot.enabled || snapshot.scheduleType === 'manual') return
    const now = Date.now()
    const scheduledAt = (await storage.get<number>(K_NEXT)) ?? now

    if (snapshot.scheduleType === 'once') {
      if ((await storage.get<number>(K_ONCE_FIRED)) === snapshot.version) return
      await storage.put(K_ONCE_FIRED, snapshot.version)
      await this.arm(null)
      await this.dispatch(snapshot, scheduledAt, now)
      await this.disableFiredOnce(snapshot)
      return
    }

    // Re-arm first so a failure below never stops the schedule. Missed fires
    // are not caught up: the next fire is computed from now.
    await this.arm(nextFireTime(snapshot, Math.max(now, scheduledAt)))
    await this.dispatch(snapshot, scheduledAt, now)
  }

  /** Called by the queue consumer when a scheduled run has fully finished. */
  async complete(runId: string): Promise<void> {
    const running = await this.ctx.storage.get<RunningSlot>(K_RUNNING)
    if (running?.runId === runId) await this.ctx.storage.delete(K_RUNNING)
  }

  async status(): Promise<SchedulerStatus> {
    const [snapshot, alarmAt, running] = await Promise.all([
      this.ctx.storage.get<ScheduleSnapshot>(K_SNAPSHOT),
      this.ctx.storage.getAlarm(),
      this.ctx.storage.get<RunningSlot>(K_RUNNING),
    ])
    return { version: snapshot?.version ?? null, alarmAt, running: running ?? null }
  }

  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
  }

  private async arm(next: number | null): Promise<void> {
    if (next === null) {
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.delete(K_NEXT)
    } else {
      await this.ctx.storage.put(K_NEXT, next)
      await this.ctx.storage.setAlarm(next)
    }
  }

  /** Never throws: an exception would make the runtime retry the alarm and double-dispatch. */
  private async dispatch(snapshot: ScheduleSnapshot, scheduledAt: number, now: number): Promise<void> {
    const storage = this.ctx.storage
    try {
      const skip = snapshot.overlapPolicy === 'skip'
      if (skip) {
        const running = await storage.get<RunningSlot>(K_RUNNING)
        if (running && running.leaseUntil > now) {
          await insertSkippedRun(
            this.env.DB,
            { taskId: snapshot.taskId, scheduledAt, reason: `previous run ${running.runId} still in progress` },
            now,
          )
          return
        }
      }
      const msg: RunMessage = {
        runId: crypto.randomUUID(),
        taskId: snapshot.taskId,
        trigger: 'schedule',
        scheduledAt,
        attempt: 1,
      }
      // Take the slot before sending so a fast consumer's complete() cannot race ahead of it.
      if (skip) await storage.put(K_RUNNING, { runId: msg.runId, leaseUntil: now + snapshot.leaseMs })
      try {
        await this.env.RUN_QUEUE.send(msg)
      } catch (err) {
        if (skip) await storage.delete(K_RUNNING)
        throw err
      }
    } catch (err) {
      console.error('dispatch failed', snapshot.taskId, err)
    }
  }

  private async disableFiredOnce(snapshot: ScheduleSnapshot): Promise<void> {
    try {
      await disableFiredOnceTask(this.env.DB, snapshot.taskId, snapshot.version, Date.now())
    } catch (err) {
      console.error('failed to disable fired once task; reconcile will retry', snapshot.taskId, err)
    }
  }
}
