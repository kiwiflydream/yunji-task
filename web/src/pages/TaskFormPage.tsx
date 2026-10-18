import { localizeIssueMessage } from '../locale'
import { tr, useLocale } from '../i18n'
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
import { CronEditor } from '../components/CronEditor'
import { AlertTemplateHelp } from '../components/AlertTemplateHelp'
import { ExecutionModeGuide } from '../components/ExecutionModeGuide'
import { TimezoneSelect } from '../components/TimezoneSelect'
import { SuccessConditionEditor } from '../components/SuccessConditionEditor'
import { ErrorBanner, PageLoader } from '../components/States'
import { MODE_LABEL, suggestionText, WORKER_MAX_TIMEOUT_SECONDS } from '../lib/execution-mode'
import { fmtTime } from '../lib/format'
import { FORM_CONFLICT_MESSAGE, useVersionedForm } from '../lib/versioned-form'
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
  const existing = useQuery({ queryKey: ['task', id], queryFn: () => api.task(id!), enabled: !!id, refetchOnMount: 'always', staleTime: 0 })
  if (id && !existing.isFetchedAfterMount && !existing.isError) return <PageLoader />
  if (id && !existing.data) return <ErrorBanner error={existing.error} />
  // Only switching tasks remounts the editor. Refreshes preserve dirty drafts.
  return (
    <>
      {id && existing.isError && <ErrorBanner error={existing.error} />}
      <TaskForm
        key={id ?? 'new'}
        id={id}
        initial={existing.data ? taskToForm(existing.data) : emptyTaskForm}
        taskName={existing.data?.name}
        version={existing.data?.version ?? 0}
      />
    </>
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

function TaskForm({ id, initial, taskName, version }: { id?: string; initial: TaskFormState; taskName?: string; version: number }) {
  useLocale()

  const [, navigate] = useLocation()
  const toasts = useKumoToastManager()
  const qc = useQueryClient()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const { value: f, setValue: setF, version: formVersion, conflict } = useVersionedForm(initial, version)
  const [errors, setErrors] = useState<Partial<Record<FormField, string>>>({})
  const [otherIssues, setOtherIssues] = useState<Issue[]>([])

  const set = <K extends FormField>(key: K, value: TaskFormState[K] | ((previous: TaskFormState[K]) => TaskFormState[K])) => {
    setF((prev) => ({ ...prev, [key]: typeof value === 'function' ? value(prev[key]) : value }))
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
      return id ? api.updateTask(id, out.payload, formVersion) : api.createTask(out.payload)
    },
    onSuccess: (task) => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.setQueryData(['task', task.id], task)
      toasts.add({ title: id ? tr("已保存") : tr("任务已创建"), variant: 'success' })
      navigate(`/tasks/${task.id}`)
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) setOtherIssues([{ path: '', message: tr(FORM_CONFLICT_MESSAGE) }])
      else if (err instanceof ApiError && err.status === 422) showIssues(err.issues)
      else setOtherIssues([{ path: '', message: err instanceof Error ? err.message : String(err) }])
    },
  })

  const err = (key: FormField) => (errors[key] ? { error: localizeIssueMessage(errors[key]) } : {})
  const hasErrors = Object.values(errors).some(Boolean) || otherIssues.length > 0

  return (
    <>
      <PageHeader
        crumbs={[
          { label: tr("任务"), href: '/' },
          ...(id ? [{ label: taskName ?? tr("任务"), href: `/tasks/${id}` }, { label: tr("编辑") }] : [{ label: tr("新建") }]),
        ]}
        title={id ? tr("编辑：{0}", taskName) : tr("新建任务")}
      />
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        {conflict && <Banner variant="error" description={tr(FORM_CONFLICT_MESSAGE)} />}
        {hasErrors && (
          <Banner
            variant="error"
            icon={<WarningCircleIcon weight="fill" />}
            title={tr("保存失败，请检查标出的字段")}
            description={otherIssues.length ? otherIssues.map((i) => (i.path ? `${i.path}: ` : '') + localizeIssueMessage(i.message)).join('；') : undefined}
          />
        )}

        <Section title={tr("基本信息")}>
          <Input label={tr("名称")} value={f.name} onChange={(e) => set('name', e.target.value)} {...err('name')} />
          <Input
            label={tr("描述（可选）")}
            value={f.description}
            onChange={(e) => set('description', e.target.value)}
            {...err('description')}
          />
          <Switch label={tr("启用")} checked={f.enabled} onCheckedChange={(v) => set('enabled', v)} />
        </Section>

        <Section title={tr("调度")}>
          <Tabs
            variant="segmented"
            value={f.scheduleType}
            onValueChange={(v) => set('scheduleType', v as ScheduleKind)}
            tabs={[
              { value: 'cron', label: tr("Cron（秒级）") },
              { value: 'once', label: tr("一次性") },
              { value: 'manual', label: tr("仅手动 / API") },
            ]}
          />
          {f.scheduleType === 'cron' && (
            <>
              <CronEditor
                value={f.cron}
                onChange={(cron) => set('cron', cron)}
                {...err('cron')}
              />
              <CronPreview cron={f.cron} timezone={f.timezone} hideError={!!errors.cron} />
            </>
          )}
          {f.scheduleType === 'once' && (
            <Input
              label={tr("执行时间")}
              type="datetime-local"
              step={1}
              value={f.runAt}
              onChange={(e) => set('runAt', e.target.value)}
              description={tr("按下方时区解释；夏令时重复时间新输入取较早时刻，未修改的已保存时间保持原时刻。")}
              {...err('runAt')}
            />
          )}
          <TimezoneSelect
            value={f.timezone}
            onChange={(timezone) => set('timezone', timezone)}
            {...err('timezone')}
          />
        </Section>

        <Section title={tr("HTTP 请求")} description={tr("URL、请求头和 Body 中可以用 {{变量名}} 引用加密变量。")}>
          <div className="grid gap-4 sm:grid-cols-[9rem_1fr]">
            <Select
              label={tr("方法")}
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
          <HeadersEditor rows={f.headers} onChange={(rows) => set('headers', rows)} error={localizeIssueMessage(errors.headers)} />
          <InputArea
            label={tr("Body（可选）")}
            className="font-mono"
            rows={4}
            value={f.body}
            onChange={(e) => set('body', e.target.value)}
            description={tr("GET / HEAD 请求不发送 Body")}
            {...err('body')}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label={tr("超时（秒）")}
              type="number"
              min={1}
              max={300}
              value={f.timeoutSeconds}
              onChange={(e) => set('timeoutSeconds', e.target.value)}
              description="1–300"
              {...err('timeoutSeconds')}
            />
          </div>
        </Section>

        <Section title={tr("成功判定")}>
          <Radio.Group legend={tr("判定模式")} orientation="horizontal" value={f.successMode}
            onValueChange={(v) => {
              set('successMode', v as TaskFormState['successMode'])
              setErrors((previous) => ({ ...previous, successKeyword: undefined, successRules: undefined }))
            }}>
            <Radio.Item label={tr("简单模式")} value="simple" />
            <Radio.Item label={tr("高级模式")} value="advanced" />
          </Radio.Group>
          {f.successMode === 'simple' ? <Input label={tr("成功关键字（可选）")} value={f.successKeyword}
            onChange={(e) => set('successKeyword', e.target.value)} description={tr("HTTP 2xx 即成功；填写后还需响应体包含该字符串。")} {...err('successKeyword')} />
            : <SuccessConditionEditor match={f.successMatch} rules={f.successRules} onMatchChange={(v) => set('successMatch', v)}
              onRulesChange={(update) => set('successRules', update)} error={localizeIssueMessage(errors.successRules)} />}
        </Section>

        <Section title={tr("执行策略")}>
          <ExecutionModeField
            taskId={id}
            timeoutSeconds={f.timeoutSeconds}
            value={f.executionMode}
            onChange={(v) => set('executionMode', v)}
            error={localizeIssueMessage(errors.executionMode)}
          />
          <Radio.Group
            legend={tr("上次执行未结束时")}
            orientation="horizontal"
            value={f.overlapPolicy}
            onValueChange={(v) => set('overlapPolicy', v as TaskFormState['overlapPolicy'])}
          >
            <Radio.Item label={tr("跳过本次")} value="skip" />
            <Radio.Item label={tr("并行执行")} value="parallel" />
          </Radio.Group>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label={tr("失败重试次数")}
              type="number"
              min={0}
              max={10}
              value={f.retryCount}
              onChange={(e) => set('retryCount', e.target.value)}
              description={tr("0–10，0 表示不重试")}
              {...err('retryCount')}
            />
            <Input
              label={tr("重试间隔（秒）")}
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

        <Section title={tr("失败告警")} description={tr("最后一次重试仍失败时发出告警。")}>
          <Radio.Group
            legend={tr("告警方式")}
            orientation="horizontal"
            value={f.alertMode}
            onValueChange={(v) => set('alertMode', v as TaskFormState['alertMode'])}
          >
            <Radio.Item label={tr("使用全局设置")} value="inherit" />
            <Radio.Item label={tr("关闭")} value="off" />
            <Radio.Item label={tr("自定义 Webhook")} value="custom" />
            <Radio.Item label={tr("cf-sender 主题")} value="sender" />
          </Radio.Group>
          {f.alertMode === 'sender' && (
            <Input
              label={tr("主题标识")}
              className="font-mono"
              placeholder="ops-alert"
              value={f.alertTopic}
              onChange={(e) => set('alertTopic', e.target.value)}
              description={
                me.data && !me.data.senderAvailable
                  ? tr("当前部署没有配置 SENDER 服务绑定，告警会发送失败。见 wrangler.jsonc 的 services。")
                  : tr("通过 cf-sender 扇出到该主题绑定的所有渠道（飞书、Telegram、邮件等）。")
              }
              {...err('alertTopic')}
            />
          )}
          {f.alertMode === 'custom' && (
            <>
              <Input
                label="Webhook URL"
                className="font-mono"
                value={f.alertUrl}
                onChange={(e) => set('alertUrl', e.target.value)}
                description={tr("可用「变量」页创建的加密变量，例如 {{BARK_KEY}}；task.*、run.* 仅支持 Body 模板。")}
                {...err('alertUrl')}
              />
              <InputArea
                label={tr("Body 模板（可选）")}
                className="font-mono"
                rows={4}
                value={f.alertBodyTemplate}
                onChange={(e) => set('alertBodyTemplate', e.target.value)}
                description={tr("留空则发送通用事件 JSON；下方列出可用变量及其写法。")}
                {...err('alertBodyTemplate')}
              />
              <AlertTemplateHelp />
            </>
          )}
        </Section>

        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" loading={save.isPending}>
            {id ? tr("保存") : tr("创建任务")}
          </Button>
          <LinkButton href={id ? `/tasks/${id}` : '/'} variant="ghost">
            {tr("取消")}</LinkButton>
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
  useLocale()

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
    <div className="flex flex-col gap-3">
      <div>
        <ExecutionModeGuide timeoutMs={timeoutMs} taskMode={value} globalMode={me.data?.executionMode} queueAvailable={me.data?.queueAvailable} />
      </div>
      <Radio.Group
        legend={tr("执行方式")}
        appearance="card"
        orientation="horizontal"
        value={value}
        onValueChange={(v) => onChange(v as TaskFormState['executionMode'])}
        error={error}
        description={!taskId || stats.data ? suggestionText(p95, timeoutMs, queueAvailable) : undefined}
      >
        <Radio.Item
          label={tr("跟随全局")}
          value="inherit"
          description={me.data ? tr("当前全局：{0}（设置页可修改）", MODE_LABEL[me.data.executionMode]) : tr("可在设置页修改全局方式")}
        />
        <Radio.Item
          label={MODE_LABEL.worker}
          value="worker"
          disabled={!workerFits && value !== 'worker'}
          description={
            workerFits
              ? tr("Worker 后台执行，等待不计运行时长，适合短任务")
              : tr("需要把超时设在 {0} 秒以内", WORKER_MAX_TIMEOUT_SECONDS)
          }
        />
        <Radio.Item
          label={MODE_LABEL.queue}
          value="queue"
          disabled={!queueAvailable && value !== 'queue'}
          description={queueAvailable ? tr("经 Queue 投递执行，适合超时较长的慢接口") : tr("当前部署没有配置 Queue")}
        />
        <Radio.Item label={MODE_LABEL.direct} value="direct" description={tr("调度器 DO 直接请求，等待按时长计费")} />
      </Radio.Group>
    </div>
  )
}

function CronPreview({ cron, timezone, hideError }: { cron: string; timezone: string; hideError: boolean }) {
  useLocale()

  const preview = useMemo(() => {
    if (!isValidTimezone(timezone)) return { error: tr("时区无效") }
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
          {localizeIssueMessage(preview.error)}
        </Text>
      ) : (
        <Text variant="secondary" size="sm">
          {tr("接下来：")}{preview.times.length ? preview.times.map((t) => fmtTime(t, timezone)).join(tr('、')) : tr("不会再触发")}
          <span className="ml-1">{tr('（')}{timezone}{tr('）')}</span>
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
  useLocale()

  const update = (i: number, patch: Partial<HeaderRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div className="flex flex-col gap-2">
      <Text size="sm" bold as="span">
        {tr("请求头")}</Text>
      {rows.map((row, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] gap-2">
          <Input
            aria-label={tr("请求头 {0} 名称", i + 1)}
            placeholder="Authorization"
            className="font-mono"
            value={row.key}
            onChange={(e) => update(i, { key: e.target.value })}
          />
          <Input
            aria-label={tr("请求头 {0} 值", i + 1)}
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
            aria-label={tr("删除请求头")}
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
          {tr("添加请求头")}</Button>
      </div>
    </div>
  )
}
