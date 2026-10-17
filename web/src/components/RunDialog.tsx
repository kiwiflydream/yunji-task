import { tr, useLocale } from '../i18n'
import { Button, Dialog, Text } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import type { Run } from '../../../src/shared/types'
import { api, ApiError } from '../api'
import { fmtDuration, fmtTime } from '../lib/format'
import { RunStatusBadge } from './badges'
import { DescriptionList } from './DescriptionList'
import { MODE_LABEL } from '../lib/execution-mode'
import { ErrorBanner } from './States'

export function RunDialog({ run: initialRun, onClose }: { run: Run | null; onClose: () => void }) {
  useLocale()

  const active = initialRun?.status === 'running' || initialRun?.status === 'retrying'
  // Follow this run by ID even if newer runs push it outside the loaded list pages.
  const details = useQuery({
    queryKey: ['run', initialRun?.id],
    queryFn: () => api.run(initialRun!.id),
    initialData: initialRun ?? undefined,
    enabled: active,
    refetchInterval: (query) => {
      if (query.state.error instanceof ApiError && query.state.error.status === 404) return false
      return query.state.data?.status === 'running' || query.state.data?.status === 'retrying' ? 2_000 : false
    },
  })
  const run = active ? details.data ?? initialRun : initialRun

  return (
    <Dialog.Root open={initialRun !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog size="xl" className="max-h-[85vh] overflow-y-auto p-6">
        {run && (
          <>
            <div className="mb-4 flex items-start justify-between gap-4">
              <div className="flex items-center gap-2">
                <Dialog.Title className="text-lg font-semibold">{tr("执行详情")}</Dialog.Title>
                <RunStatusBadge status={run.status} />
              </div>
              <Dialog.Close
                render={(p) => <Button {...p} variant="ghost" shape="square" icon={<XIcon />} aria-label={tr("关闭")} />}
              />
            </div>
            <DescriptionList
              items={[
                ['Run ID', <Text variant="mono">{run.id}</Text>],
                [tr("触发方式"), run.trigger === 'manual' ? tr("手动") : tr("调度")],
                [tr("实际执行方式"), run.executionMode ? MODE_LABEL[run.executionMode] : '—'],
                [tr("生效超时"), run.effectiveTimeoutMs === null ? '—' : tr("{0} 秒", run.effectiveTimeoutMs / 1000)],
                [tr("计划时间"), fmtTime(run.scheduledAt)],
                [tr("开始 / 结束"), `${fmtTime(run.startedAt)} / ${fmtTime(run.finishedAt)}`],
                [tr("尝试次数"), run.attempt || '—'],
                [tr("HTTP 状态"), run.httpStatus ?? '—'],
                [tr("耗时"), fmtDuration(run.durationMs)],
              ]}
            />
            {active && details.isError && <div className="mt-4"><ErrorBanner error={details.error} /></div>}
            {run.error && <Section title={tr("错误")}>{run.error}</Section>}
            {run.responseBody !== null && <Section title={tr("响应体（前 4KB）")}>{run.responseBody || tr("(空)")}</Section>}
          </>
        )}
      </Dialog>
    </Dialog.Root>
  )
}

function Section({ title, children }: { title: string; children: string }) {
  return (
    <div className="mt-5">
      <Text bold size="sm">
        {title}
      </Text>
      <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-kumo-recessed p-3 font-mono text-xs break-all whitespace-pre-wrap text-kumo-default">
        {children}
      </pre>
    </div>
  )
}
