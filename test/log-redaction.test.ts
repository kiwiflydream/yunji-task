import { afterEach, expect, it, vi } from 'vitest'
import { httpConfigSchema, httpExecutor, RESPONSE_BODY_LIMIT } from '../src/executor/http'

afterEach(() => vi.restoreAllMocks())

it.each([false, true])('redacts a partial variable after decoding a BOM at the byte limit (JSON escaped: %s)', async (escaped) => {
  const secret = 'fake-bom-"quoted"-private-credential-0123456789'
  const echo = escaped ? JSON.stringify(secret).slice(1, -1) : secret
  const prefix = 'x'.repeat(RESPONSE_BODY_LIMIT + 1 - 3 - 20)
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('\uFEFF' + prefix + echo + 'tail'))
  const result = await httpExecutor.execute(httpConfigSchema.parse({ url: 'https://echo.test' }), { TOKEN: secret })
  expect(result.responseBody).toBe(prefix + '***…[truncated]')
  expect(result.responseBody).not.toContain(echo.slice(0, 20))
})

it.each([false, true])('redacts a variable crossing the log boundary (JSON escaped: %s)', async (escaped) => {
  const secret = 'fake-private-"quoted"-credential-0123456789'
  const echo = escaped ? JSON.stringify(secret).slice(1, -1) : secret
  const prefix = 'x'.repeat(RESPONSE_BODY_LIMIT - 20)
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(prefix + echo + 'tail'))
  const result = await httpExecutor.execute(httpConfigSchema.parse({ url: 'https://echo.test', headers: { authorization: '{{TOKEN}}' } }), { TOKEN: secret })
  expect(result.ok).toBe(true)
  expect(result.responseBody).toBe(prefix + '***…[truncated]')
  expect(result.responseBody).not.toContain(echo.slice(0, 20))
})

it('keeps success evaluation on the original body while hiding a complete variable in logs', async () => {
  const secret = 'fake-complete-credential'
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`body: ${secret}`))
  const result = await httpExecutor.execute(httpConfigSchema.parse({ url: 'https://echo.test', successKeyword: secret }), { TOKEN: secret })
  expect(result.ok).toBe(true)
  expect(result.responseBody).toBe('body: ***')
})

it('does not leak a partial multibyte variable at a truncated boundary', async () => {
  const secret = '秘密凭据-测试-only'
  const prefix = 'x'.repeat(RESPONSE_BODY_LIMIT - 7)
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(prefix + secret))
  const result = await httpExecutor.execute(httpConfigSchema.parse({ url: 'https://echo.test' }), { TOKEN: secret })
  expect(result.responseBody).toBe(prefix + '***…[truncated]')
})
