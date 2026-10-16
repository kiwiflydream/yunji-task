import { DurableObject } from 'cloudflare:workers'
import type { ScheduleSnapshot } from '../domain/task'
import { disableFiredOnceTask } from '../domain/tasks-repo'
import { insertSkippedRun, type RunMessage } from '../domain/runs-repo'
import { processRun, type RunTransport } from '../executor/consumer'
import { effectiveMode, runQueue } from '../executor/mode'
import { nextFireTime } from '../lib/schedule'

import type { RunningSlot, SchedulerStatus } from '../shared/types'

export type { SchedulerStatus }

const K_SNAPSHOT = 'snapshot'
const K_NEXT = 'nextRunAt'
const K_RUNNING = 'running'
/** Version of a once task that already fired; it must never be re-armed. */
const K_ONCE_FIRED = 'onceFiredVersion'
/** Direct mode: one key per pending attempt, so concurrent runs never read-modify-write a shared list. */
const PENDING_PREFIX = 'pending:'

/** Direct mode: an attempt waiting for its time (a retry, or a redelivery after an infrastructure error). */
interface PendingRun {
  msg: RunMessage
  dueAt: number
  /** Failed deliveries so far; mirrors the queue's max_retries for infrastructure errors. */
  deliveries: number
}
const MAX_DELIVERIES = 3
const REDELIVERY_DELAY_MS = 30_000

/**
 * One instance per task (name = taskId). Owns the task's alarm. In queue mode
 * it only dispatches RunMessages to the queue; in direct mode it also executes
 * them (the task's executionMode, else EXECUTION_MODE) and keeps their pending retries, sharing the one
 * alarm between the next fire and the earliest pending attempt.
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

    const [alarm, next] = await Promise.all([storage.getAlarm(), storage.get<number>(K_NEXT)])
    const armed = alarm !== null && next !== undefined
    const wantArmed = snapshot.enabled && snapshot.scheduleType !== 'manual' && !firedThisVersion
    const strandedPending = alarm === null && (await this.pendingRuns()).length > 0
    if (current && current.version === snapshot.version && armed === wantArmed && !strandedPending) {
      return this.status()
    }

    await storage.put(K_SNAPSHOT, snapshot)
    await this.setNext(wantArmed ? nextFireTime(snapshot, Date.now()) : null)
    await this.rearm()
    return this.status()
  }

  /** Never throws: an exception would make the runtime retry the alarm and double-dispatch. */
  async alarm(): Promise<void> {
    try {
      await this.handleAlarm()
    } catch (err) {
      console.error('alarm failed', this.ctx.id.toString(), err)
    }
  }

  private async handleAlarm(): Promise<void> {
    const storage = this.ctx.storage
    const now = Date.now()
    const [snapshot, next, pending] = await Promise.all([
      storage.get<ScheduleSnapshot>(K_SNAPSHOT),
      storage.get<number>(K_NEXT),
      this.pendingRuns(),
    ])
    // The alarm was set for the earliest of these events and fires at or after
    // it; everything due by then is due now.
    const target = Math.min(next ?? Infinity, ...pending.map((p) => p.dueAt))
    const horizon = Number.isFinite(target) ? Math.max(now, target) : now
    const duePending = pending.filter((p) => p.dueAt <= horizon)
    const nextDue = next !== undefined && next <= horizon
    const active = !!snapshot && snapshot.enabled && snapshot.scheduleType !== 'manual'
    const once = snapshot?.scheduleType === 'once'
    const onceAlreadyFired = once && (await storage.get<number>(K_ONCE_FIRED)) === snapshot.version
    const fire = nextDue && active && !onceAlreadyFired

    // State first, then re-arm, then work: a failure below never stops the
    // schedule, and nothing here can be picked up twice.
    if (duePending.length) await storage.delete(duePending.map((p) => PENDING_PREFIX + p.msg.runId))
    if (nextDue) {
      // Missed fires are not caught up: the next fire is computed from now.
      await this.setNext(active && !once ? nextFireTime(snapshot, Math.max(now, next)) : null)
      if (fire && once) await storage.put(K_ONCE_FIRED, snapshot.version)
    }
    await this.rearm()

    for (const p of duePending) this.start(p)
    if (fire) {
      await this.dispatch(snapshot, next, now)
      if (once) await this.disableFiredOnce(snapshot)
    }
  }

  /** Called by the queue consumer when a scheduled run has fully finished. */
  async complete(runId: string): Promise<void> {
    const running = await this.ctx.storage.get<RunningSlot>(K_RUNNING)
    if (running?.runId === runId) await this.ctx.storage.delete(K_RUNNING)
  }

  /** Direct mode: start a run (e.g. a manual trigger) without waiting for it. */
  async execute(msg: RunMessage): Promise<void> {
    this.start({ msg, dueAt: Date.now(), deliveries: 0 })
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

  private async setNext(next: number | null): Promise<void> {
    if (next === null) await this.ctx.storage.delete(K_NEXT)
    else await this.ctx.storage.put(K_NEXT, next)
  }

  /** Point the alarm at the earliest of the next fire and any pending attempt. */
  private async rearm(): Promise<void> {
    const [next, pending] = await Promise.all([this.ctx.storage.get<number>(K_NEXT), this.pendingRuns()])
    const at = Math.min(next ?? Infinity, ...pending.map((p) => p.dueAt))
    if (Number.isFinite(at)) await this.ctx.storage.setAlarm(at)
    else await this.ctx.storage.deleteAlarm()
  }

  private async pendingRuns(): Promise<PendingRun[]> {
    return [...(await this.ctx.storage.list<PendingRun>({ prefix: PENDING_PREFIX })).values()]
  }

  /** Never throws (see alarm()). */
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
      // Take the slot before handing the run off so a fast finish cannot race ahead of it.
      if (skip) await storage.put(K_RUNNING, { runId: msg.runId, leaseUntil: now + snapshot.leaseMs })
      if (effectiveMode(this.env, snapshot.executionMode) === 'direct') {
        this.start({ msg, dueAt: now, deliveries: 0 })
        return
      }
      try {
        await runQueue(this.env).send(msg)
      } catch (err) {
        if (skip) await storage.delete(K_RUNNING)
        throw err
      }
    } catch (err) {
      console.error('dispatch failed', snapshot.taskId, err)
    }
  }

  /** Direct mode: run an attempt in the background; the pending I/O keeps the object alive. */
  private start(p: PendingRun): void {
    this.ctx.waitUntil(this.runDirect(p))
  }

  private async runDirect(p: PendingRun): Promise<void> {
    try {
      await processRun(p.msg, this.env, this.directTransport())
    } catch (err) {
      // Infrastructure error (D1). Like a queue redelivery: if the attempt was
      // already claimed, the redelivery is a no-op and the lost-run sweep closes it.
      console.error('direct run failed', p.msg.runId, err)
      if (p.deliveries + 1 < MAX_DELIVERIES) {
        await this.schedule({ msg: p.msg, dueAt: Date.now() + REDELIVERY_DELAY_MS, deliveries: p.deliveries + 1 })
      }
    }
  }

  private directTransport(): RunTransport {
    return {
      retry: (next, delaySeconds) => this.schedule({ msg: next, dueAt: Date.now() + delaySeconds * 1000, deliveries: 0 }),
      finished: async (msg) => {
        if (msg.trigger === 'schedule') await this.complete(msg.runId)
      },
      orphaned: () => this.destroy(),
    }
  }

  private async schedule(p: PendingRun): Promise<void> {
    await this.ctx.storage.put(PENDING_PREFIX + p.msg.runId, p)
    await this.rearm()
  }

  private async disableFiredOnce(snapshot: ScheduleSnapshot): Promise<void> {
    try {
      await disableFiredOnceTask(this.env.DB, snapshot.taskId, snapshot.version, Date.now())
    } catch (err) {
      console.error('failed to disable fired once task; reconcile will retry', snapshot.taskId, err)
    }
  }
}
