import { COMPARISON_LABELS, NUMERIC_COMPARISONS, type Comparison, type SuccessRule } from '../../../src/executor/success-condition'
import { tr } from '../locale'

export function describeLocalizedSuccessRule(rule: SuccessRule): string {
  const target = rule.type === 'status' ? tr('HTTP 响应码') : rule.type === 'body' ? tr('响应正文') : `${tr('JSON 字段')} ${rule.path}`
  const operator = tr(COMPARISON_LABELS[rule.operator])
  if (rule.operator === 'exists' || rule.operator === 'not_exists') return `${target} ${operator}`
  return `${target} ${operator} ${JSON.stringify(rule.value)}${rule.type === 'status' && rule.operator === 'between' ? `–${rule.valueTo}` : ''}`
}

export interface SuccessRuleForm {
  id: string
  type: SuccessRule['type']
  operator: Comparison
  path: string
  value: string
  valueTo: string
  valueType: 'string' | 'number' | 'boolean' | 'null'
}

export function newSuccessRule(type: SuccessRule['type'] = 'json'): SuccessRuleForm {
  return {
    id: crypto.randomUUID(), type, operator: type === 'status' ? 'between' : type === 'body' ? 'contains' : 'eq',
    path: 'code', value: type === 'status' ? '200' : type === 'json' ? '0' : '', valueTo: '299',
    valueType: type === 'body' ? 'string' : 'number',
  }
}

export function successRuleToForm(rule: SuccessRule): SuccessRuleForm {
  return {
    ...newSuccessRule(rule.type), operator: rule.operator,
    path: rule.type === 'json' ? rule.path : '',
    value: rule.value == null ? '' : String(rule.value),
    valueTo: rule.type === 'status' && rule.valueTo !== undefined ? String(rule.valueTo) : '',
    valueType: rule.value === null ? 'null' : typeof rule.value === 'number' ? 'number' : typeof rule.value === 'boolean' ? 'boolean' : 'string',
  }
}

const numberValue = (value: string) => value.trim() === '' ? Number.NaN : Number(value)

export function successRuleToInput(rule: SuccessRuleForm): unknown {
  if (rule.type === 'status') return {
    type: rule.type, operator: rule.operator, value: numberValue(rule.value),
    ...(rule.operator === 'between' ? { valueTo: numberValue(rule.valueTo) } : {}),
  }
  if (rule.type === 'body') return { type: rule.type, operator: rule.operator, value: rule.value }
  const existence = rule.operator === 'exists' || rule.operator === 'not_exists'
  const numeric = (NUMERIC_COMPARISONS as readonly string[]).includes(rule.operator) || rule.valueType === 'number'
  return {
    type: rule.type, path: rule.path, operator: rule.operator,
    ...(!existence ? { value: numeric ? numberValue(rule.value) : rule.valueType === 'null' ? null : rule.valueType === 'boolean' ? rule.value === 'true' : rule.value } : {}),
  }
}
