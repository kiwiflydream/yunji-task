import { DurableObject } from 'cloudflare:workers'
import type { ScheduleSnapshot } from '../domain/task'
import { disableFiredOnceTask } from '../domain/tasks-repo'
import { insertSkippedRun, type RunMessage } from '../domain/runs-repo'
import { processRun, type RunTransport } from '../executor/consumer'
import { effectiveMode, runQueue } from '../executor/mode'
import { MAX_DELIVERIES, REDELIVERY_DELAY_MS } from '../executor/run-executor'
import { nextFireTime } from '../lib/schedule'

import type { ExecutionMode, RunningSlot, SchedulerStatus } from '../shared/types'

export type { SchedulerStatus }

const K_SNAPSHOT = 'snapshot'
const K_NEXT = 'nextRunAt'
const K_RUNNING = 'running'
/** Version of a once task that already fired; it must never be re-armed. */
const K_ONCE_FIRED = 'onceFiredVersion'
/** Direct / worker mode: one key per pending attempt, so concurrent runs never read-modify-write a shared list. */
const PENDING_PREFIX = 'pending:'
const ACTION_PREFIX = 'action:'
interface PendingAction { id: string; dueAt: number }

/** Modes in which the DO hands out runs itself (rather than the queue). */
export type LocalMode = Exclude<ExecutionMode, 'queue'>

/** An attempt waiting for its time (a retry, or a redelivery after an infrastructure error). */
export interface PendingRun {
  msg: RunMessage
  dueAt: number
  /** Failed deliveries so far; mirrors the queue's max_retries for infrastructure errors. */
  deliveries: number
  /** Where it runs when due: inside this DO, or handed to the RunExecutor Worker. */
  mode: LocalMode
}

/**
 * One instance per task (name = taskId). Owns the task's alarm. Depending on
 * the task's effective execution mode it sends runs to the queue, executes them
 * itself (direct) or hands them to the RunExecutor Worker (worker). In the last
 * two it also keeps their pending retries, sharing the one alarm between the
 * next fire and the earliest pending attempt.
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
    const strandedPending = alarm === null && ((await this.pendingRuns()).length > 0 || (await this.pendingActions()).length > 0)
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
    const [snapshot, next, pending, actions] = await Promise.all([
      storage.get<ScheduleSnapshot>(K_SNAPSHOT),
      storage.get<number>(K_NEXT),
      this.pendingRuns(),
      this.pendingActions(),
    ])
    // The alarm was set for the earliest of these events and fires at or after
    // it; everything due by then is due now.
    const target = Math.min(next ?? Infinity, ...pending.map((p) => p.dueAt), ...actions.map((a) => a.dueAt))
    const horizon = Number.isFinite(target) ? Math.max(now, target) : now
    const duePending = pending.filter((p) => p.dueAt <= horizon)
    const dueActions = actions.filter((a) => a.dueAt <= horizon)
    const nextDue = next !== undefined && next <= horizon
    const active = !!snapshot && snapshot.enabled && snapshot.scheduleType !== 'manual'
    const once = snapshot?.scheduleType === 'once'
    const onceAlreadyFired = once && (await storage.get<number>(K_ONCE_FIRED)) === snapshot.version
    const fire = nextDue && active && !onceAlreadyFired

    // State first, then re-arm, then work: a failure below never stops the
    // schedule, and nothing here can be picked up twice.
    if (duePending.length) await storage.delete(duePending.map((p) => PENDING_PREFIX + p.msg.runId))
    if (dueActions.length) await storage.delete(dueActions.map((a) => ACTION_PREFIX + a.id))
    if (nextDue) {
      // Missed fires are not caught up: the next fire is computed from now.
      await this.setNext(active && !once ? nextFireTime(snapshot, Math.max(now, next)) : null)
      if (fire && once) await storage.put(K_ONCE_FIRED, snapshot.version)
    }
    await this.rearm()

    for (const p of duePending) this.start(p)
    for (const a of dueActions) this.ctx.waitUntil(this.handOffAction(a))
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

  /** Direct / worker mode: start a run (e.g. a manual trigger) without waiting for it. */
  async execute(msg: RunMessage, mode: LocalMode): Promise<void> {
    this.start({ msg, dueAt: Date.now(), deliveries: 0, mode })
  }

  /** Keep an attempt until it is due (retries, redeliveries); also called by the RunExecutor Worker. */
  async schedule(p: PendingRun): Promise<void> {
    await this.ctx.storage.put(PENDING_PREFIX + p.msg.runId, p)
    await this.rearm()
  }

  async scheduleAction(id: string, dueAt: number): Promise<void> {
    await this.ctx.storage.put(ACTION_PREFIX + id, { id, dueAt })
    await this.rearm()
  }

  private async handOffAction(action: PendingAction): Promise<void> {
    try {
      await this.ctx.exports.ActionExecutor.start(action.id)
    } catch (err) {
      console.error('action handoff failed', action.id, err)
      await this.scheduleAction(action.id, Date.now() + REDELIVERY_DELAY_MS)
    }
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
    const [next, pending, actions] = await Promise.all([this.ctx.storage.get<number>(K_NEXT), this.pendingRuns(), this.pendingActions()])
    const at = Math.min(next ?? Infinity, ...pending.map((p) => p.dueAt), ...actions.map((a) => a.dueAt))
    if (Number.isFinite(at)) await this.ctx.storage.setAlarm(at)
    else await this.ctx.storage.deleteAlarm()
  }

  private async pendingRuns(): Promise<PendingRun[]> {
    return [...(await this.ctx.storage.list<PendingRun>({ prefix: PENDING_PREFIX })).values()]
  }

  private async pendingActions(): Promise<PendingAction[]> {
    return [...(await this.ctx.storage.list<PendingAction>({ prefix: ACTION_PREFIX })).values()]
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
      const mode = await effectiveMode(this.env, snapshot)
      const msg: RunMessage = {
        runId: crypto.randomUUID(),
        taskId: snapshot.taskId,
        trigger: 'schedule',
        scheduledAt,
        attempt: 1,
      }
      // Take the slot before handing the run off so a fast finish cannot race ahead of it.
      if (skip) await storage.put(K_RUNNING, { runId: msg.runId, leaseUntil: now + snapshot.leaseMs })
      if (mode !== 'queue') {
        this.start({ msg, dueAt: now, deliveries: 0, mode })
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

  /**
   * Run an attempt in the background: here (the pending I/O keeps the object
   * alive), or by handing it to the RunExecutor Worker, which answers at once.
   */
  private start(p: PendingRun): void {
    this.ctx.waitUntil(p.mode === 'worker' ? this.handOff(p) : this.runDirect(p))
  }

  private async handOff(p: PendingRun): Promise<void> {
    try {
      await this.ctx.exports.RunExecutor.start(p.msg, p.deliveries)
    } catch (err) {
      await this.redeliver(p, err)
    }
  }

  private async runDirect(p: PendingRun): Promise<void> {
    try {
      await processRun(p.msg, this.env, this.directTransport())
    } catch (err) {
      await this.redeliver(p, err)
    }
  }

  /**
   * Redelivery restores pending handoffs without executing a claimed attempt
   * again. The lost-run sweep closes attempts that never recorded a result.
   */
  private async redeliver(p: PendingRun, err: unknown): Promise<void> {
    console.error(`${p.mode} run failed`, p.msg.runId, err)
    if (p.deliveries + 1 < MAX_DELIVERIES) {
      await this.schedule({ ...p, dueAt: Date.now() + REDELIVERY_DELAY_MS, deliveries: p.deliveries + 1 })
    }
  }

  private directTransport(): RunTransport {
    return {
      mode: 'direct',
      retry: (next, delaySeconds) =>
        this.schedule({ msg: next, dueAt: Date.now() + delaySeconds * 1000, deliveries: 0, mode: 'direct' }),
      finished: async (msg) => {
        if (msg.trigger === 'schedule') await this.complete(msg.runId)
      },
      orphaned: () => this.destroy(),
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
