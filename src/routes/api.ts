import { cachedStats } from '../domain/stats-cache'
import { getSafetySettings, putSafetySettings, safetySettingsSchema, SafetyError, RUN_HEADER } from '../domain/safety'
import { Hono } from 'hono'
import { z } from 'zod'
import { requireApiToken } from '../auth/api-token'
import { getRun, listRuns } from '../domain/runs-repo'
import { alertSettingsSchema, getAlertSettingsState, getRuntimeSettingsState, putAlertSettings, putRuntimeSettings, runtimeSettingsSchema } from '../domain/settings'
import { hasRunQueue } from '../executor/mode'
import type { Task } from '../domain/task'
import * as service from '../domain/task-service'
import { ConflictError, ValidationError, zodIssues } from '../domain/task-service'
import { getTask, listTasks } from '../domain/tasks-repo'
import { createVariable, deleteVariable, listVariables, upsertVariable } from '../domain/variables'
import { VARIABLE_NAME_RE } from '../lib/template'
import { isValidTimezone } from '../lib/time'
import type { StatsOverview, TaskStats } from '../shared/types'
import { addAgg, bucketize, emptyAgg, histogram, rankTasks, STATS_RANGES, statsWindow, summarize, toPoints } from '../domain/stats'
import { statsForWindow, statsByTask } from '../domain/stats-repo'

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
  const rows = await statsForWindow(db, window, taskId)
  const total = rows.reduce((acc, row) => addAgg(acc, row.agg), emptyAgg())
  const base = {
    range: window.range,
    granularity: window.granularity,
    from: window.from,
    to: window.to,
    summary: summarize(total),
    series: toPoints(window, bucketize(window, rows)),
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

class PreconditionRequiredError extends Error {}

function expectedVersion(request: Request): number {
  const header = request.headers.get('if-match')
  if (header === null) throw new PreconditionRequiredError('If-Match is required; read the current ETag before updating')
  const match = /^"(0|[1-9]\d*)"$/.exec(header)
  const version = match ? Number(match[1]) : NaN
  if (!Number.isSafeInteger(version)) throw new ValidationError([{ path: 'If-Match', message: 'If-Match 必须是双引号包围的整数版本号' }])
  return version
}

/**
 * Task/run/variable/settings JSON routes without authentication. Mounted at
 * /api (Bearer token) and /admin/api (admin auth).
 */
export const apiRoutes = new Hono<{ Bindings: CloudflareBindings }>()

apiRoutes.onError((err, c) => {
  if (err instanceof PreconditionRequiredError) return c.json({ error: 'precondition_required', message: err.message }, 428)
  if (err instanceof SafetyError) return c.json({ error: 'execution_blocked', message: err.message }, 429)
  if (err instanceof ValidationError) return c.json({ error: 'validation_failed', issues: err.issues }, 422)
  if (err instanceof ConflictError) return c.json({ error: 'conflict', message: err.message }, 409)
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
  c.header('etag', `"${task.version}"`)
  return c.json({ task: present(task) }, 201)
})

apiRoutes.get('/tasks/:id', async (c) => {
  const task = await getTask(c.env.DB, c.req.param('id'))
  if (task) c.header('etag', `"${task.version}"`)
  return task ? c.json({ task: present(task) }) : c.json({ error: 'not_found' }, 404)
})

apiRoutes.put('/tasks/:id', async (c) => {
  const expected = expectedVersion(c.req.raw)
  const task = await service.updateTask(c.env, c.req.param('id'), await jsonBody(c.req.raw), expected)
  if (task) c.header('etag', `"${task.version}"`)
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
  if (c.req.header(RUN_HEADER)) throw new SafetyError('recursive task triggers are blocked')
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
  const result = await cachedStats(c.env.DB, JSON.stringify(['task',task.id,window.range,window.buckets]), async () => {
    const { base, total } = await seriesFor(c.env.DB, window, task.id)
    return { ...base, histogram: histogram(total) }
  })
  return c.json<TaskStats>(result)
})

apiRoutes.get('/stats/overview', async (c) => {
  const window = parseStatsQuery(c.req.query())
  const result = await cachedStats(c.env.DB, JSON.stringify(['overview',window.range,window.buckets]), async () => {
    const [{ base }, perTask] = await Promise.all([
      seriesFor(c.env.DB, window),
      statsByTask(c.env.DB, window.from, window.to),
    ])
    return { ...base, ...rankTasks(perTask) }
  })
  return c.json<StatsOverview>(result)
})

apiRoutes.get('/runs/:id', async (c) => {
  const run = await getRun(c.env.DB, c.req.param('id'))
  return run ? c.json({ run }) : c.json({ error: 'not_found' }, 404)
})

apiRoutes.get('/variables', async (c) => c.json({ variables: await listVariables(c.env.DB) }))

apiRoutes.on(['POST', 'PUT'], '/variables/:name', async (c) => {
  const name = c.req.param('name')
  if (!VARIABLE_NAME_RE.test(name)) {
    throw new ValidationError([{ path: 'name', message: '只能包含字母、数字、下划线，且不能以数字开头' }])
  }
  const body = variableBodySchema.safeParse(await jsonBody(c.req.raw))
  if (!body.success) throw new ValidationError(zodIssues(body.error))
  if (c.req.method === 'POST') {
    if (!await createVariable(c.env.DB, c.env.ENCRYPTION_KEY, { name, ...body.data }, Date.now())) {
      throw new ConflictError('同名变量已存在，请使用更新操作。')
    }
  } else await upsertVariable(c.env.DB, c.env.ENCRYPTION_KEY, { name, ...body.data }, Date.now())
  return c.body(null, 204)
})

apiRoutes.delete('/variables/:name', async (c) => {
  const deleted = await deleteVariable(c.env.DB, c.req.param('name'))
  return deleted ? c.body(null, 204) : c.json({ error: 'not_found' }, 404)
})

apiRoutes.get('/settings/alert', async (c) => {
  const state = await getAlertSettingsState(c.env.DB)
  c.header('cache-control', 'no-store')
  c.header('etag', `"${state.version}"`)
  return c.json(state)
})

apiRoutes.get('/settings/runtime', async (c) => {
  const state = await getRuntimeSettingsState(c.env.DB)
  c.header('cache-control', 'no-store')
  c.header('etag', `"${state.version}"`)
  return c.json(state)
})

apiRoutes.put('/settings/runtime', async (c) => {
  const expected = expectedVersion(c.req.raw)
  const body = runtimeSettingsSchema.safeParse(await jsonBody(c.req.raw))
  if (!body.success) throw new ValidationError(zodIssues(body.error))
  if (body.data.executionMode === 'queue' && !hasRunQueue(c.env)) {
    throw new ValidationError([{ path: 'executionMode', message: '当前部署没有配置 Queue，不能选择队列执行' }])
  }
  const version = await putRuntimeSettings(c.env.DB, body.data, Date.now(), expected)
  if (version === null) throw new ConflictError()
  c.header('etag', `"${version}"`)
  return c.json({ settings: body.data, version })
})

apiRoutes.put('/settings/alert', async (c) => {
  const expected = expectedVersion(c.req.raw)
  const body = alertSettingsSchema.safeParse(await jsonBody(c.req.raw))
  if (!body.success) throw new ValidationError(zodIssues(body.error))
  const version = await putAlertSettings(c.env.DB, body.data, Date.now(), expected)
  if (version === null) throw new ConflictError()
  c.header('etag', `"${version}"`)
  return c.json({ alert: body.data, version })
})


apiRoutes.get('/settings/safety', async (c) => {
  c.header('cache-control', 'no-store')
  return c.json({ settings: await getSafetySettings(c.env.DB) })
})
apiRoutes.put('/settings/safety', async (c) => {
  const parsed = safetySettingsSchema.safeParse(await jsonBody(c.req.raw))
  if (!parsed.success) throw new ValidationError(zodIssues(parsed.error))
  return c.json({ settings: await putSafetySettings(c.env.DB, parsed.data) })
})

export const api = new Hono<{ Bindings: CloudflareBindings }>()

api.use('*', requireApiToken)
api.route('/', apiRoutes)
api.notFound((c) => c.json({ error: 'not_found' }, 404))
