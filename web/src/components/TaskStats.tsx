import { Text } from '@cloudflare/kumo'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { StatsRange } from '../../../src/shared/types'
import { api } from '../api'
import { ErrorBanner, PageLoader } from './States'
import { DelayChart, DurationChart, HistogramChart, KpiTiles, RangeTabs, ResultsChart, STATS_REFRESH_MS } from './stats'

/** Stats section of the task detail page; lazy-loaded with ECharts. */
export default function TaskStats({ taskId, scheduled }: { taskId: string; scheduled: boolean }) {
  const [range, setRange] = useState<StatsRange>('24h')
  const stats = useQuery({
    queryKey: ['stats', 'task', taskId, range],
    queryFn: () => api.taskStats(taskId, range),
    placeholderData: keepPreviousData,
    refetchInterval: STATS_REFRESH_MS,
  })

  return (
    <section className="mt-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Text variant="heading" as="h2">
          统计
        </Text>
        <RangeTabs value={range} onChange={setRange} />
      </div>
      {stats.isPending ? (
        <PageLoader />
      ) : stats.isError ? (
        <ErrorBanner error={stats.error} />
      ) : stats.data.summary.total === 0 ? (
        <Text variant="secondary">这段时间没有执行记录。</Text>
      ) : (
        <div className={`flex flex-col gap-4 transition-opacity ${stats.isPlaceholderData ? 'opacity-60' : ''}`}>
          <KpiTiles summary={stats.data.summary} />
          <ResultsChart ctx={stats.data} summary={stats.data.summary} />
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <DurationChart ctx={stats.data} summary={stats.data.summary} />
            <HistogramChart histogram={stats.data.histogram} />
          </div>
          {scheduled && <DelayChart ctx={stats.data} summary={stats.data.summary} />}
        </div>
      )}
    </section>
  )
}
