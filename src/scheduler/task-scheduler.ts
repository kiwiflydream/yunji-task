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
/** One key per pending attempt or queue handoff. */
const PENDING_PREFIX = 'pending:'
const ACTION_PREFIX = 'action:'
interface PendingAction { id: string; dueAt: number }

/** Modes in which the DO hands out runs itself (rather than the queue). */
export type LocalMode = Exclude<ExecutionMode, 'queue'>

/** An attempt waiting for its time (a retry, or a redelivery after an infrastructure error). */
export type PendingRun = {
  msg: RunMessage
  dueAt: number
  /** Delivery count; local execution caps retries, queue handoffs remain pending until acknowledged. */
  deliveries: number
} & ({ mode: LocalMode } | { mode: 'queue'; leaseMs: number })

/**
 * One instance per task (name = taskId). Owns the task's alarm. Depending on
 * the task's effective execution mode it sends runs to the queue, executes them
 * itself (direct) or hands them to the RunExecutor Worker (worker). In the last
 * two it also keeps their pending retries. Unacknowledged queue handoffs share
 * the same alarm with those retries and the next scheduled fire.
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

    // D1 I/O above can let another sync or alarm advance state. Recheck and
    // commit only storage work atomically; never hold the gate across D1.
    await storage.transaction(async (txn) => {
      const current = await txn.get<ScheduleSnapshot>(K_SNAPSHOT)
      if (current && current.version > snapshot.version) return
      const onceFired = await txn.get<number>(K_ONCE_FIRED)
      const firedThisVersion = snapshot.scheduleType === 'once' && onceFired === snapshot.version
      const [alarm, next] = await Promise.all([txn.getAlarm(), txn.get<number>(K_NEXT)])
      const armed = alarm !== null && next !== undefined
      const wantArmed = snapshot.enabled && snapshot.scheduleType !== 'manual' && !firedThisVersion
      const strandedPending = alarm === null && ((await this.pendingRuns(txn)).length > 0 || (await this.pendingActions(txn)).length > 0)
      if (current && current.version === snapshot.version && armed === wantArmed && !strandedPending) return

      await txn.put(K_SNAPSHOT, snapshot)
      await this.setNext(wantArmed ? nextFireTime(snapshot, Date.now()) : null, txn)
      await this.rearm(txn)
    })
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
    const localPending = duePending.filter((p) => p.mode !== 'queue')
    if (localPending.length) await storage.delete(localPending.map((p) => PENDING_PREFIX + p.msg.runId))
    if (dueActions.length) await storage.delete(dueActions.map((a) => ACTION_PREFIX + a.id))
    if (nextDue) {
      // Missed fires are not caught up: the next fire is computed from now.
      await this.setNext(active && !once ? nextFireTime(snapshot, Math.max(now, next)) : null)
      if (fire && once) await storage.put(K_ONCE_FIRED, snapshot.version)
    }
    await this.rearm()

    for (const p of duePending) {
      if (p.mode === 'queue') await this.sendToQueue(p)
      else this.start(p)
    }
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
    await this.ctx.storage.transaction(async (txn) => {
      const key = PENDING_PREFIX + p.msg.runId
      const current = await txn.get<PendingRun>(key)
      // Outbox replay and infrastructure redelivery may arrive out of order.
      // Keep the legacy key, but only advance (attempt, deliveries); equal
      // deliveries are idempotent and preserve their original deadline.
      if (!current || p.msg.attempt > current.msg.attempt ||
          (p.msg.attempt === current.msg.attempt && p.deliveries > current.deliveries)) {
        await txn.put(key, p)
      }
      await this.rearm(txn)
    })
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

  private async setNext(next: number | null, storage: DurableObjectStorage | DurableObjectTransaction = this.ctx.storage): Promise<void> {
    if (next === null) await storage.delete(K_NEXT)
    else await storage.put(K_NEXT, next)
  }

  /** Point the alarm at the earliest of the next fire and any pending attempt. */
  private async rearm(storage: DurableObjectStorage | DurableObjectTransaction = this.ctx.storage): Promise<void> {
    const [next, pending, actions] = await Promise.all([storage.get<number>(K_NEXT), this.pendingRuns(storage), this.pendingActions(storage)])
    const at = Math.min(next ?? Infinity, ...pending.map((p) => p.dueAt), ...actions.map((a) => a.dueAt))
    if (Number.isFinite(at)) await storage.setAlarm(at)
    else await storage.deleteAlarm()
  }

  private async pendingRuns(storage: DurableObjectStorage | DurableObjectTransaction = this.ctx.storage): Promise<PendingRun[]> {
    return [...(await storage.list<PendingRun>({ prefix: PENDING_PREFIX })).values()]
  }

  private async pendingActions(storage: DurableObjectStorage | DurableObjectTransaction = this.ctx.storage): Promise<PendingAction[]> {
    return [...(await storage.list<PendingAction>({ prefix: ACTION_PREFIX })).values()]
  }

  /** Never throws (see alarm()). */
  private async dispatch(snapshot: ScheduleSnapshot, scheduledAt: number, now: number): Promise<void> {
    const storage = this.ctx.storage
    try {
      const skip = snapshot.overlapPolicy === 'skip'
      if (skip) {
        const running = await storage.get<RunningSlot>(K_RUNNING)
        const waiting = running && running.leaseUntil <= now
          ? await storage.get<PendingRun>(PENDING_PREFIX + running.runId)
          : undefined
        if (running && (running.leaseUntil > now || waiting?.mode === 'queue')) {
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
      await this.sendToQueue({ msg, dueAt: now, deliveries: 0, mode, leaseMs: snapshot.leaseMs })
    } catch (err) {
      console.error('dispatch failed', snapshot.taskId, err)
    }
  }

  private async sendToQueue(p: Extract<PendingRun, { mode: 'queue' }>): Promise<void> {
    // Keep the original run ID until acknowledgement, including interrupted sends.
    const delay = Math.min(REDELIVERY_DELAY_MS * 2 ** Math.min(p.deliveries, 4), 5 * 60_000)
    await this.schedule({ ...p, dueAt: Date.now() + delay, deliveries: p.deliveries + 1 })
    try {
      if (p.deliveries > 0) {
        const running = await this.ctx.storage.get<RunningSlot>(K_RUNNING)
        if (running?.runId === p.msg.runId) {
          await this.ctx.storage.put(K_RUNNING, { ...running, leaseUntil: Date.now() + p.leaseMs })
        }
      }
      await runQueue(this.env).send(p.msg)
      await this.ctx.storage.delete(PENDING_PREFIX + p.msg.runId)
    } catch (err) {
      console.error('queue handoff failed; retained for redelivery', p.msg.runId, err)
    }
    await this.rearm()
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
