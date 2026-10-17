import { tr, useLocale } from '../i18n'
import { Banner, Empty, LinkButton, Loader } from '@cloudflare/kumo'
import { CompassIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { errorMessage } from '../api'

export function PageLoader() {
  return (
    <div className="flex justify-center py-16">
      <Loader size={24} />
    </div>
  )
}

export function ErrorBanner({ error, title = tr("加载失败") }: { error: unknown; title?: string }) {
  useLocale()

  return (
    <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={title} description={errorMessage(error)} />
  )
}

export function NotFound() {
  useLocale()

  return (
    <Empty
      icon={<CompassIcon size={48} className="text-kumo-inactive" />}
      title={tr("页面不存在")}
      description={tr("这个地址没有对应的页面，或者资源已被删除。")}
      contents={<LinkButton href="/">{tr("返回任务列表")}</LinkButton>}
    />
  )
}
