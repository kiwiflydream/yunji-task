import { Badge } from '@cloudflare/kumo'
import type { RunStatus } from '../../../src/shared/types'
import { RUN_STATUS } from '../lib/format'

export function RunStatusBadge({ status }: { status: RunStatus | string | null }) {
  if (!status) return <span className="text-kumo-subtle">—</span>
  const meta = RUN_STATUS[status as RunStatus]
  return <Badge variant={meta?.variant ?? 'neutral'}>{meta?.label ?? status}</Badge>
}

export function EnabledBadge({ enabled }: { enabled: boolean }) {
  return (
    <Badge appearance="dot" variant={enabled ? 'success' : 'neutral'}>
      {enabled ? '启用' : '停用'}
    </Badge>
  )
}
