import { z } from 'zod'
import { renderTemplate } from '../lib/template'
import type { ExecutionResult, Executor } from './types'
import { evaluateSuccessCondition, successConditionSchema } from './success-condition'

export const RESPONSE_BODY_LIMIT = 4 * 1024
const KEYWORD_SCAN_LIMIT = 1024 * 1024

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const

export const httpConfigSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine((u) => /^(https?:\/\/|\{\{)/i.test(u), 'URL 必须以 http:// 或 https://（或 {{变量}}）开头'),
  method: z.enum(HTTP_METHODS).default('GET'),
  headers: z.record(z.string().trim().min(1), z.string()).default({}),
  body: z.string().max(64 * 1024).default(''),
  // Default fits worker mode (WORKER_MAX_TIMEOUT_MS).
  timeoutMs: z.number().int().min(1000).max(300_000).default(25_000),
  successKeyword: z.string().max(200).default(''),
  successCondition: successConditionSchema.optional(),
})

export type HttpConfig = z.output<typeof httpConfigSchema>

/** Read at most `limit` bytes of the body as text, then cancel the rest. */
async function readLimited(res: Response, limit: number): Promise<{ text: string; bytes: number }> {
  if (!res.body) return { text: '', bytes: 0 }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < limit) {
    const { done, value } = await reader.read()
    if (done) break
    const part = value.subarray(0, limit - size)
    chunks.push(part)
    size += part.byteLength
  }
  if (size >= limit) await reader.cancel().catch(() => {})
  const buf = new Uint8Array(Math.min(size, limit))
  let offset = 0
  for (const c of chunks) {
    const part = c.subarray(0, buf.length - offset)
    buf.set(part, offset)
    offset += part.length
    if (offset >= buf.length) break
  }
  return { text: new TextDecoder().decode(buf), bytes: buf.length }
}

export function truncate(text: string, limit = RESPONSE_BODY_LIMIT): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= limit) return text
  // Drop a possibly split trailing multi-byte character.
  return new TextDecoder().decode(bytes.subarray(0, limit)).replace(/�$/, '') + '…[truncated]'
}

export const httpExecutor: Executor<HttpConfig> = {
  type: 'http',
  configSchema: httpConfigSchema,

  templatedFields(config) {
    return [config.url, config.body, ...Object.values(config.headers)]
  },

  async execute(config, variables): Promise<ExecutionResult> {
    const started = Date.now()
    let res: Response
    try {
      const url = renderTemplate(config.url, variables)
      const headers = new Headers()
      for (const [k, v] of Object.entries(config.headers)) headers.set(k, renderTemplate(v, variables))
      const hasBody = config.method !== 'GET' && config.method !== 'HEAD' && config.body !== ''
      res = await fetch(url, {
        method: config.method,
        headers,
        body: hasBody ? renderTemplate(config.body, variables) : undefined,
        signal: AbortSignal.timeout(config.timeoutMs),
      })
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === 'TimeoutError'
      return {
        ok: false,
        httpStatus: null,
        responseBody: null,
        error: timedOut ? `timeout after ${config.timeoutMs}ms` : errorMessage(err),
        durationMs: Date.now() - started,
      }
    }

    let text: string
    let bodyTooLarge = false
    try {
      // One extra byte distinguishes an exact 4 KB response from a truncated one.
      const inspectBody = config.successCondition?.rules.some((rule) => rule.type !== 'status')
      const limit = inspectBody ? KEYWORD_SCAN_LIMIT + 1 : !config.successCondition && res.ok && config.successKeyword ? KEYWORD_SCAN_LIMIT : RESPONSE_BODY_LIMIT + 1
      const response = await readLimited(res, limit)
      text = response.text
      bodyTooLarge = response.bytes > KEYWORD_SCAN_LIMIT
    } catch (err) {
      return {
        ok: false,
        httpStatus: res.status,
        responseBody: null,
        error: `failed to read response: ${errorMessage(err)}`,
        durationMs: Date.now() - started,
      }
    }

    let error: string | null = null
    if (config.successCondition) error = evaluateSuccessCondition(config.successCondition, res.status, text, bodyTooLarge)
    else if (!res.ok) error = `HTTP ${res.status}`
    else if (config.successKeyword && !text.includes(config.successKeyword)) {
      error = `response does not contain success keyword "${config.successKeyword}"`
    }
    return {
      ok: error === null,
      httpStatus: res.status,
      responseBody: truncate(text),
      error,
      durationMs: Date.now() - started,
    }
  },
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
