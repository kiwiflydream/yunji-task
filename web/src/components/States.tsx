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

export function ErrorBanner({ error, title = '加载失败' }: { error: unknown; title?: string }) {
  return (
    <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={title} description={errorMessage(error)} />
  )
}

export function NotFound() {
  return (
    <Empty
      icon={<CompassIcon size={48} className="text-kumo-inactive" />}
      title="页面不存在"
      description="这个地址没有对应的页面，或者资源已被删除。"
      contents={<LinkButton href="/">返回任务列表</LinkButton>}
    />
  )
}
