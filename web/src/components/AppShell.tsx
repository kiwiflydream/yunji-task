import { tr, useLocale } from '../i18n'
import { Sidebar, Text, Tooltip, useSidebar } from '@cloudflare/kumo'
import { CaretDoubleLeftIcon, CaretDoubleRightIcon, ChartBarIcon, ClockCountdownIcon, GearSixIcon, KeyIcon, ListChecksIcon, ListIcon, XIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Link, useLocation } from 'wouter'
import { api } from '../api'

const NAV = [
  { href: '/', label: '任务', icon: ListChecksIcon, match: (p: string) => p === '/' || p.startsWith('/tasks') },
  { href: '/stats', label: '统计', icon: ChartBarIcon, match: (p: string) => p.startsWith('/stats') },
  { href: '/variables', label: '变量', icon: KeyIcon, match: (p: string) => p.startsWith('/variables') },
  { href: '/settings', label: '设置', icon: GearSixIcon, match: (p: string) => p.startsWith('/settings') },
]

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <Sidebar.Provider defaultOpen collapsible="icon" className="h-svh">
      <ShellContent>{children}</ShellContent>
    </Sidebar.Provider>
  )
}

function ShellContent({ children }: { children: ReactNode }) {
  useLocale()

  const [location] = useLocation()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const { open, isMobile, setOpenMobile } = useSidebar()
  const compact = !isMobile && !open
  const closeMobileMenu = () => { if (isMobile) setOpenMobile(false) }
  return (
    <>
      <Sidebar aria-label={tr("主导航")}>
        <Sidebar.Header className={compact ? 'justify-center px-0' : 'px-6'}>
          <Link href="/" aria-label={tr("云吉 Task 首页")} title={tr("云吉 Task 首页")} onClick={closeMobileMenu}
            className={`flex h-9 shrink-0 items-center rounded-lg text-kumo-default no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-brand ${compact ? 'w-9 justify-center' : 'gap-2.5'}`}>
            <ClockCountdownIcon size={22} weight="duotone" className="shrink-0 text-kumo-brand" />
            {!compact && <Text bold>{tr("云吉 Task")}</Text>}
          </Link>
        </Sidebar.Header>
        <Sidebar.Content>
          <Sidebar.Group>
            <Sidebar.Menu>
              {NAV.map((item) => (
                <Sidebar.MenuButton
                  key={item.href}
                  href={item.href}
                  icon={<item.icon size={18} className={`shrink-0 ${item.match(location) ? 'text-kumo-default' : 'text-kumo-subtle'}`} />}
                  tooltip={compact ? tr(item.label) : undefined}
                  className={isMobile ? 'min-h-11' : undefined}
                  active={item.match(location)}
                  aria-label={tr(item.label)}
                  aria-current={item.match(location) ? 'page' : undefined}
                  onClick={closeMobileMenu}
                >
                  {tr(item.label)}
                </Sidebar.MenuButton>
              ))}
            </Sidebar.Menu>
          </Sidebar.Group>
        </Sidebar.Content>
        <Sidebar.Footer>
          <div className={`flex w-full min-w-0 items-center gap-2 ${compact ? 'justify-center' : 'justify-between'}`}>
            {!compact && (
              <div className="min-w-0 flex-1" title={me.data?.user}>
                {me.data && <Text size="xs" variant="secondary" truncate>{me.data.user}</Text>}
              </div>
            )}
            <SidebarToggle showLabel={!compact} />
          </div>
        </Sidebar.Footer>
      </Sidebar>
      <main className="min-w-0 flex-1 overflow-y-auto bg-kumo-canvas">
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-kumo-hairline bg-kumo-base px-4 py-2 md:hidden">
            <SidebarToggle />
            <Text bold>{tr("云吉 Task")}</Text>
        </div>
        <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-6">{children}</div>
      </main>
    </>
  )
}

function SidebarToggle({ showLabel = false }: { showLabel?: boolean }) {
  useLocale()

  const { open, isMobile, openMobile } = useSidebar()
  const expanded = isMobile ? openMobile : open
  const label = isMobile ? expanded ? tr("关闭导航菜单") : tr("打开导航菜单") : expanded ? tr("收起侧栏") : tr("展开侧栏")
  const Icon = isMobile ? expanded ? XIcon : ListIcon : expanded ? CaretDoubleLeftIcon : CaretDoubleRightIcon
  return (
    <Tooltip content={label} disabled={isMobile} render={
      <Sidebar.Trigger aria-label={label} aria-expanded={expanded}
        className={`max-md:min-h-11 max-md:min-w-11 ${showLabel ? 'w-auto gap-1.5 px-2' : ''}`}>
        <Icon size={18} />
        {showLabel && <span className="text-xs">{isMobile ? tr("关闭") : tr("收起")}</span>}
      </Sidebar.Trigger>
    } />
  )
}
