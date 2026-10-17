import { getLocale, localizeIssueMessage } from './locale'
import type { Task, TaskInputRaw, TaskSummary } from '../../src/domain/task'
import type {
  AdminMe,
  AlertSettings,
  Issue,
  Run,
  RuntimeSettings,
  SchedulerStatus,
  StatsOverview,
  StatsRange,
  TaskStats,
  VariableInfo,
} from '../../src/shared/types'
import { viewerTimezone } from './lib/format'

export type TaskView = Task & { nextRunAt: number | null }
export type TaskSummaryView = TaskSummary & { nextRunAt: number | null }

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: { error?: string; message?: string; issues?: Issue[] } | null,
  ) {
    super(body?.issues?.map((i) => i.message).join('；') || body?.message || body?.error || `HTTP ${status}`)
  }

  get issues(): Issue[] {
    return this.body?.issues ?? []
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/admin/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...init.headers },
  })
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, body)
  return body as T
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
})

export const api = {
  me: () => request<AdminMe>('/me'),
  tasks: () => request<{ tasks: TaskSummaryView[] }>('/tasks').then((r) => r.tasks),
  task: (id: string) => request<{ task: TaskView }>(`/tasks/${id}`).then((r) => r.task),
  scheduler: (id: string) =>
    request<{ scheduler: SchedulerStatus }>(`/tasks/${id}/scheduler`).then((r) => r.scheduler),
  createTask: (input: TaskInputRaw) => request<{ task: TaskView }>('/tasks', json('POST', input)).then((r) => r.task),
  updateTask: (id: string, input: TaskInputRaw) =>
    request<{ task: TaskView }>(`/tasks/${id}`, json('PUT', input)).then((r) => r.task),
  deleteTask: (id: string) => request<void>(`/tasks/${id}`, json('DELETE')),
  setEnabled: (id: string, enabled: boolean) =>
    request<{ task: TaskView }>(`/tasks/${id}/${enabled ? 'enable' : 'disable'}`, json('POST')).then((r) => r.task),
  trigger: (id: string) => request<{ runId: string }>(`/tasks/${id}/trigger`, json('POST')).then((r) => r.runId),
  runs: (id: string, before?: number) =>
    request<{ runs: Run[]; nextBefore: number | null }>(
      `/tasks/${id}/runs?limit=50${before ? `&before=${before}` : ''}`,
    ),
  statsOverview: (range: StatsRange) =>
    request<StatsOverview>(`/stats/overview?range=${range}&tz=${encodeURIComponent(viewerTimezone)}`),
  taskStats: (id: string, range: StatsRange) =>
    request<TaskStats>(`/tasks/${id}/stats?range=${range}&tz=${encodeURIComponent(viewerTimezone)}`),
  variables: () => request<{ variables: VariableInfo[] }>('/variables').then((r) => r.variables),
  putVariable: (name: string, value: string, description: string) =>
    request<void>(`/variables/${encodeURIComponent(name)}`, json('PUT', { value, description })),
  deleteVariable: (name: string) => request<void>(`/variables/${encodeURIComponent(name)}`, json('DELETE')),
  alert: () => request<{ alert: AlertSettings }>('/settings/alert').then((r) => r.alert),
  putAlert: (alert: AlertSettings) =>
    request<{ alert: AlertSettings }>('/settings/alert', json('PUT', alert)).then((r) => r.alert),
  putRuntimeSettings: (settings: RuntimeSettings) =>
    request<{ settings: RuntimeSettings }>('/settings/runtime', json('PUT', settings)).then((r) => r.settings),
}

export const errorMessage = (err: unknown) => err instanceof ApiError && err.issues.length
  ? err.issues.map((issue) => localizeIssueMessage(issue.message)).join(getLocale() === 'en' ? '; ' : '；')
  : err instanceof Error ? err.message : String(err)
