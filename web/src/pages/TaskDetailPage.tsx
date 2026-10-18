import { tr, useLocale } from '../i18n'
import { Banner, Button, Empty, LayerCard, LinkButton, Table, Text } from '@cloudflare/kumo'
import { LightningIcon, PauseIcon, PencilSimpleIcon, PlayIcon, ListBulletsIcon, WarningIcon } from '@phosphor-icons/react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { lazy, Suspense, useState } from 'react'
import { useLocation } from 'wouter'
import type { Run } from '../../../src/shared/types'
import { describeLocalizedSuccessRule } from '../lib/success-rules'
import { api, ApiError, type TaskView } from '../api'
import { EnabledBadge, RunStatusBadge } from '../components/badges'
import { DescriptionList } from '../components/DescriptionList'
import { PageHeader } from '../components/PageHeader'
import { RunDialog } from '../components/RunDialog'
import { ErrorBanner, NotFound, PageLoader } from '../components/States'
import { TaskMenu } from '../components/TaskMenu'
import { useTaskActions } from '../components/useTaskActions'
import { describeTaskMode, MODE_LABEL } from '../lib/execution-mode'
import { fmtDuration, fmtRelative, fmtTime } from '../lib/format'

const TaskStats = lazy(() => import('../components/TaskStats'))

export function TaskDetailPage({ id }: { id: string }) {
  useLocale()

  const [, navigate] = useLocation()
  const task = useQuery({ queryKey: ['task', id], queryFn: () => api.task(id), refetchInterval: 10_000 })
  const { trigger, setEnabled } = useTaskActions()

  if (task.isPending) return <PageLoader />
  if (task.isError) {
    return task.error instanceof ApiError && task.error.status === 404 ? <NotFound /> : <ErrorBanner error={task.error} />
  }
  const t = task.data
  return (
    <>
      <PageHeader
        crumbs={[{ label: tr("任务"), href: '/' }, { label: t.name }]}
        title={t.name}
        badge={<EnabledBadge enabled={t.enabled} />}
        description={t.description || undefined}
        actions={
          <>
            <Button variant="primary" icon={LightningIcon} loading={trigger.isPending} onClick={() => trigger.mutate(t.id)}>
              {tr("立即执行")}</Button>
            <Button
              icon={t.enabled ? PauseIcon : PlayIcon}
              loading={setEnabled.isPending}
              onClick={() => setEnabled.mutate({ id: t.id, enabled: !t.enabled })}
            >
              {t.enabled ? tr("停用") : tr("启用")}
            </Button>
            <LinkButton href={`/tasks/${t.id}/edit`} icon={PencilSimpleIcon}>
              {tr("编辑")}</LinkButton>
            <TaskMenu task={t} onDeleted={() => navigate('/')} />
          </>
        }
      />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <ScheduleCard task={t} />
        <RequestCard task={t} />
      </div>
      <Suspense fallback={<PageLoader />}>
        <TaskStats taskId={t.id} scheduled={t.schedule.type !== 'manual'} />
      </Suspense>
      <RunsCard taskId={t.id} />
    </>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <LayerCard>
      <LayerCard.Secondary>{title}</LayerCard.Secondary>
      <LayerCard.Primary>{children}</LayerCard.Primary>
    </LayerCard>
  )
}

function ScheduleCard({ task }: { task: TaskView }) {
  useLocale()

  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const scheduler = useQuery({
    queryKey: ['scheduler', task.id],
    queryFn: () => api.scheduler(task.id),
    refetchInterval: 10_000,
  })
  const s = task.schedule
  const items: [string, React.ReactNode][] = [
    [tr("类型"), s.type === 'cron' ? 'Cron' : s.type === 'once' ? tr("一次性") : tr("仅手动 / API")],
  ]
  if (s.type === 'cron') items.push([tr("表达式"), <Text variant="mono">{s.cron}</Text>])
  if (s.type === 'once') items.push([tr("执行时间"), fmtTime(s.runAt, s.timezone)])
  items.push([tr("时区"), s.timezone])
  items.push([tr("下次执行"), task.nextRunAt ? `${fmtTime(task.nextRunAt)}（${fmtRelative(task.nextRunAt)}）` : '—'])
  items.push([tr("上次未结束时"), task.overlapPolicy === 'skip' ? tr("跳过本次") : tr("并行执行")])
  items.push([
    tr("失败重试"),
    task.retry.count === 0 ? tr("不重试") : tr("{0} 次，间隔 {1} 秒", task.retry.count, task.retry.intervalSeconds),
  ])
  if (me.data) items.push([tr("执行方式"), describeTaskMode(task.executionMode, task.executor.config.timeoutMs, me.data)])
  items.push([
    tr("失败告警"),
    task.alert.mode === 'inherit'
      ? tr("使用全局设置")
      : task.alert.mode === 'off'
        ? tr("关闭")
        : task.alert.mode === 'sender'
          ? tr("云吉 Sender 渠道组 {0}", task.alert.channelGroup)
          : task.alert.url,
  ])
  const st = scheduler.data
  if (st) {
    items.push([
      tr("调度器"),
      <Text size="sm" variant="secondary">
        v{st.version ?? '—'} · alarm {fmtTime(st.alarmAt)}
        {st.running && tr(" · 执行中 {0}", st.running.runId.slice(0, 8))}
      </Text>,
    ])
  }
  return (
    <Card title={tr("调度")}>
      <DescriptionList items={items} />
      {st && st.version !== task.version && (
        <div className="mt-4">
          <Banner
            variant="alert"
            size="sm"
            icon={<WarningIcon weight="fill" />}
            description={tr("调度器版本（v{0}）与配置版本（v{1}）不一致。未同步的修改会在 5 分钟内重试，每小时还会全量对账修复调度状态。", st.version ?? '—', task.version)}
          />
        </div>
      )}
    </Card>
  )
}

function RequestCard({ task }: { task: TaskView }) {
  useLocale()

  if (task.executor.type === 'rpc') {
    const cfg = task.executor.config
    return <Card title={tr("RPC 调用")}><DescriptionList items={[
      [tr("服务绑定"), <Text variant="mono">{cfg.binding}</Text>],
      [tr("RPC 方法"), <Text variant="mono">{cfg.method}</Text>],
      [tr("参数（JSON 数组）"), <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-sm">{JSON.stringify(cfg.args, null, 2)}</pre>],
      [tr("超时"), tr("{0} 秒", cfg.timeoutMs / 1000)],
      [tr("成功判定"), cfg.successCondition ? <div className="flex flex-col gap-1">
        <Text>{cfg.successCondition.match === 'all' ? tr("全部满足（AND）") : tr("任一满足（OR）")}</Text>
        {cfg.successCondition.rules.map((rule, index) => <Text key={index} variant="mono">{describeLocalizedSuccessRule(rule)}</Text>)}
      </div> : tr("方法正常返回即成功")],
    ]} /></Card>
  }
  const cfg = task.executor.config
  const headers = Object.entries(cfg.headers)
  return (
    <Card title={tr("HTTP 请求")}>
      <DescriptionList
        items={[
          [
            tr("请求"),
            <Text variant="mono">
              {cfg.method} {cfg.url}
            </Text>,
          ],
          [
            tr("请求头"),
            headers.length ? (
              <div className="flex flex-col gap-0.5">
                {headers.map(([k, v]) => (
                  <Text key={k} variant="mono">
                    {k}: {v}
                  </Text>
                ))}
              </div>
            ) : (
              '—'
            ),
          ],
          ['Body', cfg.body ? <Text variant="mono">{cfg.body.length > 200 ? cfg.body.slice(0, 200) + '…' : cfg.body}</Text> : '—'],
          [tr("超时"), tr("{0} 秒", cfg.timeoutMs / 1000)],
          [tr("成功判定"), cfg.successCondition ? <div className="flex min-w-0 flex-col gap-1 break-all">
            <Text>{tr("高级模式 ·")}{cfg.successCondition.match === 'all' ? tr("全部满足（AND）") : tr("任一满足（OR）")}</Text>
            {cfg.successCondition.rules.map((rule, index) => <Text key={index} variant="mono">{index + 1}. {describeLocalizedSuccessRule(rule)}</Text>)}
          </div> : cfg.successKeyword ? <Text variant="mono">{tr("HTTP 2xx 且响应体包含")}{JSON.stringify(cfg.successKeyword)}</Text> : tr("简单模式 · HTTP 2xx 即成功")],
        ]}
      />
    </Card>
  )
}

function RunsCard({ taskId }: { taskId: string }) {
  useLocale()

  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const runs = useInfiniteQuery({
    queryKey: ['runs', taskId],
    queryFn: ({ pageParam }) => api.runs(taskId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: 5_000,
  })
  const [selected, setSelected] = useState<Run | null>(null)
  const all = runs.data?.pages.flatMap((p) => p.runs) ?? []

  return (
    <div className="mt-4">
      <LayerCard className="p-0">
        <LayerCard.Secondary className="flex items-center justify-between">
          <span>{tr("执行记录")}</span>
          {me.data && (
            <Text size="xs" variant="secondary" as="span">
              {tr("保留")}{me.data.retentionDays} {tr("天")}</Text>
          )}
        </LayerCard.Secondary>
        <LayerCard.Primary className="overflow-x-auto p-0">
          {runs.isPending ? (
            <PageLoader />
          ) : runs.isError ? (
            <div className="p-4">
              <ErrorBanner error={runs.error} />
            </div>
          ) : all.length === 0 ? (
            <div className="py-10">
              <Empty
                size="sm"
                icon={<ListBulletsIcon size={32} className="text-kumo-inactive" />}
                title={tr("暂无执行记录")}
                description={tr("任务触发后，结果会出现在这里。")}
              />
            </div>
          ) : (
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>{tr("时间")}</Table.Head>
                  <Table.Head>{tr("触发")}</Table.Head>
                  <Table.Head>{tr("实际执行方式")}</Table.Head>
                  <Table.Head>{tr("状态")}</Table.Head>
                  <Table.Head>{tr("尝试")}</Table.Head>
                  <Table.Head>HTTP</Table.Head>
                  <Table.Head>{tr("耗时")}</Table.Head>
                  <Table.Head>{tr("错误")}</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {all.map((r) => (
                  <Table.Row key={r.id} className="cursor-pointer" onClick={() => setSelected(r)}>
                    <Table.Cell className="whitespace-nowrap">{fmtTime(r.createdAt)}</Table.Cell>
                    <Table.Cell>{r.trigger === 'manual' ? tr("手动") : tr("调度")}</Table.Cell>
                    <Table.Cell className="whitespace-nowrap">{r.executionMode ? MODE_LABEL[r.executionMode] : '—'}</Table.Cell>
                    <Table.Cell>
                      <RunStatusBadge status={r.status} />
                    </Table.Cell>
                    <Table.Cell>{r.attempt || '—'}</Table.Cell>
                    <Table.Cell>{r.httpStatus ?? '—'}</Table.Cell>
                    <Table.Cell>{fmtDuration(r.durationMs)}</Table.Cell>
                    <Table.Cell className="max-w-xs">
                      <Text size="xs" variant="secondary" truncate>
                        {r.error ?? ''}
                      </Text>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          )}
        </LayerCard.Primary>
      </LayerCard>
      {runs.hasNextPage && (
        <div className="mt-3 flex justify-center">
          <Button variant="ghost" loading={runs.isFetchingNextPage} onClick={() => runs.fetchNextPage()}>
            {tr("加载更早的记录")}</Button>
        </div>
      )}
      <RunDialog run={selected} onClose={() => setSelected(null)} />
    </div>
  )
}
