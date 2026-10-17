import { Combobox } from '@cloudflare/kumo'
import { useMemo } from 'react'
import { DEFAULT_TIMEZONE } from '../../../src/lib/time'

const CITIES: Record<string, string> = {
  'Asia/Shanghai': '上海 / 北京 · 中国 · UTC+08:00',
  'Asia/Taipei': '台北 · UTC+08:00',
  'Asia/Hong_Kong': '香港 · UTC+08:00',
  'Asia/Singapore': '新加坡 · UTC+08:00',
  'Asia/Tokyo': '东京 · UTC+09:00',
  'Asia/Seoul': '首尔 · UTC+09:00',
  'Asia/Kolkata': '印度 / 加尔各答',
  'Asia/Calcutta': '印度 / 加尔各答',
  'Asia/Dubai': '迪拜',
  'Europe/London': '伦敦',
  'Europe/Paris': '巴黎',
  'Europe/Berlin': '柏林',
  'America/New_York': '纽约',
  'America/Los_Angeles': '洛杉矶',
  'America/Chicago': '芝加哥',
  'America/Toronto': '多伦多',
  'Australia/Sydney': '悉尼',
  'Pacific/Auckland': '奥克兰',
  UTC: '协调世界时 · UTC+00:00',
}

const TIMEZONES = [...new Set([DEFAULT_TIMEZONE, 'UTC', ...Object.keys(CITIES), ...Intl.supportedValuesOf('timeZone')])]
const label = (zone: string) => CITIES[zone] ? `${CITIES[zone]} — ${zone}` : zone.replaceAll('_', ' ')

export function TimezoneSelect({ value, onChange, error }: {
  value: string
  onChange: (value: string) => void
  error?: string
}) {
  const items = useMemo(() => TIMEZONES.includes(value) ? TIMEZONES : [value, ...TIMEZONES], [value])
  return (
    <Combobox
      label="时区"
      items={items}
      value={value}
      onValueChange={(zone) => { if (zone) onChange(zone) }}
      itemToStringLabel={label}
      filter={(zone, query) => `${zone} ${label(zone)}`.toLowerCase().includes(query.trim().toLowerCase())}
      description="默认上海／北京（Asia/Shanghai）；可搜索城市名或 IANA 标识。调度和触发时间预览均使用所选时区。"
      error={error}
    >
      <Combobox.TriggerInput placeholder="搜索时区，例如上海、Tokyo、UTC" clearLabel="清空搜索" showOptionsLabel="选择时区" />
      <Combobox.Content>
        <Combobox.List>
          {(zone: string) => <Combobox.Item key={zone} value={zone}>{label(zone)}</Combobox.Item>}
        </Combobox.List>
        <Combobox.Empty>没有匹配的时区，请尝试城市名或 IANA 标识。</Combobox.Empty>
      </Combobox.Content>
    </Combobox>
  )
}
