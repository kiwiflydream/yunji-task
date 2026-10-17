import { z } from 'zod'

export const COMPARISON_LABELS = {
  eq: '等于', ne: '不等于', contains: '包含', not_contains: '不包含',
  gt: '大于', gte: '大于等于', lt: '小于', lte: '小于等于',
  between: '介于（含边界）', exists: '存在', not_exists: '不存在',
} as const
export type Comparison = keyof typeof COMPARISON_LABELS
export const NUMERIC_COMPARISONS = ['gt', 'gte', 'lt', 'lte'] as const

export function jsonPathParts(path: string): string[] | null {
  if (path === '$') return []
  const normalized = path.startsWith('$.') ? path.slice(2) : path.startsWith('$[') ? path.slice(1) : path
  if (!/^(?:[^\s.\[\]]+|\[\d+\])(?:\.[^\s.\[\]]+|\[\d+\])*$/u.test(normalized)) return null
  return normalized.replace(/\[(\d+)\]/g, '.$1').replace(/^\./, '').split('.')
}

const scalarSchema = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()], { error: '请填写有效的比较值（字符串、数字、布尔值或 null）' })
const ruleSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('status'),
    operator: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between']),
    value: z.number().int().min(100).max(599),
    valueTo: z.number().int().min(100).max(599).optional(),
  }),
  z.object({
    type: z.literal('body'),
    operator: z.enum(['eq', 'ne', 'contains', 'not_contains']),
    value: z.string().max(2000),
  }),
  z.object({
    type: z.literal('json'),
    path: z.string().trim().min(1).max(200).refine((path) => jsonPathParts(path) !== null, '字段路径请使用 data.code、items[0].id 或 $'),
    operator: z.enum(['eq', 'ne', 'contains', 'not_contains', 'gt', 'gte', 'lt', 'lte', 'exists', 'not_exists']),
    value: scalarSchema.optional(),
  }),
]).superRefine((rule, ctx) => {
  if (rule.type === 'status' && rule.operator === 'between' && (rule.valueTo === undefined || rule.valueTo < rule.value)) {
    ctx.addIssue({ code: 'custom', path: ['valueTo'], message: '请填写范围上限，且不能小于下限' })
  }
  if (rule.type === 'json' && !['exists', 'not_exists'].includes(rule.operator) && rule.value === undefined) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: '请填写比较值' })
  }
  if (rule.type === 'json' && (NUMERIC_COMPARISONS as readonly string[]).includes(rule.operator) && typeof rule.value !== 'number') {
    ctx.addIssue({ code: 'custom', path: ['value'], message: '大小比较需要数字类型的比较值' })
  }
  if (rule.type !== 'status' && ['contains', 'not_contains'].includes(rule.operator) && rule.value === '') {
    ctx.addIssue({ code: 'custom', path: ['value'], message: '包含条件的比较值不能为空' })
  }
})

export const successConditionSchema = z.object({
  match: z.enum(['all', 'any']),
  rules: z.array(ruleSchema).min(1, '请至少添加一条条件').max(20, '最多添加 20 条条件'),
})
export type SuccessCondition = z.output<typeof successConditionSchema>
export type SuccessRule = SuccessCondition['rules'][number]

export function describeSuccessRule(rule: SuccessRule): string {
  const target = rule.type === 'status' ? 'HTTP 响应码' : rule.type === 'body' ? '响应正文' : `JSON 字段 ${rule.path}`
  if (rule.operator === 'exists' || rule.operator === 'not_exists') return `${target} ${COMPARISON_LABELS[rule.operator]}`
  const value = JSON.stringify(rule.value)
  return `${target} ${COMPARISON_LABELS[rule.operator]} ${value}${rule.type === 'status' && rule.operator === 'between' ? `–${rule.valueTo}` : ''}`
}

function fieldAt(root: unknown, path: string): { found: boolean; value?: unknown } {
  const parts = jsonPathParts(path)
  if (parts === null) return { found: false }
  let value = root
  for (const part of parts) {
    if (typeof value !== 'object' || value === null || !Object.prototype.hasOwnProperty.call(value, part)) return { found: false }
    value = (value as Record<string, unknown>)[part]
  }
  return { found: true, value }
}

function compare(actual: unknown, expected: unknown, operator: Comparison): boolean {
  if (operator === 'eq') return actual === expected
  if (operator === 'ne') return actual !== expected
  if (operator === 'contains' || operator === 'not_contains') {
    if (!(typeof actual === 'string' && typeof expected === 'string') && !Array.isArray(actual)) return false
    const contains = Array.isArray(actual) ? actual.some((item) => item === expected) : (actual as string).includes(expected as string)
    return operator === 'contains' ? contains : !contains
  }
  if (typeof actual !== 'number' || !Number.isFinite(actual) || typeof expected !== 'number') return false
  if (operator === 'gt') return actual > expected
  if (operator === 'gte') return actual >= expected
  if (operator === 'lt') return actual < expected
  if (operator === 'lte') return actual <= expected
  return false
}

/** Body rules require a complete response; an unverified rule never counts as a match. */
export function evaluateSuccessCondition(condition: SuccessCondition, status: number, body: string, bodyTooLarge = false): string | null {
  let json: unknown
  let jsonValid = false
  if (!bodyTooLarge && condition.rules.some((rule) => rule.type === 'json')) {
    try { json = JSON.parse(body); jsonValid = true } catch { /* Report invalid JSON only for JSON rules. */ }
  }
  const failures = condition.rules.map((rule, index): string | null => {
    const prefix = `第 ${index + 1} 条：`
    if (rule.type === 'status') {
      const ok = rule.operator === 'between'
        ? status >= rule.value && status <= rule.valueTo!
        : compare(status, rule.value, rule.operator)
      return ok ? null : `${prefix}HTTP ${status} 未满足响应码条件`
    }
    if (bodyTooLarge) return `${prefix}响应体超过 1 MiB，无法完整判断`
    if (rule.type === 'body') return compare(body, rule.value, rule.operator) ? null : `${prefix}响应正文未满足「${COMPARISON_LABELS[rule.operator]}」条件`
    if (!jsonValid) return `${prefix}响应体不是有效 JSON`
    const field = fieldAt(json, rule.path)
    if (rule.operator === 'not_exists') return !field.found ? null : `${prefix}JSON 字段 ${rule.path} 仍存在`
    if (!field.found) return `${prefix}JSON 字段 ${rule.path} 不存在`
    if (rule.operator === 'exists') return null
    return compare(field.value, rule.value, rule.operator) ? null : `${prefix}JSON 字段 ${rule.path} 未满足「${COMPARISON_LABELS[rule.operator]}」条件`
  })
  const ok = condition.match === 'all' ? failures.every((failure) => failure === null) : failures.some((failure) => failure === null)
  return ok ? null : `高级成功条件未满足（${condition.match === 'all' ? '全部满足' : '任一满足'}）：${failures.filter(Boolean).join('；')}`.slice(0, 2000)
}
