import { useLocale } from './i18n'
import { LinkProvider, type LinkComponentProps, Toasty, TooltipProvider } from '@cloudflare/kumo'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { forwardRef, lazy, Suspense, useEffect } from 'react'
import { Link as RouterLink, Route, Router, Switch as Routes } from 'wouter'
import { AppShell } from './components/AppShell'
import { NotFound, PageLoader } from './components/States'
import { SettingsPage } from './pages/SettingsPage'
import { TaskDetailPage } from './pages/TaskDetailPage'
import { TaskFormPage } from './pages/TaskFormPage'
import { TasksPage } from './pages/TasksPage'
import { VariablesPage } from './pages/VariablesPage'

// Charts pull in ECharts; keep them out of the main bundle.
const StatsPage = lazy(() => import('./pages/StatsPage'))

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 2_000 } },
})

/** Route Kumo links through wouter; hrefs are relative to the /admin base. */
const AppLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(({ href = '', to: _to, ...rest }, ref) =>
  href.startsWith('/') ? <RouterLink ref={ref} href={href} {...rest} /> : <a ref={ref} href={href} {...rest} />,
)

function useSystemColorMode() {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => (document.documentElement.dataset.mode = media.matches ? 'dark' : 'light')
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [])
}

export function App() {
  useLocale()

  useSystemColorMode()
  return (
    <QueryClientProvider client={queryClient}>
      <Router base="/admin">
        <LinkProvider component={AppLink}>
          <TooltipProvider>
            <Toasty>
              <AppShell>
                <Routes>
                  <Route path="/" component={TasksPage} />
                  <Route path="/tasks/new">{() => <TaskFormPage />}</Route>
                  <Route path="/tasks/:id/edit">{(p) => <TaskFormPage id={p.id} />}</Route>
                  <Route path="/tasks/:id">{(p) => <TaskDetailPage id={p.id} />}</Route>
                  <Route path="/stats">
                    {() => (
                      <Suspense fallback={<PageLoader />}>
                        <StatsPage />
                      </Suspense>
                    )}
                  </Route>
                  <Route path="/variables" component={VariablesPage} />
                  <Route path="/settings" component={SettingsPage} />
                  <Route component={NotFound} />
                </Routes>
              </AppShell>
            </Toasty>
          </TooltipProvider>
        </LinkProvider>
      </Router>
    </QueryClientProvider>
  )
}
