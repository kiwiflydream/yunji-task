import { tr, useLocale } from '../i18n'
import { Badge } from '@cloudflare/kumo'
import type { RunStatus } from '../../../src/shared/types'
import { RUN_STATUS } from '../lib/format'

export function RunStatusBadge({ status }: { status: RunStatus | string | null }) {
  useLocale()

  if (!status) return <span className="text-kumo-subtle">—</span>
  const meta = RUN_STATUS[status as RunStatus]
  return <Badge variant={meta?.variant ?? 'neutral'}>{meta ? tr(meta.label) : status}</Badge>
}

export function EnabledBadge({ enabled }: { enabled: boolean }) {
  useLocale()

  return (
    <Badge appearance="dot" variant={enabled ? 'success' : 'neutral'}>
      {enabled ? tr("启用") : tr("停用")}
    </Badge>
  )
}
