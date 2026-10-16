import {
  Banner,
  Button,
  Input,
  InputArea,
  LayerCard,
  LinkButton,
  Radio,
  Select,
  Switch,
  Tabs,
  Text,
  useKumoToastManager,
} from '@cloudflare/kumo'
import { PlusIcon, TrashIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState, type ReactNode } from 'react'
import { useLocation } from 'wouter'
import { HTTP_METHODS } from '../../../src/executor/http'
import { nextFireTime, validateCron } from '../../../src/lib/schedule'
import { isValidTimezone } from '../../../src/lib/time'
import type { Issue } from '../../../src/shared/types'
import { api, ApiError } from '../api'
import { PageHeader } from '../components/PageHeader'
import { ErrorBanner, PageLoader } from '../components/States'
import { MODE_LABEL, suggestionText, WORKER_MAX_TIMEOUT_SECONDS } from '../lib/execution-mode'
import { fmtTime } from '../lib/format'
import {
  emptyTaskForm,
  formToPayload,
  mapIssues,
  taskToForm,
  type FormField,
  type HeaderRow,
  type ScheduleKind,
  type TaskFormState,
} from '../lib/task-form'

export function TaskFormPage({ id }: { id?: string }) {
  const existing = useQuery({ queryKey: ['task', id], queryFn: () => api.task(id!), enabled: !!id })
  if (id && existing.isPending) return <PageLoader />
  if (id && existing.isError) return <ErrorBanner error={existing.error} />
  // `initial` is read once on mount; the key remounts the form when switching tasks.
  return (
    <TaskForm
      key={id ?? 'new'}
      id={id}
      initial={existing.data ? taskToForm(existing.data) : emptyTaskForm}
      taskName={existing.data?.name}
    />
  )
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <LayerCard>
      <LayerCard.Secondary>
        <div className="flex flex-col">
          <span>{title}</span>
          {description && (
            <Text size="xs" variant="secondary">
              {description}
            </Text>
          )}
        </div>
      </LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-4">{children}</LayerCard.Primary>
    </LayerCard>
  )
}

function TaskForm({ id, initial, taskName }: { id?: string; initial: TaskFormState; taskName?: string }) {
  const [, navigate] = useLocation()
  const toasts = useKumoToastManager()
  const qc = useQueryClient()
  const [f, setF] = useState(initial)
  const [errors, setErrors] = useState<Partial<Record<FormField, string>>>({})
  const [otherIssues, setOtherIssues] = useState<Issue[]>([])

  const set = <K extends FormField>(key: K, value: TaskFormState[K]) => {
    setF((prev) => ({ ...prev, [key]: value }))
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: undefined }))
  }

  const showIssues = (issues: Issue[]) => {
    const mapped = mapIssues(issues)
    setErrors(mapped.fields)
    setOtherIssues(mapped.other)
  }

  const save = useMutation({
    mutationFn: async () => {
      const out = formToPayload(f)
      if ('issues' in out) throw new ApiError(422, { issues: out.issues })
      return id ? api.updateTask(id, out.payload) : api.createTask(out.payload)
    },
    onSuccess: (task) => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.setQueryData(['task', task.id], task)
      toasts.add({ title: id ? '已保存' : '任务已创建', variant: 'success' })
      navigate(`/tasks/${task.id}`)
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 422) showIssues(err.issues)
      else setOtherIssues([{ path: '', message: err instanceof Error ? err.message : String(err) }])
    },
  })

  const err = (key: FormField) => (errors[key] ? { error: errors[key] } : {})
  const hasErrors = Object.values(errors).some(Boolean) || otherIssues.length > 0

  return (
    <>
      <PageHeader
        crumbs={[
          { label: '任务', href: '/' },
          ...(id ? [{ label: taskName ?? '任务', href: `/tasks/${id}` }, { label: '编辑' }] : [{ label: '新建' }]),
        ]}
        title={id ? `编辑：${taskName}` : '新建任务'}
      />
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        {hasErrors && (
          <Banner
            variant="error"
            icon={<WarningCircleIcon weight="fill" />}
            title="保存失败，请检查标出的字段"
            description={otherIssues.length ? otherIssues.map((i) => (i.path ? `${i.path}: ` : '') + i.message).join('；') : undefined}
          />
        )}

        <Section title="基本信息">
          <Input label="名称" value={f.name} onChange={(e) => set('name', e.target.value)} {...err('name')} />
          <Input
            label="描述（可选）"
            value={f.description}
            onChange={(e) => set('description', e.target.value)}
            {...err('description')}
          />
          <Switch label="启用" checked={f.enabled} onCheckedChange={(v) => set('enabled', v)} />
        </Section>

        <Section title="调度">
          <Tabs
            variant="segmented"
            value={f.scheduleType}
            onValueChange={(v) => set('scheduleType', v as ScheduleKind)}
            tabs={[
              { value: 'cron', label: 'Cron（秒级）' },
              { value: 'once', label: '一次性' },
              { value: 'manual', label: '仅手动 / API' },
            ]}
          />
          {f.scheduleType === 'cron' && (
            <>
              <Input
                label="Cron 表达式"
                className="font-mono"
                value={f.cron}
                onChange={(e) => set('cron', e.target.value)}
                description="6 段：秒 分 时 日 月 周。例：*/10 * * * * * 每 10 秒；0 30 9 * * 1-5 工作日 9:30"
                {...err('cron')}
              />
              <CronPreview cron={f.cron} timezone={f.timezone} hideError={!!errors.cron} />
            </>
          )}
          {f.scheduleType === 'once' && (
            <Input
              label="执行时间"
              type="datetime-local"
              step={1}
              value={f.runAt}
              onChange={(e) => set('runAt', e.target.value)}
              description="按下面的时区解释"
              {...err('runAt')}
            />
          )}
          <Input
            label="时区"
            value={f.timezone}
            onChange={(e) => set('timezone', e.target.value)}
            description="IANA 时区，例如 Asia/Shanghai、UTC"
            {...err('timezone')}
          />
        </Section>

        <Section title="HTTP 请求" description="URL、请求头和 Body 中可以用 {{变量名}} 引用加密变量。">
          <div className="grid gap-4 sm:grid-cols-[9rem_1fr]">
            <Select
              label="方法"
              value={f.method}
              onValueChange={(v) => set('method', String(v))}
            >
              {HTTP_METHODS.map((m) => (
                <Select.Option key={m} value={m}>
                  {m}
                </Select.Option>
              ))}
            </Select>
            <Input
              label="URL"
              className="font-mono"
              placeholder="https://example.com/job?token={{TOKEN}}"
              value={f.url}
              onChange={(e) => set('url', e.target.value)}
              {...err('url')}
            />
          </div>
          <HeadersEditor rows={f.headers} onChange={(rows) => set('headers', rows)} error={errors.headers} />
          <InputArea
            label="Body（可选）"
            className="font-mono"
            rows={4}
            value={f.body}
            onChange={(e) => set('body', e.target.value)}
            description="GET / HEAD 请求不发送 Body"
            {...err('body')}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="超时（秒）"
              type="number"
              min={1}
              max={300}
              value={f.timeoutSeconds}
              onChange={(e) => set('timeoutSeconds', e.target.value)}
              description="1–300"
              {...err('timeoutSeconds')}
            />
            <Input
              label="成功关键字（可选）"
              value={f.successKeyword}
              onChange={(e) => set('successKeyword', e.target.value)}
              description="2xx 且响应体包含该字符串才算成功"
              {...err('successKeyword')}
            />
          </div>
        </Section>

        <Section title="执行策略">
          <ExecutionModeField
            taskId={id}
            timeoutSeconds={f.timeoutSeconds}
            value={f.executionMode}
            onChange={(v) => set('executionMode', v)}
            error={errors.executionMode}
          />
          <Radio.Group
            legend="上次执行未结束时"
            orientation="horizontal"
            value={f.overlapPolicy}
            onValueChange={(v) => set('overlapPolicy', v as TaskFormState['overlapPolicy'])}
          >
            <Radio.Item label="跳过本次" value="skip" />
            <Radio.Item label="并行执行" value="parallel" />
          </Radio.Group>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="失败重试次数"
              type="number"
              min={0}
              max={10}
              value={f.retryCount}
              onChange={(e) => set('retryCount', e.target.value)}
              description="0–10，0 表示不重试"
              {...err('retryCount')}
            />
            <Input
              label="重试间隔（秒）"
              type="number"
              min={1}
              max={3600}
              value={f.retryIntervalSeconds}
              onChange={(e) => set('retryIntervalSeconds', e.target.value)}
              description="1–3600"
              {...err('retryIntervalSeconds')}
            />
          </div>
        </Section>

        <Section title="失败告警" description="最后一次重试仍失败时调用 webhook。">
          <Radio.Group
            legend="告警方式"
            orientation="horizontal"
            value={f.alertMode}
            onValueChange={(v) => set('alertMode', v as TaskFormState['alertMode'])}
          >
            <Radio.Item label="使用全局设置" value="inherit" />
            <Radio.Item label="关闭" value="off" />
            <Radio.Item label="自定义" value="custom" />
          </Radio.Group>
          {f.alertMode === 'custom' && (
            <>
              <Input
                label="Webhook URL"
                className="font-mono"
                value={f.alertUrl}
                onChange={(e) => set('alertUrl', e.target.value)}
                {...err('alertUrl')}
              />
              <InputArea
                label="Body 模板（可选）"
                className="font-mono"
                rows={4}
                value={f.alertBodyTemplate}
                onChange={(e) => set('alertBodyTemplate', e.target.value)}
                description="留空则发送默认 JSON；可用占位符见「设置」页"
                {...err('alertBodyTemplate')}
              />
            </>
          )}
        </Section>

        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" loading={save.isPending}>
            {id ? '保存' : '创建任务'}
          </Button>
          <LinkButton href={id ? `/tasks/${id}` : '/'} variant="ghost">
            取消
          </LinkButton>
        </div>
      </form>
    </>
  )
}

function ExecutionModeField({
  taskId,
  timeoutSeconds,
  value,
  onChange,
  error,
}: {
  taskId?: string
  timeoutSeconds: string
  value: TaskFormState['executionMode']
  onChange: (v: TaskFormState['executionMode']) => void
  error?: string
}) {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  // Suggest from this task's own recent durations (editing only).
  const stats = useQuery({
    queryKey: ['stats', 'task', taskId, '7d'],
    queryFn: () => api.taskStats(taskId!, '7d'),
    enabled: !!taskId,
  })
  const queueAvailable = me.data?.queueAvailable ?? true
  const p95 = stats.data?.summary.durationP95 ?? null
  // An unparseable timeout is reported on its own field; assume the default meanwhile.
  const timeout = Number(timeoutSeconds)
  const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout * 1000 : 25_000
  const workerFits = timeoutMs <= WORKER_MAX_TIMEOUT_SECONDS * 1000
  return (
    <Radio.Group
      legend="执行方式"
      appearance="card"
      orientation="horizontal"
      value={value}
      onValueChange={(v) => onChange(v as TaskFormState['executionMode'])}
      error={error}
      description={!taskId || stats.data ? suggestionText(p95, timeoutMs, queueAvailable) : undefined}
    >
      <Radio.Item
        label="跟随全局"
        value="inherit"
        description={me.data ? `当前全局：${MODE_LABEL[me.data.executionMode]}（设置页可修改）` : '可在设置页修改全局方式'}
      />
      <Radio.Item
        label={MODE_LABEL.worker}
        value="worker"
        disabled={!workerFits && value !== 'worker'}
        description={
          workerFits
            ? '交给 Worker 后台执行，等待不计费，通常最便宜'
            : `需要把超时设在 ${WORKER_MAX_TIMEOUT_SECONDS} 秒以内`
        }
      />
      <Radio.Item
        label={MODE_LABEL.queue}
        value="queue"
        disabled={!queueAvailable && value !== 'queue'}
        description={queueAvailable ? '经 Queue 投递执行，适合超时较长的慢接口' : '当前部署没有配置 Queue'}
      />
      <Radio.Item label={MODE_LABEL.direct} value="direct" description="调度器 DO 直接请求，等待按时长计费" />
    </Radio.Group>
  )
}

function CronPreview({ cron, timezone, hideError }: { cron: string; timezone: string; hideError: boolean }) {
  const preview = useMemo(() => {
    if (!isValidTimezone(timezone)) return { error: '时区无效' }
    const error = validateCron(cron, timezone)
    if (error) return { error }
    const times: number[] = []
    let after = Date.now()
    for (let i = 0; i < 3; i++) {
      const next = nextFireTime({ scheduleType: 'cron', cron, timezone, runAt: null }, after)
      if (next === null) break
      times.push(next)
      after = next
    }
    return { times }
  }, [cron, timezone])

  if ('error' in preview && hideError) return null
  return (
    <div className="rounded-lg bg-kumo-recessed px-3 py-2 text-sm">
      {'error' in preview ? (
        <Text variant="error" size="sm">
          {preview.error}
        </Text>
      ) : (
        <Text variant="secondary" size="sm">
          接下来：{preview.times.length ? preview.times.map((t) => fmtTime(t, timezone)).join('、') : '不会再触发'}
          <span className="ml-1">（{timezone}）</span>
        </Text>
      )}
    </div>
  )
}

function HeadersEditor({
  rows,
  onChange,
  error,
}: {
  rows: HeaderRow[]
  onChange: (rows: HeaderRow[]) => void
  error?: string
}) {
  const update = (i: number, patch: Partial<HeaderRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div className="flex flex-col gap-2">
      <Text size="sm" bold as="span">
        请求头
      </Text>
      {rows.map((row, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] gap-2">
          <Input
            aria-label={`请求头 ${i + 1} 名称`}
            placeholder="Authorization"
            className="font-mono"
            value={row.key}
            onChange={(e) => update(i, { key: e.target.value })}
          />
          <Input
            aria-label={`请求头 ${i + 1} 值`}
            placeholder="Bearer {{API_KEY}}"
            className="font-mono"
            value={row.value}
            onChange={(e) => update(i, { value: e.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            shape="square"
            icon={TrashIcon}
            aria-label="删除请求头"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          />
        </div>
      ))}
      {error && (
        <Text variant="error" size="sm">
          {error}
        </Text>
      )}
      <div>
        <Button type="button" size="sm" icon={PlusIcon} onClick={() => onChange([...rows, { key: '', value: '' }])}>
          添加请求头
        </Button>
      </div>
    </div>
  )
}
