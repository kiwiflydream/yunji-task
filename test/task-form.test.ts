import { describe, expect, it } from 'vitest'
import { taskInputSchema } from '../src/domain/task'
import { emptyTaskForm, formToPayload, mapIssues, taskToForm, type TaskFormState } from '../web/src/lib/task-form'
import { createTaskRow } from './helpers'
import { newSuccessRule } from '../web/src/lib/success-rules'
import type { SuccessCondition, SuccessRule } from '../src/executor/success-condition'

const form = (overrides: Partial<TaskFormState> = {}): TaskFormState => ({
  ...emptyTaskForm,
  name: 'n',
  url: 'https://downstream.test/x',
  ...overrides,
})

function payloadOf(f: TaskFormState) {
  const out = formToPayload(f)
  if (!('payload' in out)) throw new Error(JSON.stringify(out.issues))
  return out.payload
}

describe('task form mapping', () => {
  it('round-trips advanced rules and their JSON scalar types', async () => {
    const successCondition: SuccessCondition = {
      match: 'any' as const,
      rules: [
        { type: 'status', operator: 'between', value: 200, valueTo: 299 },
        ...[0, '0', true, false, null].map((value): SuccessRule => ({ type: 'json', path: 'data.value', operator: 'eq', value })),
        { type: 'json', path: 'data.optional', operator: 'not_exists' },
        { type: 'body', operator: 'not_contains', value: 'error' },
      ],
    }
    const task = await createTaskRow({ executor: { type: 'http', config: { url: 'https://d.test', successCondition } } })
    const editable = taskToForm(task)
    expect(editable.successMode).toBe('advanced')
    const payload = taskInputSchema.parse(payloadOf(editable))
    expect(payload.executor.config.successCondition).toEqual(successCondition)
    expect(payloadOf({ ...editable, successMode: 'simple', successKeyword: 'ok' }).executor.config).toMatchObject({ successKeyword: 'ok' })
    expect(payloadOf({ ...editable, successMode: 'simple' }).executor.config.successCondition).toBeUndefined()
  })

  it('rejects blank numeric comparisons before they can serialize as null', () => {
    const result = formToPayload(form({ successMode: 'advanced', successRules: [{ ...newSuccessRule(), value: '' }] }))
    expect(result).toHaveProperty('issues')
    if ('issues' in result) expect(mapIssues(result.issues).fields.successRules).toContain('第 1 条条件')
    expect(formToPayload(form({ successMode: 'simple', successRules: [{ ...newSuccessRule(), value: '' }] }))).toHaveProperty('payload')
  })

  it('produces a payload the server schema accepts, with unit conversion', () => {
    const p = payloadOf(
      form({
        method: 'POST',
        headers: [
          { key: ' Authorization ', value: 'Bearer {{T}}' },
          { key: '', value: '' },
        ],
        timeoutSeconds: '12.5',
        retryCount: '2',
        retryIntervalSeconds: '30',
        alertMode: 'off',
      }),
    )
    const parsed = taskInputSchema.parse(p)
    expect(parsed.executor.config).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer {{T}}' },
      timeoutMs: 12_500,
    })
    expect(parsed.retry).toEqual({ count: 2, intervalSeconds: 30 })
    expect(parsed.alert).toEqual({ mode: 'off' })
  })

  it('converts once runAt from the chosen timezone', () => {
    const p = payloadOf(form({ scheduleType: 'once', timezone: 'Asia/Shanghai', runAt: '2099-01-02T09:30' }))
    expect(p.schedule).toEqual({ type: 'once', runAt: Date.parse('2099-01-02T01:30:00Z'), timezone: 'Asia/Shanghai' })
  })

  it.each(['2026-11-01T06:30:00Z', '2026-11-01T05:30:00.123Z', '2026-11-01T06:30:00.456Z'])(
    'preserves the exact once epoch when only its description changes: %s',
    async (iso) => {
      const runAt = Date.parse(iso)
      const task = await createTaskRow({ schedule: { type: 'once', runAt, timezone: 'America/New_York' } })
      const editable = taskToForm(task)
      editable.description = 'Only description changed'
      expect(payloadOf(editable).schedule).toEqual({ type: 'once', runAt, timezone: 'America/New_York' })
    },
  )

  it('reinterprets edited once times and timezones, choosing the earlier instant in a fold', async () => {
    const task = await createTaskRow({
      schedule: { type: 'once', runAt: Date.parse('2026-11-01T06:30:00Z'), timezone: 'America/New_York' },
    })
    const editable = taskToForm(task)
    expect(payloadOf({ ...editable, runAt: '2026-11-01T01:45' }).schedule).toMatchObject({ runAt: Date.parse('2026-11-01T05:45:00Z') })
    expect(payloadOf({ ...editable, timezone: 'UTC' }).schedule).toMatchObject({ runAt: Date.parse('2026-11-01T01:30:00Z') })
    expect(payloadOf(form({ scheduleType: 'once', timezone: 'Australia/Lord_Howe', runAt: '2026-04-05T01:45' })).schedule)
      .toMatchObject({ runAt: Date.parse('2026-04-04T14:45:00Z') })
  })

  it.each(['2027-03-14T02:30', '2026-02-30T12:00'])(
    'reports a field error instead of silently normalizing an impossible once time: %s',
    (runAt) => {
      const result = formToPayload(form({ scheduleType: 'once', timezone: 'America/New_York', runAt }))
      expect(result).toHaveProperty('issues')
      if ('issues' in result) expect(mapIssues(result.issues).fields.runAt).toBeTruthy()
    },
  )

  it('reports client-only problems', () => {
    expect(formToPayload(form({ scheduleType: 'once', runAt: '' }))).toEqual({
      issues: [{ path: 'schedule.runAt', message: '请选择执行时间' }],
    })
    expect(formToPayload(form({ headers: [{ key: '', value: 'x' }] }))).toEqual({
      issues: [{ path: 'executor.config.headers', message: '第 1 个请求头缺少名称' }],
    })
  })

  it('leaves empty numeric fields for the server to reject', () => {
    const result = taskInputSchema.safeParse(payloadOf(form({ retryCount: '' })))
    expect(result.success).toBe(false)
    expect(mapIssues(result.error!.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))).fields).toHaveProperty(
      'retryCount',
    )
  })

  it('round-trips a stored task through the form unchanged', async () => {
    const task = await createTaskRow({
      schedule: { type: 'once', runAt: Date.parse('2099-03-04T05:06:07Z'), timezone: 'America/New_York' },
      executor: {
        type: 'http',
        config: { url: 'https://d.test/', method: 'PUT', headers: { A: '1', B: '{{X}}' }, body: 'b', timeoutMs: 7000 },
      },
      overlapPolicy: 'parallel',
      retry: { count: 3, intervalSeconds: 9 },
      alert: { mode: 'custom', url: 'https://a.test', bodyTemplate: 't' },
    })
    const reparsed = taskInputSchema.parse(payloadOf(taskToForm(task)))
    const { id, version, createdAt, updatedAt, ...input } = task
    expect(reparsed).toEqual(input)
  })

  it('maps server issue paths onto fields', () => {
    const { fields, other } = mapIssues([
      { path: 'schedule.cron', message: 'bad cron' },
      { path: 'executor.config.timeoutMs', message: 'too big' },
      { path: 'executor.config.headers.X', message: 'bad header' },
      { path: '', message: 'body must be JSON' },
    ])
    expect(fields).toEqual({ cron: 'bad cron', timeoutSeconds: '超时需在 1–300 秒之间', headers: 'bad header' })
    expect(other).toEqual([{ path: '', message: 'body must be JSON' }])
  })
})
