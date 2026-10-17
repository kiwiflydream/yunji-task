import { tr, useLocale } from '../i18n'
import { Checkbox, Input, Select, Text } from '@cloudflare/kumo'
import type { SetStateAction } from 'react'
import { DEFAULT_CRON_RULE, patchCronRule, ruleFromCron, type CronFrequency, type CronRulePatch } from '../lib/cron-builder'

const FREQUENCIES: [CronFrequency, string][] = [
  ['seconds', '每隔 N 秒'], ['minutes', '每隔 N 分钟'], ['hours', '每隔 N 小时'],
  ['daily', '每天'], ['weekly', '每周'], ['monthly', '每月'],
]
const DAYS = [[1, '周一'], [2, '周二'], [3, '周三'], [4, '周四'], [5, '周五'], [6, '周六'], [0, '周日']] as const
const pad = (n: number) => String(n).padStart(2, '0')

export function CronEditor({ value, onChange, error }: { value: string; onChange: (value: SetStateAction<string>) => void; error?: string }) {
  useLocale()

  const parsed = ruleFromCron(value)
  const rule = parsed ?? DEFAULT_CRON_RULE
  // Apply dropdown changes to the latest expression, including changes made by other controls.
  const update = (patch: CronRulePatch) => onChange((current) => patchCronRule(current, patch))
  const frequency = parsed?.frequency ?? 'custom'
  return (
    <>
      <div className="flex flex-col gap-4 rounded-lg border border-kumo-line bg-kumo-recessed p-4">
        <Select
          label={tr("可视化调度频率")}
          value={frequency}
          renderValue={(v) => tr(FREQUENCIES.find(([key]) => key === v)?.[1] ?? '高级表达式（手动编辑）')}
          onValueChange={(v) => { if (v !== 'custom') update({ frequency: v as CronFrequency }) }}
          description={tr("选择后自动生成下方的 Cron 表达式，也可直接编辑表达式。")}
        >
          {FREQUENCIES.map(([v, label]) => <Select.Option key={v} value={v}>{tr(label)}</Select.Option>)}
          <Select.Option value="custom" disabled={!!parsed}>{tr("高级表达式（手动编辑）")}</Select.Option>
        </Select>
        {parsed && (
          <>
            {['seconds', 'minutes', 'hours'].includes(frequency) && (
              <Select key={frequency} label={tr("重复间隔")} value={String(rule.interval)} onValueChange={(v) => update({ interval: Number(v) })}
                renderValue={(v) => `${v} ${frequency === 'hours' ? tr("小时") : frequency === 'minutes' ? tr("分钟") : tr("秒")}`}
                description={tr("按秒／分／时的刻度重新起算；例如每 7 分钟会在每小时的 0、7…56 分触发。")}>
                {Array.from({ length: frequency === 'hours' ? 23 : 59 }, (_, i) => i + 1).map((n) => (
                  <Select.Option key={n} value={String(n)}>{n} {frequency === 'hours' ? tr("小时") : frequency === 'minutes' ? tr("分钟") : tr("秒")}</Select.Option>
                ))}
              </Select>
            )}
            {frequency === 'minutes' && (
              <NumberSelect label={tr("触发秒数")} value={rule.second} max={59} onChange={(second) => update({ second })} />
            )}
            {frequency === 'hours' && (
              <div className="grid grid-cols-2 gap-4">
                <NumberSelect label={tr("触发分钟")} value={rule.minute} max={59} onChange={(minute) => update({ minute })} />
                <NumberSelect label={tr("触发秒数")} value={rule.second} max={59} onChange={(second) => update({ second })} />
              </div>
            )}
            {['daily', 'weekly', 'monthly'].includes(frequency) && (
              <Input label={tr("触发时刻")} type="time" step={1} value={`${pad(rule.hour)}:${pad(rule.minute)}:${pad(rule.second)}`}
                onChange={(e) => {
                  if (!e.target.value) return
                  const [hour, minute, second = 0] = e.target.value.split(':').map(Number)
                  update({ hour, minute, second })
                }} description={tr("按下方选择的时区执行，支持精确到秒。")} />
            )}
            {frequency === 'weekly' && (
              <fieldset>
                <legend className="mb-2 text-sm font-medium">{tr("选择星期（至少一天）")}</legend>
                <div className="flex flex-wrap gap-x-5 gap-y-3">
                  {DAYS.map(([day, label]) => (
                    <Checkbox key={day} label={tr(label)} checked={rule.weekdays.includes(day)}
                      disabled={rule.weekdays.length === 1 && rule.weekdays.includes(day)}
                      onCheckedChange={(checked) => update((current) => ({ weekdays: checked ? [...current.weekdays, day] : current.weekdays.filter((d) => d !== day) }))} />
                  ))}
                </div>
              </fieldset>
            )}
            {frequency === 'monthly' && (
              <NumberSelect label={tr("每月日期")} value={rule.day} min={1} max={31} onChange={(day) => update({ day })}
                description={tr("选择 29、30、31 日时，没有该日期的月份会跳过。")} />
            )}
          </>
        )}
        {!parsed && <Text size="sm" variant="secondary">{tr("当前表达式使用高级规则，原文已保留。可直接编辑下方表达式；选择上方频率将用新规则替换。")}</Text>}
      </div>
      <Input label={tr("Cron 表达式")} className="font-mono" value={value} onChange={(e) => onChange(e.target.value)}
        description={tr("6 段：秒 分 时 日 月 周。例如 0 30 9 * * 1-5 表示工作日 9:30。")} error={error} />
    </>
  )
}

function NumberSelect({ label, value, onChange, min = 0, max, description }: {
  label: string; value: number; onChange: (value: number) => void; min?: number; max: number; description?: string
}) {
  return (
    <Select label={label} value={String(value)} onValueChange={(v) => onChange(Number(v))} description={description}>
      {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((n) => <Select.Option key={n} value={String(n)}>{n}</Select.Option>)}
    </Select>
  )
}
