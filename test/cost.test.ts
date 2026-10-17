// D1 bills every row written, including each index entry a write touches.
// These tests pin the per-run write budget and the query plans that keep the
// periodic sweeps off full table scans.
import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import {
  claimRun,
  getRun,
  insertSkippedRun,
  LOST_WHERE,
  PURGE_BATCH,
  PURGE_RUNS_SQL,
  purgeOldRuns,
  recordAttempt,
} from '../src/domain/runs-repo'
import { deleteTask } from '../src/domain/tasks-repo'
import { runMaintenance } from '../src/maintenance/maintenance'
import { createTaskRow } from './helpers'

/** A D1 binding that sums rows_written over everything executed through it. */
function meteredDb(db: D1Database) {
  const meter = { written: 0 }
  const real = new WeakMap<object, D1PreparedStatement>()
  const count = (r: D1Result) => {
    meter.written += r.meta.rows_written
    return r
  }
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, key) {
        if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args))
        if (key === 'run' || key === 'all') return async () => count(await target[key]())
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    real.set(proxy, stmt)
    return proxy
  }
  const metered = {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: async (stmts: D1PreparedStatement[]) => {
      const results = await db.batch(stmts.map((s) => real.get(s) ?? s))
      results.forEach(count)
      return results
    },
  } as unknown as D1Database
  return { db: metered, meter }
}

const success = { httpStatus: 200, responseBody: 'ok', error: null, durationMs: 120 }

describe('rows written per run', () => {
  it('a successful run costs 3 (claim) + 1 (stats, +1 for the minute\'s first run) + 1 (result) + 1 (purge)', async () => {
    const task = await createTaskRow()
    const { db, meter } = meteredDb(env.DB)
    const at = Date.UTC(2026, 9, 16, 9, 10)
    const write = async (fn: () => Promise<unknown>) => {
      const before = meter.written
      await fn()
      return meter.written - before
    }

    const costs = []
    for (let i = 0; i < 2; i++) {
      const msg = { runId: crypto.randomUUID(), taskId: task.id, trigger: 'schedule' as const, scheduledAt: at, attempt: 1 }
      costs.push({
        claim: await write(() => claimRun(db, msg, at + 100)),
        result: await write(() => recordAttempt(db, msg.runId, 'success', success, at + 300)),
      })
    }
    expect(costs).toEqual([
      { claim: 3, result: 3 }, // stats row insert + its time index, run update
      { claim: 3, result: 2 },
    ])
    expect(await write(() => purgeOldRuns(db, [task.id], Number.MAX_SAFE_INTEGER))).toBe(2)
  })

  it('a skipped fire costs 2 (run row; never in the in-flight index) + 1 (stats)', async () => {
    const task = await createTaskRow()
    const { db, meter } = meteredDb(env.DB)
    const at = Date.UTC(2026, 9, 16, 9, 20)
    await insertSkippedRun(db, { taskId: task.id, scheduledAt: at, reason: 'busy' }, at) // first of the minute
    const before = meter.written
    await insertSkippedRun(db, { taskId: task.id, scheduledAt: at + 1000, reason: 'busy' }, at + 1000)
    expect(meter.written - before).toBe(3)
  })
})

async function plan(sql: string, ...params: unknown[]) {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>()
  return results.map((r) => r.detail).join(' | ')
}

describe('query plans', () => {
  it('incremental maintenance uses the pending-action and dirty-task indexes', async () => {
    const actions = await plan(`SELECT id FROM run_actions WHERE failed_at IS NULL AND due_at <= ? AND lease_until <= ? ORDER BY due_at LIMIT ?`, 1, 1, 100)
    expect(actions).toMatch(/USING INDEX idx_run_actions_due/)
    const tasks = await plan('SELECT * FROM tasks WHERE scheduler_synced_version < version')
    expect(tasks).toMatch(/USING INDEX idx_tasks_unsynced/)
  })
  it('the lost-run sweep reads only the in-flight partial index', async () => {
    const p = await plan(`SELECT id FROM runs WHERE ${LOST_WHERE}`, 1, 1)
    expect(p).toMatch(/USING (COVERING )?INDEX idx_runs_inflight/)
    expect(p).not.toMatch(/SCAN runs(?! USING)/)
  })

  it('retention purge seeks the per-task index', async () => {
    const p = await plan(PURGE_RUNS_SQL, 't', 1)
    expect(p).toMatch(/USING (COVERING )?INDEX idx_runs_task_created \(task_id=\? AND created_at<\?\)/)
  })

  it('minute statistics use time and per-task indexes', async () => {
    expect(await plan('SELECT SUM(success) FROM run_stats WHERE bucket >= ? AND bucket <= ?', 1, 2))
      .toMatch(/USING INDEX idx_run_stats_bucket/)
    expect(await plan('SELECT SUM(success) FROM run_stats WHERE task_id = ? AND bucket >= ? AND bucket <= ?', 'task', 1, 2))
      .toMatch(/USING PRIMARY KEY \(task_id=\? AND bucket>\? AND bucket<\?\)/)
  })
})

describe('runs of deleted tasks', () => {
  it('cannot be claimed or recorded as skipped, so no orphan escapes the per-task purge', async () => {
    const task = await createTaskRow()
    await deleteTask(env.DB, task.id)
    const runId = crypto.randomUUID()
    expect(await claimRun(env.DB, { runId, taskId: task.id, trigger: 'manual', scheduledAt: 1, attempt: 1 }, 1)).toBe(false)
    expect(await getRun(env.DB, runId)).toBeNull()
    await insertSkippedRun(env.DB, { taskId: task.id, scheduledAt: 1, reason: 'busy' }, 1)
    const { results } = await env.DB.prepare('SELECT id FROM runs WHERE task_id = ?').bind(task.id).all()
    expect(results).toEqual([])
  })
})

describe('retention purge backlog', () => {
  it('keeps purging a task past the per-statement limit within one maintenance run', async () => {
    const task = await createTaskRow()
    const other = await createTaskRow()
    const old = Date.now() - 40 * 24 * 60 * 60_000
    const total = PURGE_BATCH * 2 + 7
    const insert = env.DB.prepare(
      `INSERT INTO runs (id, task_id, trigger, status, attempt, scheduled_at, created_at, updated_at)
       VALUES (?, ?, 'manual', 'success', 1, ?, ?, ?)`,
    )
    const rows = Array.from({ length: total }, () => insert.bind(crypto.randomUUID(), task.id, old, old, old))
    for (let i = 0; i < rows.length; i += 500) await env.DB.batch(rows.slice(i, i + 500))
    await env.DB.batch([insert.bind(crypto.randomUUID(), other.id, old, old, old)])

    vi.spyOn(console, 'log').mockImplementation(() => {})
    const report = await runMaintenance(env)
    vi.restoreAllMocks()
    expect(report.purgedRuns).toBeGreaterThanOrEqual(total + 1)
    const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM runs WHERE task_id IN (?, ?)')
      .bind(task.id, other.id)
      .all<{ n: number }>()
    expect(results[0].n).toBe(0)
  })
})
