export type CronFrequency = 'seconds' | 'minutes' | 'hours' | 'daily' | 'weekly' | 'monthly'

export interface CronRule {
  frequency: CronFrequency
  interval: number
  hour: number
  minute: number
  second: number
  day: number
  weekdays: number[]
}

export const DEFAULT_CRON_RULE: CronRule = {
  frequency: 'daily', interval: 5, hour: 9, minute: 0, second: 0, day: 1, weekdays: [1],
}

export type CronRulePatch = Partial<CronRule> | ((rule: CronRule) => Partial<CronRule>)

export function patchCronRule(cron: string, patch: CronRulePatch): string {
  const current = ruleFromCron(cron) ?? DEFAULT_CRON_RULE
  const next = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) }
  next.interval = Math.min(next.interval, next.frequency === 'hours' ? 23 : 59)
  return cronFromRule(next)
}

export function cronFromRule(rule: CronRule): string {
  const { frequency, interval, hour, minute, second, day, weekdays } = rule
  switch (frequency) {
    case 'seconds': return `*/${interval} * * * * *`
    case 'minutes': return `${second} */${interval} * * * *`
    case 'hours': return `${second} ${minute} */${interval} * * *`
    case 'daily': return `${second} ${minute} ${hour} * * *`
    case 'weekly': return `${second} ${minute} ${hour} * * ${[...weekdays].sort((a, b) => a - b).join(',')}`
    case 'monthly': return `${second} ${minute} ${hour} ${day} * *`
  }
}

const integer = (value: string, min: number, max: number): number | null =>
  /^\d+$/.test(value) && Number(value) >= min && Number(value) <= max ? Number(value) : null

function step(value: string, max: number): number | null {
  return value === '*' ? 1 : value.startsWith('*/') ? integer(value.slice(2), 1, max) : null
}

function weekdaysFromCron(value: string): number[] | null {
  const days = new Set<number>()
  for (const part of value.split(',')) {
    const range = part.split('-')
    if (range.length > 2) return null
    const from = integer(range[0], 0, 7)
    const to = integer(range[1] ?? range[0], 0, 7)
    if (from === null || to === null || from > to) return null
    for (let n = from; n <= to; n++) days.add(n % 7)
  }
  return days.size ? [...days].sort((a, b) => a - b) : null
}

/** Only recognize patterns the visual form can reproduce without changing their meaning. */
export function ruleFromCron(cron: string): CronRule | null {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 6) return null
  const [s, m, h, d, month, w] = fields
  if (month !== '*') return null
  const rule = { ...DEFAULT_CRON_RULE, weekdays: [...DEFAULT_CRON_RULE.weekdays] }
  const second = integer(s, 0, 59)
  const minute = integer(m, 0, 59)
  const hour = integer(h, 0, 23)
  if (d === '*' && w === '*') {
    const seconds = step(s, 59)
    if (seconds !== null && m === '*' && h === '*') return { ...rule, frequency: 'seconds', interval: seconds }
    if (second === null) return null
    const minutes = step(m, 59)
    if (minutes !== null && h === '*') return { ...rule, frequency: 'minutes', interval: minutes, second }
    if (minute === null) return null
    const hours = step(h, 23)
    if (hours !== null) return { ...rule, frequency: 'hours', interval: hours, minute, second }
    if (hour !== null) return { ...rule, frequency: 'daily', hour, minute, second }
  }
  if (second === null || minute === null || hour === null) return null
  if (d === '*' && w !== '*') {
    const weekdays = weekdaysFromCron(w)
    if (weekdays) return { ...rule, frequency: 'weekly', hour, minute, second, weekdays }
  }
  const day = integer(d, 1, 31)
  return day !== null && w === '*' ? { ...rule, frequency: 'monthly', hour, minute, second, day } : null
}
