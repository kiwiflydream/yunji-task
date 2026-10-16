import { Sidebar, Text } from '@cloudflare/kumo'
import { ChartBarIcon, ClockCountdownIcon, GearSixIcon, KeyIcon, ListChecksIcon } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useLocation } from 'wouter'
import { api } from '../api'

const NAV = [
  { href: '/', label: '任务', icon: ListChecksIcon, match: (p: string) => p === '/' || p.startsWith('/tasks') },
  { href: '/stats', label: '统计', icon: ChartBarIcon, match: (p: string) => p.startsWith('/stats') },
  { href: '/variables', label: '变量', icon: KeyIcon, match: (p: string) => p.startsWith('/variables') },
  { href: '/settings', label: '设置', icon: GearSixIcon, match: (p: string) => p.startsWith('/settings') },
]

export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: Infinity })
  return (
    <Sidebar.Provider defaultOpen collapsible="icon" className="h-svh">
      <Sidebar>
        <Sidebar.Header>
          <div className="flex items-center gap-2 px-2 py-1">
            <ClockCountdownIcon size={22} weight="duotone" className="shrink-0 text-kumo-brand" />
            <Text bold>cf-task</Text>
          </div>
        </Sidebar.Header>
        <Sidebar.Content>
          <Sidebar.Group>
            <Sidebar.Menu>
              {NAV.map((item) => (
                <Sidebar.MenuButton
                  key={item.href}
                  href={item.href}
                  icon={item.icon}
                  tooltip={item.label}
                  active={item.match(location)}
                >
                  {item.label}
                </Sidebar.MenuButton>
              ))}
            </Sidebar.Menu>
          </Sidebar.Group>
        </Sidebar.Content>
        <Sidebar.Footer>
          <div className="flex items-center justify-between gap-2 px-2">
            {me.data && (
              <Text size="xs" variant="secondary" truncate>
                {me.data.user}
              </Text>
            )}
            <Sidebar.Trigger />
          </div>
        </Sidebar.Footer>
      </Sidebar>
      <main className="min-w-0 flex-1 overflow-y-auto bg-kumo-canvas">
        <div className="flex items-center gap-2 border-b border-kumo-hairline bg-kumo-base px-4 py-2 md:hidden">
          <Sidebar.Trigger />
          <Text bold>cf-task</Text>
        </div>
        <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-6">{children}</div>
      </main>
    </Sidebar.Provider>
  )
}
