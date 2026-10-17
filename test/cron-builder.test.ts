import { describe, expect, it } from 'vitest'
import { nextFireTime, validateCron } from '../src/lib/schedule'
import { cronFromRule, DEFAULT_CRON_RULE, patchCronRule, ruleFromCron } from '../web/src/lib/cron-builder'

describe('visual cron rules', () => {
  it.each([
    ['*/10 * * * * *', 'seconds'],
    ['* * * * * *', 'seconds'],
    ['15 */5 * * * *', 'minutes'],
    ['15 20 */3 * * *', 'hours'],
    ['15 30 9 * * *', 'daily'],
    ['0 30 9 * * 1,3,5', 'weekly'],
    ['0 30 9 31 * *', 'monthly'],
  ])('preserves trigger times when round-tripping %s', (expression, frequency) => {
    const rule = ruleFromCron(expression)
    expect(rule?.frequency).toBe(frequency)
    const generated = cronFromRule(rule!)
    expect(validateCron(generated, 'Asia/Shanghai')).toBeNull()
    let after = Date.UTC(2026, 9, 17)
    for (let n = 0; n < 5; n++) {
      const spec = { scheduleType: 'cron' as const, timezone: 'Asia/Shanghai', runAt: null }
      const next = nextFireTime({ ...spec, cron: expression }, after)!
      expect(nextFireTime({ ...spec, cron: generated }, after)).toBe(next)
      after = next
    }
  })

  it('reads weekday ranges and Sunday aliases without mutating the selection', () => {
    expect(ruleFromCron('0 30 9 * * 1-5')?.weekdays).toEqual([1, 2, 3, 4, 5])
    expect(ruleFromCron('0 0 9 * * 7,1')?.weekdays).toEqual([0, 1])
    const rule = { ...DEFAULT_CRON_RULE, frequency: 'weekly' as const, weekdays: [5, 1] }
    expect(cronFromRule(rule)).toBe('0 0 9 * * 1,5')
    expect(rule.weekdays).toEqual([5, 1])
  })

  it.each(['0 0 9 1 * 1', '0 0 9 * 1 *', '0 0 9 * * MON#2', '0,30 * * * * *', '0 0 9 * *', '', '60 0 9 * * *'])('leaves advanced or invalid patterns for manual editing: %s', (expression) => {
    expect(ruleFromCron(expression)).toBeNull()
  })

  it('skips months without the selected day', () => {
    const cron = cronFromRule({ ...DEFAULT_CRON_RULE, frequency: 'monthly', day: 31 })
    expect(nextFireTime({ scheduleType: 'cron', cron, timezone: 'Asia/Shanghai', runAt: null }, Date.UTC(2026, 1, 1))).toBe(Date.UTC(2026, 2, 31, 1))
  })

  it('patches the latest expression and bounds the interval when changing units', () => {
    const changedInterval = patchCronRule('*/5 * * * * *', { interval: 59 })
    const hourly = patchCronRule(changedInterval, { frequency: 'hours' })
    expect(hourly).toBe('0 0 */23 * * *')
    expect(validateCron(hourly, 'Asia/Shanghai')).toBeNull()
    const changedMinute = patchCronRule(hourly, { minute: 20 })
    expect(patchCronRule(changedMinute, { second: 15 })).toBe('15 20 */23 * * *')
  })
})
