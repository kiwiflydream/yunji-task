import { Button, Dialog, Text } from '@cloudflare/kumo'
import { XIcon } from '@phosphor-icons/react'
import type { Run } from '../../../src/shared/types'
import { fmtDuration, fmtTime } from '../lib/format'
import { RunStatusBadge } from './badges'
import { DescriptionList } from './DescriptionList'
import { MODE_LABEL } from '../lib/execution-mode'

export function RunDialog({ run, onClose }: { run: Run | null; onClose: () => void }) {
  return (
    <Dialog.Root open={run !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog size="xl" className="max-h-[85vh] overflow-y-auto p-6">
        {run && (
          <>
            <div className="mb-4 flex items-start justify-between gap-4">
              <div className="flex items-center gap-2">
                <Dialog.Title className="text-lg font-semibold">执行记录</Dialog.Title>
                <RunStatusBadge status={run.status} />
              </div>
              <Dialog.Close
                render={(p) => <Button {...p} variant="ghost" shape="square" icon={<XIcon />} aria-label="关闭" />}
              />
            </div>
            <DescriptionList
              items={[
                ['Run ID', <Text variant="mono">{run.id}</Text>],
                ['触发方式', run.trigger === 'manual' ? '手动' : '调度'],
                ['实际执行方式', run.executionMode ? MODE_LABEL[run.executionMode] : '—'],
                ['生效超时', run.effectiveTimeoutMs === null ? '—' : `${run.effectiveTimeoutMs / 1000} 秒`],
                ['计划时间', fmtTime(run.scheduledAt)],
                ['开始 / 结束', `${fmtTime(run.startedAt)} / ${fmtTime(run.finishedAt)}`],
                ['尝试次数', run.attempt || '—'],
                ['HTTP 状态', run.httpStatus ?? '—'],
                ['耗时', fmtDuration(run.durationMs)],
              ]}
            />
            {run.error && <Section title="错误">{run.error}</Section>}
            {run.responseBody !== null && <Section title="响应体（前 4KB）">{run.responseBody || '(空)'}</Section>}
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
