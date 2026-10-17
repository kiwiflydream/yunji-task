import { afterEach, describe, expect, it } from 'vitest'
import { taskInputSchema } from '../src/domain/task'
import { en } from '../web/src/locales/en'
import { getLocale, localizeIssueMessage, resolveLocale, setLocale, subscribeLocale, tr } from '../web/src/locale'
import { fmtRelative, fmtTime } from '../web/src/lib/format'
import { MODE_LABEL, suggestionText } from '../web/src/lib/execution-mode'
import { describeLocalizedSuccessRule } from '../web/src/lib/success-rules'

afterEach(() => setLocale('zh-CN'))

describe('language selection', () => {
  it('prioritizes an explicit supported choice over the browser', () => {
    expect(resolveLocale('en', ['zh-CN'])).toBe('en')
    expect(resolveLocale('zh-CN', ['en-US'])).toBe('zh-CN')
  })
  it('recognizes regional Chinese and English and finds the first supported language', () => {
    expect(resolveLocale(null, ['zh-TW', 'en'])).toBe('zh-CN')
    expect(resolveLocale(null, ['en-GB', 'zh'])).toBe('en')
    expect(resolveLocale('invalid', ['fr-FR', 'zh-HK'])).toBe('zh-CN')
    expect(resolveLocale(null, ['fr-FR'])).toBe('en')
    expect(resolveLocale(null, [])).toBe('en')
  })
  it('notifies subscribers only on a change and supports cleanup', () => {
    const seen: string[] = []
    const unsubscribe = subscribeLocale(() => seen.push(getLocale()))
    setLocale('en')
    setLocale('en')
    unsubscribe()
    setLocale('zh-CN')
    expect(seen).toEqual(['en'])
  })
})

describe('translation integrity', () => {
  it('keeps interpolation arguments in every English message', () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort()
    for (const [source, translation] of Object.entries(en)) {
      expect(translation.trim(), source).not.toBe('')
      expect(placeholders(translation), source).toEqual(placeholders(source))
    }
  })
  it('interpolates without changing placeholder values or interpreting nested braces', () => {
    setLocale('en')
    expect(tr('删除 {0}', '用户任务 {{TOKEN}}')).toBe('Delete 用户任务 {{TOKEN}}')
    expect(tr('第 {0} 条条件：{1}', 2, '{0}')).toBe('Condition 2: {0}')
    expect(tr('unrecognized message')).toBe('unrecognized message')
    expect(tr('当前全局：{0}（设置页可修改）', MODE_LABEL.direct)).toBe('Current global mode: Direct (change in Settings)')
    setLocale('zh-CN')
    expect(MODE_LABEL.direct).toBe('直接执行')
    expect(tr('删除 {0}', '用户任务')).toBe('删除 用户任务')
  })
  it('localizes recommendations without changing execution policy', () => {
    setLocale('en')
    for (const duration of [null, 500, 4000]) {
      expect(suggestionText(duration, 60_000, false)).not.toMatch(/[\u3400-\u9fff]/)
    }
    expect(suggestionText(null, 25_000, true)).toContain('Worker async')
  })
  it('translates validation messages, including dynamic paths and Zod limits', () => {
    setLocale('en')
    expect(localizeIssueMessage('第 2 条条件：请填写比较值')).toBe('Condition 2: Enter a comparison value')
    expect(localizeIssueMessage('Worker 异步只支持 25 秒以内的超时（当前 30 秒）')).toContain('at most 25 seconds (currently 30 seconds)')
    expect(localizeIssueMessage('需要 6 段（秒 分 时 日 月 周），当前是 5 段')).toContain('got 5')
    expect(localizeIssueMessage('Too small: expected string to have >=1 characters')).toBe('Minimum length: 1 characters')
    setLocale('zh-CN')
    expect(localizeIssueMessage('Save failed. Check the highlighted fields.')).toBe('保存失败，请检查标出的字段。')
    expect(localizeIssueMessage('Invalid URL')).toBe('请输入有效的 URL')
  })
  it('localizes real API schema errors for an invalid task', () => {
    setLocale('en')
    const result = taskInputSchema.safeParse({ name: '', schedule: { type: 'manual' }, executor: { type: 'http', config: { url: 'bad', timeoutMs: -1 } }, retry: { count: -1, intervalSeconds: 0 } })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('Expected invalid task')
    for (const issue of result.error.issues) {
      expect(localizeIssueMessage(issue.message), issue.path.join('.')).not.toMatch(/[\u3400-\u9fff]/)
    }
  })
  it('keeps raw response values in advanced rule descriptions', () => {
    setLocale('en')
    expect(describeLocalizedSuccessRule({ type: 'json', path: 'data.status', operator: 'eq', value: '成功' }))
      .toBe('JSON field data.status equals "成功"')
  })
  it('uses the selected language while preserving the requested timezone', () => {
    const now = Date.UTC(2026, 9, 17, 0)
    setLocale('en')
    expect(fmtRelative(now + 60_000, now)).toBe('in 1 minute')
    expect(fmtRelative(now - 3_600_000, now)).toBe('1 hour ago')
    expect(fmtTime(now, 'Asia/Shanghai')).toContain('08:00:00')
    expect(fmtTime(now, 'Asia/Shanghai')).toContain('Oct')
    setLocale('zh-CN')
    expect(fmtRelative(now + 60_000, now)).toBe('1分钟后')
    expect(fmtTime(now, 'Asia/Shanghai')).toBe('2026-10-17 08:00:00')
  })
})
