import { tr, useLocale } from '../i18n'
import { Button, Input, Select, Text } from '@cloudflare/kumo'
import { PlusIcon, TrashIcon } from '@phosphor-icons/react'
import { COMPARISON_LABELS, NUMERIC_COMPARISONS, type Comparison, type SuccessRule } from '../../../src/executor/success-condition'
import { newSuccessRule, type SuccessRuleForm } from '../lib/success-rules'

const TARGETS = { status: 'HTTP 响应码', body: '响应正文', json: 'JSON 字段' } as const
const TYPES = { string: '字符串', number: '数字', boolean: '布尔值', null: 'null' } as const
const OPERATORS: Record<SuccessRule['type'], Comparison[]> = {
  status: ['eq', 'ne', 'between', 'gt', 'gte', 'lt', 'lte'],
  body: ['contains', 'not_contains', 'eq', 'ne'],
  json: ['eq', 'ne', 'contains', 'not_contains', 'gt', 'gte', 'lt', 'lte', 'exists', 'not_exists'],
}

export function SuccessConditionEditor({ match, rules, onMatchChange, onRulesChange, error }: {
  match: 'all' | 'any'
  rules: SuccessRuleForm[]
  onMatchChange: (match: 'all' | 'any') => void
  onRulesChange: (update: (rules: SuccessRuleForm[]) => SuccessRuleForm[]) => void
  error?: string
}) {
  useLocale()

  function patch(id: string, update: Partial<SuccessRuleForm> | ((rule: SuccessRuleForm) => Partial<SuccessRuleForm>)) {
    onRulesChange((current) => current.map((rule) => rule.id === id ? { ...rule, ...(typeof update === 'function' ? update(rule) : update) } : rule))
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Select label={tr("条件组合")} value={match} onValueChange={(v) => onMatchChange(v as 'all' | 'any')}
        renderValue={(v) => v === 'all' ? tr("全部满足（AND）") : tr("任一满足（OR）")}
        description={tr("高级模式只按下列条件判断；需要限定 2xx 时，请保留响应码条件。")}>
        <Select.Option value="all">{tr("全部满足（AND）")}</Select.Option>
        <Select.Option value="any">{tr("任一满足（OR）")}</Select.Option>
      </Select>
      {rules.map((rule, index) => {
        const numeric = (NUMERIC_COMPARISONS as readonly string[]).includes(rule.operator)
        const existence = rule.operator === 'exists' || rule.operator === 'not_exists'
        // Reset DOM value tracking when switching between numeric and text inputs.
        const valueKind = rule.type === 'json' ? numeric ? 'number' : rule.valueType : rule.type
        return (
          <fieldset key={rule.id} aria-label={tr("条件 {0}", index + 1)} className="flex min-w-0 flex-col gap-3 rounded-lg border border-kumo-line p-4">
            <div className="flex items-center justify-between gap-2">
              <Text bold>{tr("条件")}{index + 1}</Text>
              <Button type="button" variant="ghost" size="sm" icon={<TrashIcon />} aria-label={tr("删除条件 {0}", index + 1)}
                disabled={rules.length === 1} onClick={() => onRulesChange((current) => current.filter((item) => item.id !== rule.id))}>{tr("删除")}</Button>
            </div>
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <Select label={tr("判断对象")} value={rule.type} renderValue={(v) => tr(TARGETS[v as keyof typeof TARGETS])}
                onValueChange={(v) => patch(rule.id, { ...newSuccessRule(v as SuccessRule['type']), id: rule.id })}>
                {Object.entries(TARGETS).map(([value, label]) => <Select.Option key={value} value={value}>{tr(label)}</Select.Option>)}
              </Select>
              <Select key={rule.type} label={tr("比较方式")} value={rule.operator} renderValue={(v) => tr(COMPARISON_LABELS[v as Comparison])}
                onValueChange={(v) => patch(rule.id, (current) => ({ operator: v as Comparison,
                  ...((NUMERIC_COMPARISONS as readonly string[]).includes(String(v)) ? { valueType: 'number' as const, value: numericInput(current.value) } : {}) }))}>
                {OPERATORS[rule.type].map((operator) => <Select.Option key={operator} value={operator}>{tr(COMPARISON_LABELS[operator])}</Select.Option>)}
              </Select>
            </div>
            {rule.type === 'json' && <Input label={tr("字段路径")} className="font-mono" value={rule.path} placeholder="data.code"
              onChange={(e) => patch(rule.id, { path: e.target.value })} description={tr("例如 data.code、data.items[0].id；$ 表示 JSON 根节点。仅支持点号和数组下标。")} />}
            {!existence && <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              {rule.type === 'json' && !numeric && <Select label={tr("值类型")} value={rule.valueType} renderValue={(v) => tr(TYPES[v as keyof typeof TYPES])}
                onValueChange={(v) => patch(rule.id, (current) => ({ valueType: v as SuccessRuleForm['valueType'],
                  value: v === 'boolean' ? 'true' : v === 'null' ? '' : v === 'number' ? numericInput(current.value) : current.value }))}>
                {Object.entries(TYPES).map(([value, label]) => <Select.Option key={value} value={value}>{tr(label)}</Select.Option>)}
              </Select>}
              {rule.type === 'json' && rule.valueType === 'null' && !numeric ? <Text size="sm" variant="secondary">{tr("比较值为 JSON null。")}</Text>
                : rule.type === 'json' && rule.valueType === 'boolean' && !numeric ? <Select label={tr("比较值")} value={rule.value}
                  onValueChange={(v) => patch(rule.id, { value: String(v) })}>
                  <Select.Option value="true">true</Select.Option><Select.Option value="false">false</Select.Option>
                </Select>
                  : <Input key={valueKind} label={rule.operator === 'between' ? tr("下限") : tr("比较值")} value={rule.value}
                    type={rule.type === 'status' || (rule.type === 'json' && (numeric || rule.valueType === 'number')) ? 'number' : 'text'}
                    step={rule.type === 'status' ? 1 : 'any'} min={rule.type === 'status' ? 100 : undefined} max={rule.type === 'status' ? 599 : undefined}
                    onChange={(e) => patch(rule.id, { value: e.target.value })} />}
              {rule.type === 'status' && rule.operator === 'between' && <Input label={tr("上限")} type="number" min={100} max={599} value={rule.valueTo}
                onChange={(e) => patch(rule.id, { valueTo: e.target.value })} />}
            </div>}
          </fieldset>
        )
      })}
      <div><Button type="button" variant="secondary" icon={<PlusIcon />} disabled={rules.length >= 20}
        onClick={() => onRulesChange((current) => [...current, newSuccessRule()])}>{tr("添加条件")}</Button></div>
      {error && <Text size="sm" variant="error" role="alert">{error}</Text>}
      <Text size="sm" variant="secondary">{tr("数字 0 与字符串 \"0\" 不相等；包含比较区分大小写，可匹配文本或 JSON 数组中的单个值。字段缺失时，仅“不存在”条件成立；null 视为存在。正文与 JSON 条件要求完整响应不超过 1 MiB，超出后该条条件不成立。最多 20 条。")}</Text>
    </div>
  )
}

function numericInput(value: string): string {
  return Number.isFinite(Number(value)) ? value : ''
}
