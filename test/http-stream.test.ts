import { afterEach, expect, it, vi } from 'vitest'
import { httpConfigSchema, httpExecutor, RESPONSE_BODY_LIMIT } from '../src/executor/http'

afterEach(() => vi.restoreAllMocks())

it.each([
  { status: 200, successKeyword: '' },
  { status: 500, successKeyword: 'not needed for a failed HTTP status' },
])('cancels the body after the log prefix for HTTP $status', async ({ status, successKeyword }) => {
  let reads = 0
  const cancel = vi.fn()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new ReadableStream({
    pull(controller) {
      if (++reads > 10) throw new Error('the response keeps streaming')
      controller.enqueue(new TextEncoder().encode('x'.repeat(1024)))
    },
    cancel,
  }, { highWaterMark: 0 }), { status }))
  const result = await httpExecutor.execute(httpConfigSchema.parse({ url: 'https://stream.test', successKeyword }), {})
  expect(result.httpStatus).toBe(status)
  expect(result.error).toBe(status === 200 ? null : 'HTTP 500')
  expect(result.responseBody).toBe('x'.repeat(RESPONSE_BODY_LIMIT) + '…[truncated]')
  expect(reads).toBeLessThanOrEqual(5)
  expect(cancel).toHaveBeenCalledOnce()
})

it('still finds a keyword beyond the stored prefix, split across stream chunks', async () => {
  const bytes = new TextEncoder().encode('x'.repeat(5000) + '成功' + 'y'.repeat(1000))
  let offset = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close()
      const end = Math.min(offset + 37, bytes.length)
      controller.enqueue(bytes.slice(offset, end))
      offset = end
    },
  })))
  const result = await httpExecutor.execute(httpConfigSchema.parse({ url: 'https://stream.test', successKeyword: '成功' }), {})
  expect(result.ok).toBe(true)
  expect(result.responseBody).toBe('x'.repeat(RESPONSE_BODY_LIMIT) + '…[truncated]')
})

it('does not mark an exact 4 KB response as truncated', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('x'.repeat(RESPONSE_BODY_LIMIT)))
  const result = await httpExecutor.execute(httpConfigSchema.parse({ url: 'https://stream.test' }), {})
  expect(result.responseBody).toBe('x'.repeat(RESPONSE_BODY_LIMIT))
})
