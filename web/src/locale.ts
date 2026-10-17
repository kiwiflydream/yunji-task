import { en } from './locales/en'

export type Locale = 'zh-CN' | 'en'
export const LANGUAGE_STORAGE_KEY = 'yunji-task.locale'
const listeners = new Set<() => void>()
let locale: Locale = 'zh-CN'

export function resolveLocale(saved: string | null, languages: readonly string[]): Locale {
  if (saved === 'zh-CN' || saved === 'en') return saved
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return 'zh-CN'
    if (/^en(?:-|$)/i.test(language)) return 'en'
  }
  return 'en'
}

export const getLocale = () => locale
export function setLocale(value: Locale) {
  if (value === locale) return
  locale = value
  for (const notify of listeners) notify()
}
export function subscribeLocale(notify: () => void) {
  listeners.add(notify)
  return () => { listeners.delete(notify) }
}

/** Translate application messages only; never pass user content to this function. */
export function tr(source: string, ...values: unknown[]): string {
  const template = locale === 'en' && Object.hasOwn(en, source) ? en[source] : source
  return template.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < values.length ? String(values[Number(index)]) : match)
}

const originalMessages = new Map(Object.entries(en).map(([source, translated]) => [translated, source]))
const validationTemplates = [
  '第 {0} 个请求头缺少名称',
  'Worker 异步只支持 {0} 秒以内的超时（当前 {1} 秒）',
  '需要 6 段（秒 分 时 日 月 周），当前是 {0} 段',
  '无效的 cron 表达式：{0}',
]

export function localizeIssueMessage(message: string): string
export function localizeIssueMessage(message: string | undefined): string | undefined
export function localizeIssueMessage(message: string | undefined): string | undefined {
  if (!message) return message
  const source = originalMessages.get(message) ?? message
  if (Object.hasOwn(en, source)) return tr(source)
  const rule = /^第 (\d+) 条条件：(.*)$/s.exec(source)
  if (rule) return tr('第 {0} 条条件：{1}', rule[1], localizeIssueMessage(rule[2]))
  for (const template of validationTemplates) {
    const pattern = template.split(/\{\d+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+?)')
    const match = new RegExp(`^${pattern}$`, 's').exec(source)
    if (match) return tr(template, ...match.slice(1))
  }
  // The API uses Zod's Chinese locale; browser-only schemas may use its English defaults.
  const chineseLimit = /^数值过(小|大)：期望 (string|number|int|array) (>=|<=|>|<)([\d.]+)(?: 字符| 项)?$/.exec(source)
  if (chineseLimit) {
    if (chineseLimit[2] === 'string') return tr(chineseLimit[1] === '小' ? '至少需要 {0} 个字符' : '最多允许 {0} 个字符', chineseLimit[4])
    return tr('数值必须满足 {0} {1}', chineseLimit[3], chineseLimit[4])
  }
  if (source.startsWith('无效输入：期望 数字') || source.startsWith('无效输入：期望 int')) return tr('请输入有效的数值')
  if (source.startsWith('无效选项：')) return tr('请选择有效选项')
  if (source.startsWith('无效输入：') && source.includes('undefined')) return tr('请填写必填字段')
  if (source === '无效输入') return tr('请填写有效值')
  if (source === '无效URL') return tr('请输入有效的 URL')
  const limit = /^Too (small|big): expected (string|number) to (?:have |be )(?:>=|<=)([\d.]+)(?: characters)?$/.exec(source)
  if (limit) return tr(limit[2] === 'string' ? limit[1] === 'small' ? '至少需要 {0} 个字符' : '最多允许 {0} 个字符'
    : limit[1] === 'small' ? '数值不能小于 {0}' : '数值不能大于 {0}', limit[3])
  if (source === 'Invalid URL') return tr('请输入有效的 URL')
  if (/^Invalid input: expected (?:number|int),/.test(source)) return tr('请输入有效的数值')
  if (source.startsWith('Invalid option:')) return tr('请选择有效选项')
  if (source.includes('received undefined')) return tr('请填写必填字段')
  return source
}
