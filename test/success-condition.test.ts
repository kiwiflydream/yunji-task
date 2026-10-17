import { afterEach, describe, expect, it, vi } from 'vitest'
import { httpConfigSchema, httpExecutor, RESPONSE_BODY_LIMIT } from '../src/executor/http'
import { evaluateSuccessCondition, successConditionSchema, type SuccessRule } from '../src/executor/success-condition'

afterEach(() => vi.restoreAllMocks())

function evaluate(rules: SuccessRule[], body: string, match: 'all' | 'any' = 'all', status = 200) {
  return evaluateSuccessCondition({ match, rules }, status, body)
}
const code: SuccessRule = { type: 'json', path: 'data.code', operator: 'eq', value: 0 }
const status: SuccessRule = { type: 'status', operator: 'between', value: 200, valueTo: 299 }

describe('advanced success conditions', () => {
  it('uses explicit AND/OR semantics, including non-2xx success', () => {
    expect(evaluate([status, code], '{"data":{"code":0}}')).toBeNull()
    expect(evaluate([status, code], '{"data":{"code":1}}')).toContain('第 2 条')
    expect(evaluate([status, code], '{"data":{"code":0}}', 'all', 503)).toContain('HTTP 503')
    expect(evaluate([status, code], '{"data":{"code":0}}', 'any', 503)).toBeNull()
    expect(evaluate([{ type: 'status', operator: 'eq', value: 404 }], '', 'all', 404)).toBeNull()
    expect(evaluate([status, code], 'not JSON', 'any')).toBeNull()
    expect(evaluate([code], 'not JSON')).toContain('不是有效 JSON')
  })

  it.each([
    ['0', 0, true], ['"0"', 0, false], ['"0"', '0', true], ['false', false, true], ['null', null, true], ['0', false, false],
  ])('keeps scalar types distinct: actual %s, expected %s', (body, value, ok) => {
    expect(evaluate([{ type: 'json', path: '$', operator: 'eq', value }], body) === null).toBe(ok)
  })

  it('distinguishes missing, null, falsy fields and inherited properties', () => {
    for (const operator of ['eq', 'ne', 'contains', 'not_contains', 'gt', 'exists'] as const) {
      expect(evaluate([{ type: 'json', path: 'missing', operator, value: 0 }], '{}')).toContain('不存在')
    }
    expect(evaluate([{ type: 'json', path: 'value', operator: 'exists' }], '{"value":null}')).toBeNull()
    expect(evaluate([{ type: 'json', path: 'value', operator: 'not_exists' }], '{"value":null}')).not.toBeNull()
    expect(evaluate([{ type: 'json', path: 'value', operator: 'not_exists' }], '{}')).toBeNull()
    expect(evaluate([{ type: 'json', path: 'constructor.name', operator: 'exists' }], '{}')).not.toBeNull()
    expect(evaluate([{ type: 'json', path: 'value.child', operator: 'exists' }], '{"value":null}')).not.toBeNull()
    expect(evaluate([{ type: 'json', path: 'value.length', operator: 'exists' }], '{"value":"text"}')).not.toBeNull()
  })

  it('supports nested array paths, root arrays and Unicode fields', () => {
    const body = '{"数据":{"items":[{"id":"ok"}]}}'
    expect(evaluate([{ type: 'json', path: '$.数据.items[0].id', operator: 'eq', value: 'ok' }], body)).toBeNull()
    expect(evaluate([{ type: 'json', path: '$[0].id', operator: 'eq', value: 1 }], '[{"id":1}]')).toBeNull()
    expect(evaluate([{ type: 'json', path: '数据.items[1].id', operator: 'exists' }], body)).not.toBeNull()
  })

  it.each([
    ['gt', 10, 9, true], ['gte', 10, 10, true], ['lt', 10, 11, true], ['lte', 10, 10, true],
    ['gt', '10', 9, false], ['contains', 'hello world', 'world', true], ['not_contains', 'hello', 'X', true],
    ['contains', [0, 1], 0, true], ['contains', [0, 1], '0', false], ['not_contains', 0, 1, false],
    ['not_contains', { value: 1 }, 'secret', false], ['contains', 'Done', 'done', false],
  ] as const)('compares %s without coercion', (operator, actual, value, ok) => {
    expect(evaluate([{ type: 'json', path: '$', operator, value }], JSON.stringify(actual)) === null).toBe(ok)
  })

  it('rejects invalid rules before execution', () => {
    const invalid = [
      [], Array(21).fill(status), [{ ...status, valueTo: 199 }], [{ ...status, valueTo: undefined }],
      [{ ...status, value: 99 }], [{ ...status, value: 200.5 }], [{ ...code, path: 'data..code' }],
      [{ ...code, path: 'data[?(@.id)]' }], [{ ...code, value: undefined }], [{ ...code, operator: 'gt', value: '1' }],
      [{ type: 'body', operator: 'contains', value: '' }], [{ ...code, value: Number.NaN }], [{ ...code, value: Infinity }],
    ]
    for (const rules of invalid) expect(successConditionSchema.safeParse({ match: 'all', rules }).success).toBe(false)
    expect(successConditionSchema.safeParse({ match: 'any', rules: [{ type: 'json', path: '$', operator: 'not_exists' }] }).success).toBe(true)
  })
})

describe('HTTP executor advanced conditions', () => {
  const run = (rules: SuccessRule[], match: 'all' | 'any' = 'all') => httpExecutor.execute(httpConfigSchema.parse({
    url: 'https://response.test', successKeyword: 'ignored-in-advanced-mode', successCondition: { match, rules },
  }), {})

  it('overrides both the default status check and the basic keyword check', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"data":{"code":0}}', { status: 409 }))
    expect(await run([{ type: 'status', operator: 'eq', value: 409 }, code])).toMatchObject({ ok: true, httpStatus: 409 })
  })

  it('checks JSON beyond the log prefix but still truncates stored logs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ padding: 'x'.repeat(6000), data: { code: 0 } })))
    const result = await run([code])
    expect(result.ok).toBe(true)
    expect(result.responseBody).toMatch(/…\[truncated\]$/)
    expect(new TextEncoder().encode(result.responseBody!).length).toBeLessThan(RESPONSE_BODY_LIMIT + 30)
  })

  it('accepts an exact 1 MiB response, but never trusts truncated JSON or negative text matches', async () => {
    const limit = 1024 * 1024
    const fixture = (padding: number) => JSON.stringify({ padding: 'x'.repeat(padding), data: { code: 0 } })
    const exact = fixture(limit - fixture(0).length)
    expect(exact.length).toBe(limit)
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(exact))
    expect((await run([code])).ok).toBe(true)
    mock.mockResolvedValue(new Response(exact + ' '))
    expect(await run([code])).toMatchObject({ ok: false, error: expect.stringContaining('超过 1 MiB') })
    mock.mockResolvedValue(new Response('x'.repeat(limit) + 'forbidden'))
    expect(await run([{ type: 'body', operator: 'not_contains', value: 'forbidden' }])).toMatchObject({ ok: false, error: expect.stringContaining('超过 1 MiB') })
  })

  it('cancels unbounded bodies; status-only conditions retain the small read limit', async () => {
    for (const rules of [[status], [{ type: 'body', operator: 'contains', value: 'x' }] as SuccessRule[]]) {
      let reads = 0
      const cancel = vi.fn()
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new ReadableStream({
        pull(controller) { reads++; controller.enqueue(new Uint8Array(1024)) }, cancel,
      }, { highWaterMark: 0 })))
      const result = await run(rules)
      expect(reads).toBeLessThanOrEqual(rules[0].type === 'status' ? 5 : 1025)
      expect(cancel).toHaveBeenCalledOnce()
      expect(result.ok).toBe(rules[0].type === 'status')
    }
  })

  it('handles empty 204 responses and body stream failures', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    expect((await run([{ type: 'body', operator: 'eq', value: '' }])).ok).toBe(true)
    mock.mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.error(new Error('stream failed')) } })))
    expect(await run([status])).toMatchObject({ ok: false, error: expect.stringContaining('failed to read response') })
  })
})
