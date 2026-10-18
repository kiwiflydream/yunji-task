import { tr, useLocale } from '../i18n'
import { Empty, LayerCard, Link, LinkButton, Table, Text } from '@cloudflare/kumo'
import { ClockCountdownIcon, PlusIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api'
import { EnabledBadge, RunStatusBadge } from '../components/badges'
import { PageHeader } from '../components/PageHeader'
import { ErrorBanner, PageLoader } from '../components/States'
import { TaskMenu } from '../components/TaskMenu'
import { fmtRelative, fmtTime } from '../lib/format'

const NewTaskButton = () => (
  <LinkButton href="/tasks/new" variant="primary" icon={PlusIcon}>
    {tr("新建任务")}</LinkButton>
)

export function TasksPage() {
  useLocale()

  const tasks = useQuery({ queryKey: ['tasks'], queryFn: api.tasks, refetchInterval: 10_000 })

  return (
    <>
      <PageHeader title={tr("任务")} description={tr("按 cron、指定时间或手动触发 HTTP 或 RPC 调用。")} actions={<NewTaskButton />} />
      {tasks.isPending ? (
        <PageLoader />
      ) : tasks.isError ? (
        <ErrorBanner error={tasks.error} />
      ) : tasks.data.length === 0 ? (
        <LayerCard className="py-12">
          <Empty
            icon={<ClockCountdownIcon size={48} className="text-kumo-inactive" />}
            title={tr("还没有任务")}
            description={tr("创建一个任务，按秒级 cron 或指定时间调用你的 HTTP 接口。")}
            contents={<NewTaskButton />}
          />
        </LayerCard>
      ) : (
        <LayerCard className="overflow-x-auto p-0">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>{tr("名称")}</Table.Head>
                <Table.Head>{tr("调度")}</Table.Head>
                <Table.Head>{tr("状态")}</Table.Head>
                <Table.Head>{tr("下次执行")}</Table.Head>
                <Table.Head>{tr("最近执行")}</Table.Head>
                <Table.Head className="w-12" />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {tasks.data.map((t) => (
                <Table.Row key={t.id}>
                  <Table.Cell>
                    <Link href={`/tasks/${t.id}`} variant="plain" className="font-medium">
                      {t.name}
                    </Link>
                    {t.description && (
                      <Text size="xs" variant="secondary" truncate>
                        {t.description}
                      </Text>
                    )}
                  </Table.Cell>
                  <Table.Cell>
                    {t.schedule.type === 'cron' ? (
                      <div className="flex flex-col">
                        <Text variant="mono">{t.schedule.cron}</Text>
                        <Text size="xs" variant="secondary">
                          {t.schedule.timezone}
                        </Text>
                      </div>
                    ) : t.schedule.type === 'once' ? (
                      <Text size="sm">{tr("一次性 ·")}{fmtTime(t.schedule.runAt, t.schedule.timezone)}</Text>
                    ) : (
                      <Text size="sm" variant="secondary">
                        {tr("仅手动 / API")}</Text>
                    )}
                  </Table.Cell>
                  <Table.Cell>
                    <EnabledBadge enabled={t.enabled} />
                  </Table.Cell>
                  <Table.Cell>
                    <span title={fmtTime(t.nextRunAt)}>{fmtRelative(t.nextRunAt)}</span>
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex items-center gap-2">
                      <RunStatusBadge status={t.lastStatus} />
                      {t.lastRunAt && (
                        <Text size="xs" variant="secondary" as="span">
                          {fmtRelative(t.lastRunAt)}
                        </Text>
                      )}
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <TaskMenu task={t} />
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </LayerCard>
      )}
    </>
  )
}
