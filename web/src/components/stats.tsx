import { tr, useLocale } from '../i18n'
import {
  Chart,
  ChartLegend,
  ChartPalette,
  LayerCard,
  Link,
  Surface,
  Table,
  Tabs,
  Text,
  type KumoChartOption,
} from '@cloudflare/kumo'
import { CheckCircleIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { useState, type ReactNode } from 'react'
import { formatInZone } from '../../../src/lib/time'
import type {
  DurationBucket,
  StatsGranularity,
  StatsPoint,
  StatsRange,
  StatsSummary,
  TaskStatsRow,
} from '../../../src/shared/types'
import { seriesColors, statusColors, surfaceColor, useDarkMode } from '../lib/chart-colors'
import { echarts } from '../lib/echarts'
import { fmtBucket, fmtCount, fmtDuration, fmtPercent, viewerTimezone } from '../lib/format'

const RANGES: { value: StatsRange; label: string }[] = [
  { value: '24h', label: '24 小时' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: '90d', label: '90 天' },
]

export function RangeTabs({ value, onChange }: { value: StatsRange; onChange: (r: StatsRange) => void }) {
  useLocale()

  return <Tabs variant="segmented" size="sm" value={value} onValueChange={(v) => onChange(v as StatsRange)} tabs={RANGES.map((range) => ({ ...range, label: tr(range.label) }))} />
}

/** What every chart needs to know about the response it plots. */
export interface SeriesContext {
  range: StatsRange
  granularity: StatsGranularity
  series: StatsPoint[]
}

const CHART_HEIGHT = 240
export const STATS_REFRESH_MS = 60_000

function Kpi({ label, value, hint, icon }: { label: string; value: string; hint?: ReactNode; icon?: ReactNode }) {
  return (
    <Surface className="flex flex-col gap-1 rounded-lg p-4">
      <Text size="sm" variant="secondary">
        {label}
      </Text>
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-2xl font-semibold tabular-nums text-kumo-default">{value}</span>
      </div>
      {hint && (
        <Text size="xs" variant="secondary">
          {hint}
        </Text>
      )}
    </Surface>
  )
}

export function KpiTiles({ summary }: { summary: StatsSummary }) {
  useLocale()

  const status = statusColors(useDarkMode())
  const s = summary
  const finished = s.success + s.failed
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Kpi
        label={tr("执行次数")}
        value={fmtCount(s.total)}
        hint={tr("成功 {0} · 失败 {1} · 跳过 {2}", fmtCount(s.success), fmtCount(s.failed), fmtCount(s.skipped))}
      />
      <Kpi
        label={tr("成功率")}
        value={fmtPercent(s.successRate)}
        icon={
          finished === 0 ? undefined : s.failed === 0 ? (
            <CheckCircleIcon size={20} weight="fill" color={status.success} aria-label={tr("全部成功")} />
          ) : (
            <WarningCircleIcon size={20} weight="fill" color={status.failed} aria-label={tr("有失败")} />
          )
        }
        hint={tr("成功 ÷（成功 + 失败），不含跳过")}
      />
      <Kpi
        label={tr("P95 耗时")}
        value={fmtDuration(s.durationP95)}
        hint={tr("P50 {0} · 平均 {1} · 最大 {2}", fmtDuration(s.durationP50), fmtDuration(s.durationAvg), fmtDuration(s.durationMax))}
      />
      <Kpi
        label={tr("平均调度延迟")}
        value={fmtDuration(s.delayAvg)}
        hint={tr("最大 {0} · 仅统计定时触发", fmtDuration(s.delayMax))}
      />
    </div>
  )
}

type View = 'chart' | 'table'

function ChartCard(props: {
  title: string
  description?: string
  legend?: ReactNode
  chart: ReactNode
  table: ReactNode
}) {
  useLocale()

  const [view, setView] = useState<View>('chart')
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-start justify-between gap-3">
        <div className="flex flex-col">
          <span>{props.title}</span>
          {props.description && (
            <Text size="xs" variant="secondary">
              {props.description}
            </Text>
          )}
        </div>
        <Tabs
          variant="segmented"
          size="sm"
          value={view}
          onValueChange={(v) => setView(v as View)}
          tabs={[
            { value: 'chart', label: tr("图表") },
            { value: 'table', label: tr("表格") },
          ]}
        />
      </LayerCard.Secondary>
      <LayerCard.Primary>
        {view === 'chart' ? (
          <div className="flex flex-col gap-2">
            {props.legend && <div className="flex flex-wrap gap-x-6 gap-y-1">{props.legend}</div>}
            {props.chart}
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto">{props.table}</div>
        )}
      </LayerCard.Primary>
    </LayerCard>
  )
}

function DataTable({ head, rows, empty = tr("暂无数据") }: { head: string[]; rows: ReactNode[][]; empty?: string }) {
  useLocale()

  if (rows.length === 0) {
    return (
      <Text size="sm" variant="secondary">
        {empty}
      </Text>
    )
  }
  return (
    <Table>
      <Table.Header>
        <Table.Row>
          {head.map((h, i) => (
            <Table.Head key={h} className={i > 0 ? 'text-right' : undefined}>
              {h}
            </Table.Head>
          ))}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {rows.map((cells, r) => (
          <Table.Row key={r}>
            {cells.map((c, i) => (
              <Table.Cell key={i} className={i > 0 ? 'text-right tabular-nums' : 'whitespace-nowrap'}>
                {c}
              </Table.Cell>
            ))}
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  )
}

/** Bucket rows for table views: only buckets with data, newest first. */
function tableRows(ctx: SeriesContext, has: (p: StatsPoint) => boolean, cells: (p: StatsPoint) => ReactNode[]) {
  return ctx.series
    .filter(has)
    .reverse()
    .map((p) => [fmtBucket(p.t, ctx.granularity), ...cells(p)])
}

const xTick = (range: StatsRange) => (ms: number) =>
  range === '24h' ? formatInZone(ms, viewerTimezone).slice(11, 16) : formatInZone(ms, viewerTimezone).slice(5, 10)

/**
 * Axis, grid and aria setup shared by every stats chart. The x axis is a
 * category axis of bucket labels (tooltips show the full label, ticks a short
 * one) so ECharts can drop overlapping tick labels.
 */
function chartBase(
  dark: boolean,
  axis: { labels: string[]; tick?: (i: number) => string; showTick?: (i: number) => boolean },
  aria: string,
) {
  const text = ChartPalette.text('secondary', dark)
  return {
    backgroundColor: 'transparent',
    aria: { enabled: true, label: { description: aria } },
    grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category' as const,
      data: axis.labels,
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: {
        color: text,
        hideOverlap: true,
        ...(axis.showTick ? { interval: (i: number) => axis.showTick!(i) } : {}),
        formatter: (label: string, i: number) => (axis.tick ? axis.tick(i) : label),
      },
    },
    yAxis: {
      type: 'value' as const,
      axisLabel: { color: text },
      splitLine: { lineStyle: { opacity: 0.25, type: 'dashed' as const } },
    },
  }
}

const seriesAxis = (ctx: SeriesContext) => {
  const tick = xTick(ctx.range)
  return {
    labels: ctx.series.map((p) => fmtBucket(p.t, ctx.granularity)),
    tick: (i: number) => tick(ctx.series[i].t),
    // 7d is hourly but ticks show dates: label only the first hour of each local day.
    showTick:
      ctx.range === '7d'
        ? (i: number) => formatInZone(ctx.series[i].t, viewerTimezone).slice(11, 13) === '00'
        : undefined,
  }
}

/** 4px rounded data-end, square at the baseline. */
const DATA_END = [4, 4, 0, 0]

const UNITS = [
  { ms: 60_000, suffix: 'm' },
  { ms: 1000, suffix: 's' },
  { ms: 1, suffix: 'ms' },
]

/** Largest unit that fits the data, so the value axis gets round ticks (5m, 10m, …). */
const durationUnit = (maxMs: number) => UNITS.find((u) => maxMs >= 2 * u.ms) ?? UNITS[UNITS.length - 1]

const shortDuration = (ms: number) => {
  const unit = durationUnit(ms)
  return `${+(ms / unit.ms).toFixed(1)}${unit.suffix}`
}

interface LineSpec {
  name: string
  color: string
  pick: (p: StatsPoint) => number | null
}

/** Duration lines; empty buckets are gaps, isolated points get an 8px marker so they stay visible. */
function DurationLines({ ctx, lines, aria }: { ctx: SeriesContext; lines: LineSpec[]; aria: string }) {
  const dark = useDarkMode()
  const max = Math.max(0, ...ctx.series.flatMap((p) => lines.map((l) => l.pick(p) ?? 0)))
  const unit = durationUnit(max)
  const base = chartBase(dark, seriesAxis(ctx), aria)
  const options: KumoChartOption = {
    ...base,
    yAxis: { ...base.yAxis, axisLabel: { ...base.yAxis.axisLabel, formatter: (v: number) => `${+v.toFixed(2)}${unit.suffix}` } },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v) => (v === null || v === undefined || v === '-' ? '—' : fmtDuration(Math.round(Number(v) * unit.ms))),
    },
    series: lines.map((l) => {
      const values = ctx.series.map((p) => {
        const v = l.pick(p)
        return v === null ? null : v / unit.ms
      })
      const isolated = values.some((v, i) => v !== null && values[i - 1] == null && values[i + 1] == null)
      return {
        type: 'line' as const,
        name: l.name,
        color: l.color,
        data: values,
        lineStyle: { width: 2 },
        showSymbol: isolated,
        symbolSize: 8,
      }
    }),
  }
  return <Chart echarts={echarts} isDarkMode={dark} height={CHART_HEIGHT} options={options} />
}

export function ResultsChart({ ctx, summary }: { ctx: SeriesContext; summary: StatsSummary }) {
  useLocale()

  const dark = useDarkMode()
  const status = statusColors(dark)
  // Fills are separated by a surface-colored stroke (2px, 1px once bars get
  // too dense); only the top-most non-empty segment gets the rounded data-end.
  const segment = { borderColor: surfaceColor(dark), borderWidth: ctx.series.length > 60 ? 1 : 2 }
  const base = chartBase(dark, seriesAxis(ctx), tr("成功 {0} 次，失败 {1} 次", summary.success, summary.failed))
  const options: KumoChartOption = {
    ...base,
    yAxis: { ...base.yAxis, minInterval: 1 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v) => tr("{0} 次", fmtCount(Number(v))) },
    series: [
      {
        type: 'bar',
        name: tr("成功"),
        stack: 'runs',
        barCategoryGap: '20%',
        itemStyle: { ...segment, color: status.success },
        data: ctx.series.map((p) => ({ value: p.success, itemStyle: { borderRadius: p.failed > 0 ? 0 : DATA_END } })),
      },
      {
        type: 'bar',
        name: tr("失败"),
        stack: 'runs',
        itemStyle: { ...segment, color: status.failed, borderRadius: DATA_END },
        data: ctx.series.map((p) => p.failed),
      },
    ],
  }
  return (
    <ChartCard
      title={tr("执行结果")}
      description={tr("每{0}成功 / 失败次数（跳过的执行见表格）", ctx.granularity === 'hour' ? tr('每小时') : tr('每天统计'))}
      legend={
        <>
          <ChartLegend.SmallItem name={tr("成功")} color={status.success} value={fmtCount(summary.success)} />
          <ChartLegend.SmallItem name={tr("失败")} color={status.failed} value={fmtCount(summary.failed)} />
        </>
      }
      chart={<Chart echarts={echarts} isDarkMode={dark} height={CHART_HEIGHT} options={options} />}
      table={
        <DataTable
          head={[tr("时间"), tr("成功"), tr("失败"), tr("跳过"), tr("成功率")]}
          rows={tableRows(
            ctx,
            (p) => p.success + p.failed + p.skipped > 0,
            (p) => [
              fmtCount(p.success),
              fmtCount(p.failed),
              fmtCount(p.skipped),
              fmtPercent(p.success + p.failed === 0 ? null : p.success / (p.success + p.failed)),
            ],
          )}
        />
      }
    />
  )
}

export function DurationChart({ ctx, summary }: { ctx: SeriesContext; summary: StatsSummary }) {
  useLocale()

  const [c1, c2] = seriesColors(useDarkMode())
  return (
    <ChartCard
      title={tr("执行耗时")}
      description={tr("按耗时分布估算的分位数")}
      legend={
        <>
          <ChartLegend.SmallItem name="P50" color={c1} value={fmtDuration(summary.durationP50)} />
          <ChartLegend.SmallItem name="P95" color={c2} value={fmtDuration(summary.durationP95)} />
        </>
      }
      chart={
        <DurationLines
          ctx={ctx}
          aria={tr("耗时 P50 {0}，P95 {1}", fmtDuration(summary.durationP50), fmtDuration(summary.durationP95))}
          lines={[
            { name: 'P50', color: c1, pick: (p) => p.durationP50 },
            { name: 'P95', color: c2, pick: (p) => p.durationP95 },
          ]}
        />
      }
      table={
        <DataTable
          head={[tr("时间"), 'P50', 'P95', tr("平均")]}
          rows={tableRows(
            ctx,
            (p) => p.durationP50 !== null,
            (p) => [fmtDuration(p.durationP50), fmtDuration(p.durationP95), fmtDuration(p.durationAvg)],
          )}
        />
      }
    />
  )
}

export function DelayChart({ ctx, summary }: { ctx: SeriesContext; summary: StatsSummary }) {
  useLocale()

  const [c1, c2] = seriesColors(useDarkMode())
  return (
    <ChartCard
      title={tr("调度延迟")}
      description={tr("计划时间到开始执行的间隔（仅定时触发）")}
      legend={
        <>
          <ChartLegend.SmallItem name={tr("平均")} color={c1} value={fmtDuration(summary.delayAvg)} />
          <ChartLegend.SmallItem name={tr("最大")} color={c2} value={fmtDuration(summary.delayMax)} />
        </>
      }
      chart={
        <DurationLines
          ctx={ctx}
          aria={tr("调度延迟平均 {0}，最大 {1}", fmtDuration(summary.delayAvg), fmtDuration(summary.delayMax))}
          lines={[
            { name: tr("平均"), color: c1, pick: (p) => p.delayAvg },
            { name: tr("最大"), color: c2, pick: (p) => p.delayMax },
          ]}
        />
      }
      table={
        <DataTable
          head={[tr("时间"), tr("平均"), tr("最大")]}
          rows={tableRows(
            ctx,
            (p) => p.delayAvg !== null,
            (p) => [fmtDuration(p.delayAvg), fmtDuration(p.delayMax)],
          )}
        />
      }
    />
  )
}

const bucketLabel = (b: DurationBucket, prev: DurationBucket | undefined) =>
  b.upTo === null ? `> ${shortDuration(prev!.upTo!)}` : `≤ ${shortDuration(b.upTo)}`

export function HistogramChart({ histogram }: { histogram: DurationBucket[] }) {
  useLocale()

  const dark = useDarkMode()
  const [c1] = seriesColors(dark)
  const labels = histogram.map((b, i) => bucketLabel(b, histogram[i - 1]))
  const total = histogram.reduce((s, b) => s + b.count, 0)
  const base = chartBase(dark, { labels }, tr("共 {0} 次执行的耗时分布", total))
  const options: KumoChartOption = {
    ...base,
    yAxis: { ...base.yAxis, minInterval: 1 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v) => tr("{0} 次", fmtCount(Number(v))) },
    series: [
      {
        type: 'bar',
        name: tr("次数"),
        barCategoryGap: '20%',
        itemStyle: { color: c1, borderRadius: DATA_END },
        data: histogram.map((b) => b.count),
      },
    ],
  }
  return (
    <ChartCard
      title={tr("耗时分布")}
      description={tr("所选时间范围内各耗时区间的执行次数")}
      chart={<Chart echarts={echarts} isDarkMode={dark} height={CHART_HEIGHT} options={options} />}
      table={
        <DataTable
          head={[tr("耗时"), tr("次数"), tr("占比")]}
          rows={histogram.map((b, i) => [labels[i], fmtCount(b.count), fmtPercent(total ? b.count / total : null)])}
        />
      }
    />
  )
}

export function TaskRanking({
  title,
  rows,
  metric,
  empty,
}: {
  title: string
  rows: TaskStatsRow[]
  metric: 'failed' | 'p95'
  empty: string
}) {
  useLocale()

  return (
    <LayerCard className="p-0">
      <LayerCard.Secondary>{title}</LayerCard.Secondary>
      <LayerCard.Primary className="overflow-x-auto p-0">
        {rows.length === 0 ? (
          <div className="p-4">
            <Text size="sm" variant="secondary">
              {empty}
            </Text>
          </div>
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>{tr("任务")}</Table.Head>
                <Table.Head className="text-right">{tr("执行")}</Table.Head>
                {metric === 'failed' ? (
                  <>
                    <Table.Head className="text-right">{tr("失败")}</Table.Head>
                    <Table.Head className="text-right">{tr("成功率")}</Table.Head>
                  </>
                ) : (
                  <Table.Head className="text-right">{tr("P95 耗时")}</Table.Head>
                )}
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((r) => (
                <Table.Row key={r.taskId}>
                  <Table.Cell className="max-w-56">
                    <Link href={`/tasks/${r.taskId}`} variant="plain" className="block truncate font-medium">
                      {r.name}
                    </Link>
                  </Table.Cell>
                  <Table.Cell className="text-right tabular-nums">{fmtCount(r.total)}</Table.Cell>
                  {metric === 'failed' ? (
                    <>
                      <Table.Cell className="text-right tabular-nums">{fmtCount(r.failed)}</Table.Cell>
                      <Table.Cell className="text-right tabular-nums">{fmtPercent(r.successRate)}</Table.Cell>
                    </>
                  ) : (
                    <Table.Cell className="text-right tabular-nums">{fmtDuration(r.durationP95)}</Table.Cell>
                  )}
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
      </LayerCard.Primary>
    </LayerCard>
  )
}
