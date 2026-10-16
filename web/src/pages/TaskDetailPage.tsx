import { Banner, Button, Empty, LayerCard, LinkButton, Table, Text } from '@cloudflare/kumo'
import { LightningIcon, PauseIcon, PencilSimpleIcon, PlayIcon, ListBulletsIcon, WarningIcon } from '@phosphor-icons/react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { lazy, Suspense, useState } from 'react'
import { useLocation } from 'wouter'
import type { Run } from '../../../src/shared/types'
import { api, ApiError, type TaskView } from '../api'
import { EnabledBadge, RunStatusBadge } from '../components/badges'
import { DescriptionList } from '../components/DescriptionList'
import { PageHeader } from '../components/PageHeader'
import { RunDialog } from '../components/RunDialog'
import { ErrorBanner, NotFound, PageLoader } from '../components/States'
import { TaskMenu } from '../components/TaskMenu'
import { useTaskActions } from '../components/useTaskActions'
import { describeTaskMode } from '../lib/execution-mode'
import { fmtDuration, fmtRelative, fmtTime } from '../lib/format'

const TaskStats = lazy(() => import('../components/TaskStats'))

export function TaskDetailPage({ id }: { id: string }) {
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
        crumbs={[{ label: '任务', href: '/' }, { label: t.name }]}
        title={t.name}
        badge={<EnabledBadge enabled={t.enabled} />}
        description={t.description || undefined}
        actions={
          <>
            <Button variant="primary" icon={LightningIcon} loading={trigger.isPending} onClick={() => trigger.mutate(t.id)}>
              立即执行
            </Button>
            <Button
              icon={t.enabled ? PauseIcon : PlayIcon}
              loading={setEnabled.isPending}
              onClick={() => setEnabled.mutate({ id: t.id, enabled: !t.enabled })}
            >
              {t.enabled ? '停用' : '启用'}
            </Button>
            <LinkButton href={`/tasks/${t.id}/edit`} icon={PencilSimpleIcon}>
              编辑
            </LinkButton>
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
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const scheduler = useQuery({
    queryKey: ['scheduler', task.id],
    queryFn: () => api.scheduler(task.id),
    refetchInterval: 10_000,
  })
  const s = task.schedule
  const items: [string, React.ReactNode][] = [
    ['类型', s.type === 'cron' ? 'Cron' : s.type === 'once' ? '一次性' : '仅手动 / API'],
  ]
  if (s.type === 'cron') items.push(['表达式', <Text variant="mono">{s.cron}</Text>])
  if (s.type === 'once') items.push(['执行时间', fmtTime(s.runAt, s.timezone)])
  items.push(['时区', s.timezone])
  items.push(['下次执行', task.nextRunAt ? `${fmtTime(task.nextRunAt)}（${fmtRelative(task.nextRunAt)}）` : '—'])
  items.push(['上次未结束时', task.overlapPolicy === 'skip' ? '跳过本次' : '并行执行'])
  items.push([
    '失败重试',
    task.retry.count === 0 ? '不重试' : `${task.retry.count} 次，间隔 ${task.retry.intervalSeconds} 秒`,
  ])
  if (me.data) items.push(['执行方式', describeTaskMode(task.executionMode, task.executor.config.timeoutMs, me.data)])
  items.push([
    '失败告警',
    task.alert.mode === 'inherit' ? '使用全局设置' : task.alert.mode === 'off' ? '关闭' : task.alert.url,
  ])
  const st = scheduler.data
  if (st) {
    items.push([
      '调度器',
      <Text size="sm" variant="secondary">
        v{st.version ?? '—'} · alarm {fmtTime(st.alarmAt)}
        {st.running && ` · 执行中 ${st.running.runId.slice(0, 8)}`}
      </Text>,
    ])
  }
  return (
    <Card title="调度">
      <DescriptionList items={items} />
      {st && st.version !== task.version && (
        <div className="mt-4">
          <Banner
            variant="alert"
            size="sm"
            icon={<WarningIcon weight="fill" />}
            description={`调度器版本（v${st.version ?? '—'}）与配置版本（v${task.version}）不一致，对账任务会在 5 分钟内自动修复。`}
          />
        </div>
      )}
    </Card>
  )
}

function RequestCard({ task }: { task: TaskView }) {
  const cfg = task.executor.config
  const headers = Object.entries(cfg.headers)
  return (
    <Card title="HTTP 请求">
      <DescriptionList
        items={[
          [
            '请求',
            <Text variant="mono">
              {cfg.method} {cfg.url}
            </Text>,
          ],
          [
            '请求头',
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
          ['超时', `${cfg.timeoutMs / 1000} 秒`],
          ['成功关键字', cfg.successKeyword ? <Text variant="mono">{cfg.successKeyword}</Text> : '— （2xx 即成功）'],
        ]}
      />
    </Card>
  )
}

function RunsCard({ taskId }: { taskId: string }) {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const runs = useInfiniteQuery({
    queryKey: ['runs', taskId],
    queryFn: ({ pageParam }) => api.runs(taskId, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: 5_000,
  })
  const [selected, setSelected] = useState<Run | null>(null)
  const all = runs.data?.pages.flatMap((p) => p.runs) ?? []

  return (
    <div className="mt-4">
      <LayerCard className="p-0">
        <LayerCard.Secondary className="flex items-center justify-between">
          <span>执行记录</span>
          {me.data && (
            <Text size="xs" variant="secondary" as="span">
              保留 {me.data.retentionDays} 天
            </Text>
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
                title="暂无执行记录"
                description="任务触发后，结果会出现在这里。"
              />
            </div>
          ) : (
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>时间</Table.Head>
                  <Table.Head>触发</Table.Head>
                  <Table.Head>状态</Table.Head>
                  <Table.Head>尝试</Table.Head>
                  <Table.Head>HTTP</Table.Head>
                  <Table.Head>耗时</Table.Head>
                  <Table.Head>错误</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {all.map((r) => (
                  <Table.Row key={r.id} className="cursor-pointer" onClick={() => setSelected(r)}>
                    <Table.Cell className="whitespace-nowrap">{fmtTime(r.createdAt)}</Table.Cell>
                    <Table.Cell>{r.trigger === 'manual' ? '手动' : '调度'}</Table.Cell>
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
            加载更早的记录
          </Button>
        </div>
      )}
      <RunDialog run={selected} onClose={() => setSelected(null)} />
    </div>
  )
}
