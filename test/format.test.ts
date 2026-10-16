import { describe, expect, it } from 'vitest'
import { fmtBucket, fmtDuration, fmtPercent } from '../web/src/lib/format'

describe('fmtDuration', () => {
  it('scales from ms to hours', () => {
    expect(fmtDuration(null)).toBe('—')
    expect(fmtDuration(999)).toBe('999ms')
    expect(fmtDuration(1234)).toBe('1.23s')
    expect(fmtDuration(12_345)).toBe('12.3s')
    expect(fmtDuration(2_065_700)).toBe('34m26s')
    expect(fmtDuration(60_000)).toBe('1m00s')
    expect(fmtDuration(5 * 3_600_000 + 7 * 60_000)).toBe('5h07m')
  })
})

describe('fmtPercent', () => {
  it('floors so an imperfect rate never shows as 100%', () => {
    expect(fmtPercent(null)).toBe('—')
    expect(fmtPercent(1)).toBe('100%')
    expect(fmtPercent(0.9996)).toBe('99.9%')
    expect(fmtPercent(0.5)).toBe('50.0%')
  })
})

describe('fmtBucket', () => {
  it('labels hourly and daily buckets in the viewer timezone', () => {
    // The test runtime's timezone is UTC.
    const t = Date.UTC(2026, 9, 16, 8)
    expect(fmtBucket(t, 'hour')).toBe('10-16 08:00')
    expect(fmtBucket(t, 'day')).toBe('10-16')
  })
})
