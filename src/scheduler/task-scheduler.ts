import { admit, getSafetySettings, HANDOFF_MAX_ATTEMPTS, RECOVERY_MAX_AGE_MS, SafetyError } from '../domain/safety'
import { cancelAction } from '../domain/actions-repo'
import { withDeadline } from '../lib/deadline'
import { DurableObject } from 'cloudflare:workers'
import type { ScheduleSnapshot } from '../domain/task'
import { disableFiredOnceTask } from '../domain/tasks-repo'
import { failRun, getRun, insertSkippedRun, type RunMessage } from '../domain/runs-repo'
import { processRun, type RunTransport } from '../executor/consumer'
import { effectiveMode, runQueue } from '../executor/mode'
import { MAX_DELIVERIES, REDELIVERY_DELAY_MS } from '../executor/run-executor'
import { nextFireTime } from '../lib/schedule'

import type { ExecutionMode, RunningSlot, SchedulerStatus } from '../shared/types'

export type { SchedulerStatus }

const K_SNAPSHOT = 'snapshot'
const K_NEXT = 'nextRunAt'
const K_DISPATCH_FAILURES = 'dispatchFailures'
const DISPATCH_FAILURE_LIMIT = 5
const K_RUNNING = 'running'
/** Version of a once task that already fired; it must never be re-armed. */
const K_ONCE_FIRED = 'onceFiredVersion'
/** One key per pending attempt or queue handoff. */
const PENDING_PREFIX = 'pending:'
const ACTION_PREFIX = 'action:'
interface PendingAction { id: string; dueAt: number; deliveries: number; createdAt: number }
const TERMINAL_PREFIX = 'terminal:'
interface TerminalCleanup {
  id: string
  actionId?: string
  msg?: RunMessage
  reason: string
  attempts: number
  createdAt: number
  dueAt: number
}
const ONCE_PREFIX = 'once:'
interface PendingOnce {
  snapshot: ScheduleSnapshot
  runId: string
  scheduledAt: number
  dueAt: number
  mode?: ExecutionMode
  deliveries: number
}

/** Modes in which the DO hands out runs itself (rather than the queue). */
export type LocalMode = Exclude<ExecutionMode, 'queue'>

/** An attempt waiting for its time (a retry, or a redelivery after an infrastructure error). */
export type PendingRun = {
  msg: RunMessage
  dueAt: number
  /** Delivery count; local execution caps retries, queue handoffs are bounded by attempts and age. */
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
      const failures = await txn.get<number>(K_DISPATCH_FAILURES) ?? 0
      // Reconciliation must not reopen a circuit. An explicit configuration version does.
      if (current?.version === snapshot.version && failures >= DISPATCH_FAILURE_LIMIT) return
      if (current?.version !== snapshot.version) await txn.delete(K_DISPATCH_FAILURES)
      const onceFired = await txn.get<number>(K_ONCE_FIRED)
      const firedThisVersion = snapshot.scheduleType === 'once' && onceFired === snapshot.version
      const [alarm, next] = await Promise.all([txn.getAlarm(), txn.get<number>(K_NEXT)])
      const armed = alarm !== null && next !== undefined
      const wantArmed = snapshot.enabled && snapshot.scheduleType !== 'manual' && !firedThisVersion
      const strandedPending = alarm === null && ((await this.pendingRuns(txn)).length > 0 || (await this.pendingActions(txn)).length > 0 || (await this.pendingOnce(txn)).length > 0 || (await this.terminalCleanups(txn)).some((t) => t.attempts < HANDOFF_MAX_ATTEMPTS))
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
    const [snapshot, next, pending, actions, onceRuns, terminal] = await Promise.all([
      storage.get<ScheduleSnapshot>(K_SNAPSHOT),
      storage.get<number>(K_NEXT),
      this.pendingRuns(),
      this.pendingActions(),
      this.pendingOnce(),
      this.terminalCleanups(),
    ])
    // The alarm was set for the earliest of these events and fires at or after
    // it; everything due by then is due now.
    const target = Math.min(next ?? Infinity, ...pending.map((p) => p.dueAt), ...actions.map((a) => a.dueAt), ...onceRuns.map((p) => p.dueAt), ...terminal.filter((t) => t.attempts < HANDOFF_MAX_ATTEMPTS).map((t) => t.dueAt))
    const horizon = Number.isFinite(target) ? Math.max(now, target) : now
    const duePending = pending.filter((p) => p.dueAt <= horizon)
    const dueActions = actions.filter((a) => a.dueAt <= horizon)
    const dueOnce = onceRuns.filter((p) => p.dueAt <= horizon)
    const nextDue = next !== undefined && next <= horizon
    const active = !!snapshot && snapshot.enabled && snapshot.scheduleType !== 'manual'
    const once = snapshot?.scheduleType === 'once'
    const onceAlreadyFired = once && (await storage.get<number>(K_ONCE_FIRED)) === snapshot.version
    const fire = nextDue && active && !onceAlreadyFired

    // State first, then re-arm, then work: a failure below never stops the
    // schedule, and nothing here can be picked up twice.
    const localPending = duePending.filter((p) => p.mode !== 'queue')
    if (localPending.length) await storage.delete(localPending.map((p) => PENDING_PREFIX + p.msg.runId))

    if (nextDue) {
      // Missed fires are not caught up: the next fire is computed from now.
      const onceRun: PendingOnce | undefined = fire && once
        ? { snapshot, runId: crypto.randomUUID(), scheduledAt: next, dueAt: now, deliveries: 0 }
        : undefined
      await storage.transaction(async (txn) => {
        await this.setNext(active && !once ? nextFireTime(snapshot, Math.max(now, next)) : null, txn)
        if (onceRun) {
          await txn.put(ONCE_PREFIX + onceRun.runId, onceRun)
          await txn.put(K_ONCE_FIRED, onceRun.snapshot.version)
        }
      })
      if (onceRun) dueOnce.push(onceRun)
    }
    await this.rearm()

    for (const cleanup of terminal.filter((t) => t.attempts < HANDOFF_MAX_ATTEMPTS && t.dueAt <= horizon)) await this.flushTerminal(cleanup)
    for (const p of duePending) {
      if (p.mode === 'queue') await this.sendToQueue(p)
      else this.start(p)
    }
    for (const a of dueActions) this.ctx.waitUntil(this.handOffAction(a))
    for (const p of dueOnce) await this.dispatchOnce(p)
    if (fire) {
      if (!once) await this.dispatch(snapshot, next, now)
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
      if (await txn.get(TERMINAL_PREFIX + 'run:' + p.msg.runId)) return
      const key = PENDING_PREFIX + p.msg.runId
      const current = await txn.get<PendingRun>(key)
      if (!current && (await this.pendingRuns(txn)).length + (await this.terminalCleanups(txn)).length >= 1000) throw new SafetyError('scheduler pending capacity exhausted')
      // Outbox replay and infrastructure redelivery may arrive out of order.
      // Keep one key per run and only advance (attempt, deliveries); equal
      // deliveries are idempotent and preserve their original deadline.
      if (!current || p.msg.attempt > current.msg.attempt ||
          (p.msg.attempt === current.msg.attempt && p.deliveries > current.deliveries)) {
        await txn.put(key, p)
      }
      await this.rearm(txn)
    })
  }

  async scheduleAction(id: string, dueAt: number): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      if (await txn.get(TERMINAL_PREFIX + 'action:' + id)) return
      const current = await txn.get<PendingAction>(ACTION_PREFIX + id)
      if (!current && (await this.pendingActions(txn)).length + (await this.terminalCleanups(txn)).length >= 1000) throw new SafetyError('action capacity exhausted')
      await txn.put(ACTION_PREFIX + id, current ?? { id, dueAt, createdAt: Date.now(), deliveries: 0 })
      await this.rearm(txn)
    })
  }

  private async handOffAction(action: PendingAction): Promise<void> {
    const now = Date.now()
    const deliveries = action.deliveries
    const createdAt = action.createdAt
    if (deliveries >= HANDOFF_MAX_ATTEMPTS || now - createdAt >= RECOVERY_MAX_AGE_MS) {
      await this.terminate({ id: 'action:' + action.id, actionId: action.id, reason: 'action handoff budget exhausted' }, ACTION_PREFIX + action.id)
      return
    }
    // Persist before RPC so interrupted handoffs consume budget too.
    await this.ctx.storage.put(ACTION_PREFIX + action.id, { ...action, createdAt, deliveries: deliveries + 1, dueAt: now + REDELIVERY_DELAY_MS })
    await this.rearm()
    try {
      await withDeadline(this.ctx.exports.ActionExecutor.start(action.id))
      await this.ctx.storage.delete(ACTION_PREFIX + action.id)
      await this.rearm()
    } catch (err) {
      console.error('action handoff failed', action.id, err)
    }
  }

  async status(): Promise<SchedulerStatus> {
    const [snapshot, alarmAt, running, terminal] = await Promise.all([
      this.ctx.storage.get<ScheduleSnapshot>(K_SNAPSHOT),
      this.ctx.storage.getAlarm(),
      this.ctx.storage.get<RunningSlot>(K_RUNNING),
      this.terminalCleanups(),
    ])
    return { dispatchFailures: await this.ctx.storage.get<number>(K_DISPATCH_FAILURES) ?? 0, terminalPending: terminal.length, terminalExhausted: terminal.filter((t) => t.attempts >= HANDOFF_MAX_ATTEMPTS).length, version: snapshot?.version ?? null, alarmAt, running: running ?? null }
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
    const [next, pending, actions, onceRuns] = await Promise.all([storage.get<number>(K_NEXT), this.pendingRuns(storage), this.pendingActions(storage), this.pendingOnce(storage)])
    const terminal = await this.terminalCleanups(storage)
    const at = Math.min(next ?? Infinity, ...pending.map((p) => p.dueAt), ...actions.map((a) => a.dueAt), ...onceRuns.map((p) => p.dueAt), ...terminal.filter((t) => t.attempts < HANDOFF_MAX_ATTEMPTS).map((t) => t.dueAt))
    if (Number.isFinite(at)) await storage.setAlarm(at)
    else await storage.deleteAlarm()
  }

  private async pendingRuns(storage: DurableObjectStorage | DurableObjectTransaction = this.ctx.storage): Promise<PendingRun[]> {
    return [...(await storage.list<PendingRun>({ prefix: PENDING_PREFIX })).values()]
  }

  private async pendingActions(storage: DurableObjectStorage | DurableObjectTransaction = this.ctx.storage): Promise<PendingAction[]> {
    return [...(await storage.list<PendingAction>({ prefix: ACTION_PREFIX })).values()]
  }

  private async pendingOnce(storage: DurableObjectStorage | DurableObjectTransaction = this.ctx.storage): Promise<PendingOnce[]> {
    return [...(await storage.list<PendingOnce>({ prefix: ONCE_PREFIX })).values()]
  }

  private async terminalCleanups(storage: DurableObjectStorage | DurableObjectTransaction = this.ctx.storage): Promise<TerminalCleanup[]> {
    return [...(await storage.list<TerminalCleanup>({ prefix: TERMINAL_PREFIX })).values()]
  }

  /** A tombstone blocks replay before the original intent is removed. */
  private async terminate(data: Pick<TerminalCleanup, 'id' | 'actionId' | 'msg' | 'reason'>, sourceKey: string): Promise<void> {
    const key = TERMINAL_PREFIX + data.id
    const cleanup = await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<TerminalCleanup>(key)
      const item = current ?? { ...data, attempts: 0, createdAt: Date.now(), dueAt: Date.now() }
      await txn.put(key, item)
      await txn.delete(sourceKey)
      if (data.msg) {
        const running = await txn.get<RunningSlot>(K_RUNNING)
        if (running?.runId === data.msg.runId) await txn.delete(K_RUNNING)
      }
      await this.rearm(txn)
      return item
    })
    await this.flushTerminal(cleanup)
  }

  private async flushTerminal(cleanup: TerminalCleanup): Promise<void> {
    if (cleanup.attempts >= HANDOFF_MAX_ATTEMPTS) return
    const key = TERMINAL_PREFIX + cleanup.id
    const expired = Date.now() - cleanup.createdAt >= RECOVERY_MAX_AGE_MS
    await this.ctx.storage.put(key, { ...cleanup, attempts: expired ? HANDOFF_MAX_ATTEMPTS : cleanup.attempts + 1, dueAt: Date.now() + REDELIVERY_DELAY_MS })
    await this.rearm()
    if (expired) return
    try {
      if (cleanup.actionId) await withDeadline(cancelAction(this.env.DB, cleanup.actionId, Date.now(), cleanup.reason))
      else if (cleanup.msg) await withDeadline(failRun(this.env.DB, cleanup.msg, cleanup.reason))
      await this.ctx.storage.delete(key)
      await this.rearm()
    } catch (err) {
      console.error('terminal cleanup failed; business dispatch remains stopped', cleanup.id, err)
    }
  }

  /** Consume a once trigger only after its recoverable dispatch intent is stored. */
  private async dispatchOnce(p: PendingOnce): Promise<void> {
    const key = ONCE_PREFIX + p.runId
    const deliveries = p.deliveries
    if (deliveries >= HANDOFF_MAX_ATTEMPTS || Date.now() - p.scheduledAt >= RECOVERY_MAX_AGE_MS) {
      await this.terminate({ id: 'run:' + p.runId, msg: { runId: p.runId, taskId: p.snapshot.taskId, trigger: 'schedule', scheduledAt: p.scheduledAt, attempt: 1 }, reason: 'once dispatch budget exhausted' }, key)
      return
    }
    p = { ...p, deliveries: deliveries + 1, dueAt: Date.now() + REDELIVERY_DELAY_MS }
    await this.ctx.storage.put(key, p)
    await this.rearm()
    try {
      const run = await withDeadline(getRun(this.env.DB, p.runId))
      let accepted = run !== null
      if (!accepted) {
        p.mode ??= await withDeadline(effectiveMode(this.env, p.snapshot))
        // Freeze the resolved transport before attempting its handoff.
        await this.ctx.storage.put(key, p)
        accepted = await this.dispatch(p.snapshot, p.scheduledAt, Date.now(), p.runId, p.mode)
      }
      if (accepted) {
        // A crash after handoff but before deleting the intent must not take
        // the skip slot again. In-flight runs already have their own recovery.
        if (run && run.status !== 'running' && run.status !== 'retrying') await this.complete(p.runId)
        await this.ctx.storage.delete(key)
        await this.rearm()
        return
      }
    } catch (err) {
      console.error('once dispatch failed; retained for recovery', p.runId, err)
    }
    await this.ctx.storage.put(key, { ...p, dueAt: Date.now() + REDELIVERY_DELAY_MS })
    await this.rearm()
  }

  private async clearDispatchFailures(version: number): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      if ((await txn.get<ScheduleSnapshot>(K_SNAPSHOT))?.version === version) await txn.delete(K_DISPATCH_FAILURES)
    })
  }

  /** Never throws (see alarm()). */
  private async dispatch(snapshot: ScheduleSnapshot, scheduledAt: number, now: number, runId = crypto.randomUUID(), resolvedMode?: ExecutionMode): Promise<boolean> {
    const storage = this.ctx.storage
    try {
      if ((await this.terminalCleanups()).length >= 1000) throw new SafetyError('terminal cleanup capacity exhausted')
      await withDeadline(admit(this.env.DB, snapshot.taskId, 'dispatch'))
      const skip = snapshot.overlapPolicy === 'skip'
      if (skip) {
        const running = await storage.get<RunningSlot>(K_RUNNING)
        const waiting = running && running.leaseUntil <= now
          ? await storage.get<PendingRun>(PENDING_PREFIX + running.runId)
          : undefined
        if (running && running.runId !== runId && (running.leaseUntil > now || waiting?.mode === 'queue')) {
          await insertSkippedRun(
            this.env.DB,
            { runId, taskId: snapshot.taskId, scheduledAt, reason: `previous run ${running.runId} still in progress` },
            now,
          )
          await this.clearDispatchFailures(snapshot.version)
          return true
        }
      }
      const mode = resolvedMode ?? await withDeadline(effectiveMode(this.env, snapshot))
      const msg: RunMessage = {
        runId,
        taskId: snapshot.taskId,
        trigger: 'schedule',
        scheduledAt,
        attempt: 1,
      }
      // Take the slot before handing the run off so a fast finish cannot race ahead of it.
      if (skip) await storage.put(K_RUNNING, { runId: msg.runId, leaseUntil: now + snapshot.leaseMs })
      if (mode !== 'queue') {
        this.start({ msg, dueAt: now, deliveries: 0, mode })
        await this.clearDispatchFailures(snapshot.version)
        return true
      }
      await this.sendToQueue({ msg, dueAt: now, deliveries: 0, mode, leaseMs: snapshot.leaseMs })
      await this.clearDispatchFailures(snapshot.version)
      return true
    } catch (err) {
      console.error('dispatch failed', snapshot.taskId, err)
      if (err instanceof SafetyError) {
        // Preserve cron semantics after quota exhaustion; a pause clears the
        // next fire so reconcile can resume it after the switch is released.
        const tomorrow = Math.floor(Date.now() / 86_400_000 + 1) * 86_400_000
        await this.setNext(snapshot.scheduleType === 'cron' && err.reason !== 'paused' ? nextFireTime(snapshot, tomorrow - 1) : null)
        await this.rearm()
        await withDeadline(failRun(this.env.DB, { runId, taskId: snapshot.taskId, trigger: 'schedule', scheduledAt, attempt: 1 }, err.message))
        return true
      }
      if (snapshot.scheduleType === 'cron') {
        await storage.transaction(async (txn) => {
          const current = await txn.get<ScheduleSnapshot>(K_SNAPSHOT)
          if (current?.version !== snapshot.version) return
          const failures = (await txn.get<number>(K_DISPATCH_FAILURES) ?? 0) + 1
          await txn.put(K_DISPATCH_FAILURES, failures)
          await this.setNext(failures >= DISPATCH_FAILURE_LIMIT ? null
            : nextFireTime(snapshot, Date.now() + 30_000 * 2 ** (failures - 1)), txn)
          await this.rearm(txn)
        })
      }
      return false
    }
  }

  private async sendToQueue(p: Extract<PendingRun, { mode: 'queue' }>): Promise<void> {
    if (p.deliveries >= HANDOFF_MAX_ATTEMPTS || Date.now() - p.msg.scheduledAt >= RECOVERY_MAX_AGE_MS) {
      await this.terminate({ id: 'run:' + p.msg.runId, msg: p.msg, reason: 'queue handoff expired or exhausted' }, PENDING_PREFIX + p.msg.runId)
      return
    }
    // Keep the original run ID until acknowledgement, including interrupted sends.
    const delay = Math.min(REDELIVERY_DELAY_MS * 2 ** Math.min(p.deliveries, 4), 5 * 60_000)
    await this.schedule({ ...p, dueAt: Date.now() + delay, deliveries: p.deliveries + 1 })
    try {
      if ((await withDeadline(getSafetySettings(this.env.DB))).paused) {
        await this.terminate({ id: 'run:' + p.msg.runId, msg: p.msg, reason: 'execution paused by safety switch' }, PENDING_PREFIX + p.msg.runId)
        return
      }
      if (p.deliveries > 0) {
        const running = await this.ctx.storage.get<RunningSlot>(K_RUNNING)
        if (running?.runId === p.msg.runId) {
          await this.ctx.storage.put(K_RUNNING, { ...running, leaseUntil: Date.now() + p.leaseMs })
        }
      }
      await withDeadline(runQueue(this.env).send(p.msg))
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
      await withDeadline(this.ctx.exports.RunExecutor.start(p.msg, p.deliveries))
    } catch (err) {
      await this.redeliver(p, err)
    }
  }

  private async runDirect(p: PendingRun): Promise<void> {
    try {
      await withDeadline(processRun(p.msg, this.env, this.directTransport()), 320_000)
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
      await withDeadline(disableFiredOnceTask(this.env.DB, snapshot.taskId, snapshot.version, Date.now()))
    } catch (err) {
      console.error('failed to disable fired once task; reconcile will retry', snapshot.taskId, err)
    }
  }
}
