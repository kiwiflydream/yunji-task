import { Hono } from 'hono'
import { z } from 'zod'
import { requireApiToken } from '../auth/api-token'
import { getRun, listRuns } from '../domain/runs-repo'
import { alertSettingsSchema, getAlertSettings, getRuntimeSettings, putAlertSettings, putRuntimeSettings, runtimeSettingsSchema } from '../domain/settings'
import { hasRunQueue } from '../executor/mode'
import type { Task } from '../domain/task'
import * as service from '../domain/task-service'
import { ValidationError, zodIssues } from '../domain/task-service'
import { getTask, listTasks } from '../domain/tasks-repo'
import { deleteVariable, listVariables, upsertVariable } from '../domain/variables'
import { VARIABLE_NAME_RE } from '../lib/template'
import { isValidTimezone } from '../lib/time'
import type { StatsOverview, TaskStats } from '../shared/types'
import { addAgg, bucketize, emptyAgg, histogram, rankTasks, STATS_RANGES, statsWindow, summarize, toPoints } from '../domain/stats'
import { statsByHour, statsByTask } from '../domain/stats-repo'

const variableBodySchema = z.object({
  value: z.string().min(1).max(16 * 1024),
  description: z.string().max(500).default(''),
})

const runsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().max(128).transform((value) => {
    const separator = value.indexOf(':')
    return { createdAt: Number(value.slice(0, separator)), id: value.slice(separator + 1) }
  }).pipe(z.object({ createdAt: z.number().int().positive(), id: z.uuid() })).optional(),
})

const statsQuerySchema = z.object({
  range: z.enum(STATS_RANGES).default('24h'),
  tz: z.string().default('UTC').refine(isValidTimezone, '无效的时区'),
})

function parseStatsQuery(query: Record<string, string>) {
  const q = statsQuerySchema.safeParse(query)
  if (!q.success) throw new ValidationError(zodIssues(q.error))
  return statsWindow(q.data.range, Date.now(), q.data.tz)
}

async function seriesFor(db: D1Database, window: ReturnType<typeof statsWindow>, taskId?: string) {
  const hourly = await statsByHour(db, window.from, window.to, taskId)
  const total = hourly.reduce((acc, h) => addAgg(acc, h.agg), emptyAgg())
  const base = {
    range: window.range,
    granularity: window.granularity,
    from: window.from,
    to: window.to,
    summary: summarize(total),
    series: toPoints(window, bucketize(window, hourly)),
  }
  return { base, total }
}

function present(task: Task, now = Date.now()) {
  return { ...task, nextRunAt: service.nextRunAt(task, now) }
}

async function jsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    throw new ValidationError([{ path: '', message: '请求体必须是合法的 JSON' }])
  }
}

/**
 * Task/run/variable/settings JSON routes without authentication. Mounted at
 * /api (Bearer token) and /admin/api (admin auth).
 */
export const apiRoutes = new Hono<{ Bindings: CloudflareBindings }>()

apiRoutes.onError((err, c) => {
  if (err instanceof ValidationError) return c.json({ error: 'validation_failed', issues: err.issues }, 422)
  console.error('api error', err)
  return c.json({ error: 'internal_error' }, 500)
})

apiRoutes.notFound((c) => c.json({ error: 'not_found' }, 404))

apiRoutes.get('/tasks', async (c) => {
  const now = Date.now()
  const tasks = await listTasks(c.env.DB)
  return c.json({ tasks: tasks.map((t) => present(t, now)) })
})

apiRoutes.post('/tasks', async (c) => {
  const task = await service.createTask(c.env, await jsonBody(c.req.raw))
  return c.json({ task: present(task) }, 201)
})

apiRoutes.get('/tasks/:id', async (c) => {
  const task = await getTask(c.env.DB, c.req.param('id'))
  return task ? c.json({ task: present(task) }) : c.json({ error: 'not_found' }, 404)
})

apiRoutes.put('/tasks/:id', async (c) => {
  const task = await service.updateTask(c.env, c.req.param('id'), await jsonBody(c.req.raw))
  return task ? c.json({ task: present(task) }) : c.json({ error: 'not_found' }, 404)
})

apiRoutes.delete('/tasks/:id', async (c) => {
  const deleted = await service.deleteTask(c.env, c.req.param('id'))
  return deleted ? c.body(null, 204) : c.json({ error: 'not_found' }, 404)
})

apiRoutes.post('/tasks/:id/enable', async (c) => {
  const task = await service.setTaskEnabled(c.env, c.req.param('id'), true)
  return task ? c.json({ task: present(task) }) : c.json({ error: 'not_found' }, 404)
})

apiRoutes.post('/tasks/:id/disable', async (c) => {
  const task = await service.setTaskEnabled(c.env, c.req.param('id'), false)
  return task ? c.json({ task: present(task) }) : c.json({ error: 'not_found' }, 404)
})

apiRoutes.post('/tasks/:id/trigger', async (c) => {
  const runId = await service.triggerTask(c.env, c.req.param('id'))
  return runId ? c.json({ runId }, 202) : c.json({ error: 'not_found' }, 404)
})

apiRoutes.get('/tasks/:id/scheduler', async (c) => {
  const task = await getTask(c.env.DB, c.req.param('id'))
  if (!task) return c.json({ error: 'not_found' }, 404)
  return c.json({ scheduler: await c.env.TASK_SCHEDULER.getByName(task.id).status() })
})

apiRoutes.get('/tasks/:id/runs', async (c) => {
  const q = runsQuerySchema.safeParse(c.req.query())
  if (!q.success) throw new ValidationError(zodIssues(q.error))
  const runs = await listRuns(c.env.DB, c.req.param('id'), q.data)
  const last = runs.at(-1)
  const nextBefore = runs.length === q.data.limit && last ? `${last.createdAt}:${last.id}` : null
  return c.json({ runs, nextBefore })
})

apiRoutes.get('/tasks/:id/stats', async (c) => {
  const window = parseStatsQuery(c.req.query())
  const task = await getTask(c.env.DB, c.req.param('id'))
  if (!task) return c.json({ error: 'not_found' }, 404)
  const { base, total } = await seriesFor(c.env.DB, window, task.id)
  return c.json<TaskStats>({ ...base, histogram: histogram(total) })
})

apiRoutes.get('/stats/overview', async (c) => {
  const window = parseStatsQuery(c.req.query())
  const [{ base }, perTask] = await Promise.all([
    seriesFor(c.env.DB, window),
    statsByTask(c.env.DB, window.from, window.to),
  ])
  return c.json<StatsOverview>({ ...base, ...rankTasks(perTask) })
})

apiRoutes.get('/runs/:id', async (c) => {
  const run = await getRun(c.env.DB, c.req.param('id'))
  return run ? c.json({ run }) : c.json({ error: 'not_found' }, 404)
})

apiRoutes.get('/variables', async (c) => c.json({ variables: await listVariables(c.env.DB) }))

apiRoutes.put('/variables/:name', async (c) => {
  const name = c.req.param('name')
  if (!VARIABLE_NAME_RE.test(name)) {
    throw new ValidationError([{ path: 'name', message: '只能包含字母、数字、下划线，且不能以数字开头' }])
  }
  const body = variableBodySchema.safeParse(await jsonBody(c.req.raw))
  if (!body.success) throw new ValidationError(zodIssues(body.error))
  await upsertVariable(c.env.DB, c.env.ENCRYPTION_KEY, { name, ...body.data }, Date.now())
  return c.body(null, 204)
})

apiRoutes.delete('/variables/:name', async (c) => {
  const deleted = await deleteVariable(c.env.DB, c.req.param('name'))
  return deleted ? c.body(null, 204) : c.json({ error: 'not_found' }, 404)
})

apiRoutes.get('/settings/alert', async (c) => c.json({ alert: await getAlertSettings(c.env.DB) }))

apiRoutes.get('/settings/runtime', async (c) => {
  c.header('cache-control', 'no-store')
  return c.json({ settings: await getRuntimeSettings(c.env.DB) })
})

apiRoutes.put('/settings/runtime', async (c) => {
  const body = runtimeSettingsSchema.safeParse(await jsonBody(c.req.raw))
  if (!body.success) throw new ValidationError(zodIssues(body.error))
  if (body.data.executionMode === 'queue' && !hasRunQueue(c.env)) {
    throw new ValidationError([{ path: 'executionMode', message: '当前部署没有配置 Queue，不能选择队列执行' }])
  }
  await putRuntimeSettings(c.env.DB, body.data, Date.now())
  return c.json({ settings: body.data })
})

apiRoutes.put('/settings/alert', async (c) => {
  const body = alertSettingsSchema.safeParse(await jsonBody(c.req.raw))
  if (!body.success) throw new ValidationError(zodIssues(body.error))
  await putAlertSettings(c.env.DB, body.data, Date.now())
  return c.json({ alert: body.data })
})

export const api = new Hono<{ Bindings: CloudflareBindings }>()

api.use('*', requireApiToken)
api.route('/', apiRoutes)
api.notFound((c) => c.json({ error: 'not_found' }, 404))
