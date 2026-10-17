import { tr, useLocale } from '../i18n'
import { Empty, LayerCard } from '@cloudflare/kumo'
import { ChartBarIcon } from '@phosphor-icons/react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { StatsRange } from '../../../src/shared/types'
import { api } from '../api'
import { PageHeader } from '../components/PageHeader'
import { ErrorBanner, PageLoader } from '../components/States'
import {
  DelayChart,
  DurationChart,
  KpiTiles,
  RangeTabs,
  ResultsChart,
  STATS_REFRESH_MS,
  TaskRanking,
} from '../components/stats'

export default function StatsPage() {
  useLocale()

  const [range, setRange] = useState<StatsRange>('24h')
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const stats = useQuery({
    queryKey: ['stats', range],
    queryFn: () => api.statsOverview(range),
    placeholderData: keepPreviousData,
    refetchInterval: STATS_REFRESH_MS,
  })

  return (
    <>
      <PageHeader
        title={tr("统计")}
        description={tr("所有任务的执行情况，按小时汇总{0}。", me.data ? tr("，保留 {0} 天", me.data.statsRetentionDays) : '')}
        actions={<RangeTabs value={range} onChange={setRange} />}
      />
      {stats.isPending ? (
        <PageLoader />
      ) : stats.isError ? (
        <ErrorBanner error={stats.error} />
      ) : stats.data.summary.total === 0 ? (
        <LayerCard className="py-12">
          <Empty
            icon={<ChartBarIcon size={48} className="text-kumo-inactive" />}
            title={tr("这段时间没有执行")}
            description={tr("任务执行后，这里会出现图表。")}
          />
        </LayerCard>
      ) : (
        <div className={`flex flex-col gap-4 transition-opacity ${stats.isPlaceholderData ? 'opacity-60' : ''}`}>
          <KpiTiles summary={stats.data.summary} />
          <ResultsChart ctx={stats.data} summary={stats.data.summary} />
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <DurationChart ctx={stats.data} summary={stats.data.summary} />
            <DelayChart ctx={stats.data} summary={stats.data.summary} />
          </div>
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <TaskRanking title={tr("失败最多")} metric="failed" rows={stats.data.topFailing} empty={tr("这段时间没有失败的执行。")} />
            <TaskRanking title={tr("最慢（P95 耗时）")} metric="p95" rows={stats.data.slowest} empty={tr("暂无耗时数据。")} />
          </div>
        </div>
      )}
    </>
  )
}
