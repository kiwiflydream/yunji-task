import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { decryptString, encryptString } from '../src/lib/crypto'
import { nextFireTime, validateCron } from '../src/lib/schedule'
import { redact, renderTemplate, referencedVariables, UnknownVariableError } from '../src/lib/template'
import { formatInZone, zonedTimeToEpoch } from '../src/lib/time'

const cron = (expr: string, timezone = 'Asia/Shanghai') => ({
  scheduleType: 'cron' as const,
  cron: expr,
  timezone,
  runAt: null,
})

describe('nextFireTime', () => {
  it('supports second-level cron and is strictly after the given time', () => {
    const t = Date.parse('2026-10-16T00:00:03Z')
    expect(nextFireTime(cron('*/10 * * * * *'), t)).toBe(Date.parse('2026-10-16T00:00:10Z'))
    expect(nextFireTime(cron('*/10 * * * * *'), Date.parse('2026-10-16T00:00:10Z'))).toBe(
      Date.parse('2026-10-16T00:00:20Z'),
    )
  })

  it('evaluates cron in the task timezone', () => {
    const t = Date.parse('2026-10-16T00:00:00Z')
    expect(nextFireTime(cron('0 0 9 * * *', 'Asia/Shanghai'), t)).toBe(Date.parse('2026-10-16T01:00:00Z'))
    expect(nextFireTime(cron('0 0 9 * * *', 'UTC'), t)).toBe(Date.parse('2026-10-16T09:00:00Z'))
  })

  it('returns runAt for once and null for manual', () => {
    expect(nextFireTime({ scheduleType: 'once', cron: null, timezone: 'UTC', runAt: 123 }, 999)).toBe(123)
    expect(nextFireTime({ scheduleType: 'manual', cron: null, timezone: 'UTC', runAt: null }, 0)).toBeNull()
  })

  it('rejects anything but 6-field cron', () => {
    expect(validateCron('*/5 * * * * *', 'UTC')).toBeNull()
    expect(validateCron('*/5 * * * *', 'UTC')).toBe('需要 6 段（秒 分 时 日 月 周），当前是 5 段')
    expect(validateCron('*/5 * * * * * * *', 'UTC')).toBe('需要 6 段（秒 分 时 日 月 周），当前是 8 段')
    expect(validateCron('99 * * * * *', 'UTC')).toMatch(/^无效的 cron 表达式：/)
    expect(validateCron('nope', 'UTC')).not.toBeNull()
  })
})

describe('zoned time', () => {
  it('converts wall-clock time in a zone to epoch and back', () => {
    const epoch = zonedTimeToEpoch('2026-10-16T09:30', 'Asia/Shanghai')
    expect(epoch).toBe(Date.parse('2026-10-16T01:30:00Z'))
    expect(formatInZone(epoch!, 'Asia/Shanghai')).toBe('2026-10-16 09:30:00')
  })

  it('handles DST zones', () => {
    // New York is UTC-4 in July, UTC-5 in December.
    expect(zonedTimeToEpoch('2026-07-01T12:00', 'America/New_York')).toBe(Date.parse('2026-07-01T16:00:00Z'))
    expect(zonedTimeToEpoch('2026-12-01T12:00', 'America/New_York')).toBe(Date.parse('2026-12-01T17:00:00Z'))
  })
})

describe('template', () => {
  it('renders variables and rejects unknown ones', () => {
    expect(renderTemplate('Bearer {{ TOKEN }}', { TOKEN: 'abc' })).toBe('Bearer abc')
    expect(() => renderTemplate('{{A}}{{B}}', { A: '1' })).toThrow(UnknownVariableError)
    expect(() => renderTemplate('{{A}}{{B}}', { A: '1' })).toThrow('B')
  })

  it('lists only dot-free names as variable references', () => {
    expect(referencedVariables('{{A}} {{task.name}}', '{{B}} {{A}}').sort()).toEqual(['A', 'B'])
  })

  it('redacts secrets', () => {
    expect(redact('token=supersecret&x=1', ['supersecret'])).toBe('token=***&x=1')
    expect(redact('abc', ['ab'])).toBe('abc')
  })
})

describe('crypto', () => {
  it('round-trips and binds ciphertext to its name', async () => {
    const enc = await encryptString(env.ENCRYPTION_KEY, 'hello 世界', 'NAME')
    expect(enc).not.toContain('hello')
    expect(await decryptString(env.ENCRYPTION_KEY, enc, 'NAME')).toBe('hello 世界')
    await expect(decryptString(env.ENCRYPTION_KEY, enc, 'OTHER')).rejects.toThrow()
  })
})
