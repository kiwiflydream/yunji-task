import { Button, LayerCard, Text } from '@cloudflare/kumo'
import { ArrowSquareOutIcon, ClockCountdownIcon, XLogoIcon } from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { version } from '../../../package.json'
import { tr, useLocale } from '../i18n'
import { fetchLatestRelease, isNewerRelease, PROJECT_URL, RELEASES_URL } from '../lib/releases'

export function AboutSettings() {
  useLocale()
  const client = useQueryClient()
  const check = useMutation({
    mutationFn: () => client.fetchQuery({
      queryKey: ['latest-project-release'], queryFn: fetchLatestRelease,
      staleTime: 60_000, retry: false,
    }),
    retry: false,
  })
  const latest = check.data
  const update = latest && isNewerRelease(latest.tag, version)
  const linkClass = 'inline-flex items-center gap-1.5 text-sm text-kumo-link underline-offset-4 hover:underline'
  const [beforeAuthor, afterAuthor] = tr('由 kiwi 构建的免费开源定时任务管理工具。').split('kiwi')
  return (
    <LayerCard>
      <LayerCard.Secondary>{tr('关于')}</LayerCard.Secondary>
      <LayerCard.Primary>
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-kumo-control p-3 text-kumo-brand"><ClockCountdownIcon size={32} weight="duotone" /></div>
            <div className="flex min-w-0 flex-col gap-1">
              <Text size="lg" bold>{tr('云吉 Task')}</Text>
              <Text size="sm" variant="secondary">
                {beforeAuthor}<a className="inline-flex items-center gap-1 align-baseline font-medium text-kumo-link underline underline-offset-4" href="https://x.com/kiwiflysky" target="_blank" rel="noopener noreferrer" aria-label="kiwi · X (Twitter)"><XLogoIcon size={15} aria-hidden="true" />kiwi</a>{afterAuthor}
              </Text>
              <Text size="sm" variant="secondary">{tr('当前版本：{0}', `v${version}`)}</Text>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <Button type="button" aria-label={tr('检查更新')} loading={check.isPending} disabled={check.isPending} onClick={() => check.mutate()}>
              {tr('检查更新')}
            </Button>
            <a className={linkClass} href={latest?.url ?? RELEASES_URL} target="_blank" rel="noopener noreferrer">
              {tr('变更记录')}<ArrowSquareOutIcon size={16} />
            </a>
            <a className={linkClass} href={PROJECT_URL} target="_blank" rel="noopener noreferrer">
              {tr('查看项目源码')}<ArrowSquareOutIcon size={16} />
            </a>
          </div>
          <div role="status" aria-live="polite">
            {check.isPending && <Text size="sm" variant="secondary">{tr('正在检查最新版本…')}</Text>}
            {!check.isPending && check.isError && <Text size="sm" variant="error">{tr(check.error instanceof Error ? check.error.message : '检查更新失败，请稍后重试或查看变更记录。')}</Text>}
            {check.isSuccess && (latest ? (
              update ? <div className="flex flex-col items-start gap-2 rounded-lg border border-kumo-line bg-kumo-control p-3">
                <Text size="sm" bold>{tr('发现新版本 {0}，建议升级。', latest.tag)}</Text>
                <a className={linkClass} href={latest.url} target="_blank" rel="noopener noreferrer">{tr('查看新版与升级说明')}<ArrowSquareOutIcon size={16} /></a>
              </div> : <Text size="sm" variant="secondary">{tr('当前已是最新版本。')}</Text>
            ) : <Text size="sm" variant="secondary">{tr('项目尚未发布正式版本。')}</Text>)}
          </div>
        </div>
      </LayerCard.Primary>
    </LayerCard>
  )
}
