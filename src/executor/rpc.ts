import { z } from 'zod'
import { renderTemplate } from '../lib/template'
import { truncate } from './http'
import { evaluateSuccessCondition, successConditionSchema } from './success-condition'
import type { ExecutionContext, Executor } from './types'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
const ARGUMENT_LIMIT = 64 * 1024
const RETURN_LIMIT = 1024 * 1024
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const INTERNAL_BINDINGS = new Set(['DB', 'ASSETS', 'TASK_SCHEDULER', 'RUN_QUEUE'])
const RESERVED_METHODS = new Set([
  'constructor', 'prototype', 'dup', 'then', 'catch', 'finally', 'fetch', 'connect', 'scheduled', 'queue', 'alarm',
  'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
  'webSocketMessage', 'webSocketClose', 'webSocketError',
])

/** Bounded JSON encoding: reject unsupported values/cycles before logging or sending. */
export function encodeRpcJson(value: unknown, limit: number): string {
  const chunks: string[] = []
  const seen = new Set<object>()
  let bytes = 0
  const encoder = new TextEncoder()
  function append(text: string) {
    bytes += encoder.encode(text).byteLength
    if (bytes > limit) throw new Error(`RPC JSON exceeds ${limit} bytes`)
    chunks.push(text)
  }
  function visit(item: unknown, depth: number): void {
    if (depth > 32) throw new Error('RPC JSON nesting exceeds 32 levels')
    if (item === null || typeof item === 'boolean' || typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item))) {
      append(JSON.stringify(item))
      return
    }
    if (typeof item !== 'object' || item === null || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) {
      throw new Error('RPC arguments and return values must be JSON-compatible')
    }
    if (seen.has(item)) throw new Error('RPC JSON contains a circular reference')
    seen.add(item)
    if (Array.isArray(item)) {
      append('[')
      for (let i = 0; i < item.length; i++) { if (i) append(','); visit(item[i], depth + 1) }
      append(']')
    } else {
      append('{')
      let first = true
      for (const [key, child] of Object.entries(item)) {
        if (!first) append(',')
        first = false
        append(JSON.stringify(key) + ':')
        visit(child, depth + 1)
      }
      append('}')
    }
    seen.delete(item)
  }
  visit(value, 0)
  return chunks.join('')
}

export const rpcConfigSchema = z.object({
  binding: z.string().trim().regex(IDENTIFIER, '请填写有效的 RPC 服务绑定名称'),
  method: z.string().trim().regex(IDENTIFIER, 'RPC 方法名需以字母开头，只含字母、数字和下划线').refine((name) => !RESERVED_METHODS.has(name), '不能调用 RPC 保留方法'),
  args: z.custom<JsonValue[]>((value) => {
    if (!Array.isArray(value) || value.length > 50) return false
    try { encodeRpcJson(value, ARGUMENT_LIMIT); return true } catch { return false }
  }, 'RPC 参数必须是 JSON 数组，最多 50 项、64 KiB，嵌套不超过 32 层').default([]),
  timeoutMs: z.number().int().min(1000).max(300_000).default(25_000),
  successCondition: successConditionSchema.refine((condition) => condition.rules.every((rule) => rule.type === 'json'), 'RPC 成功条件只支持 JSON 字段').optional(),
})
export type RpcConfig = z.output<typeof rpcConfigSchema>

/** Explicitly exposed service bindings only; never infer capabilities from env. */
export function rpcBindings(env: object): string[] {
  const bindings = env as unknown as Record<string, unknown>
  const configured = typeof bindings.RPC_BINDINGS === 'string' ? bindings.RPC_BINDINGS : ''
  return [...new Set(configured.split(',').map((name) => name.trim()))].filter((name) => {
    if (!IDENTIFIER.test(name) || INTERNAL_BINDINGS.has(name) || RESERVED_METHODS.has(name)) return false
    const target = bindings[name]
    return target !== null && (typeof target === 'object' || typeof target === 'function')
      && typeof (target as { fetch?: unknown }).fetch === 'function'
  })
}

function strings(value: JsonValue): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}
function render(value: JsonValue, variables: Record<string, string>): JsonValue {
  if (typeof value === 'string') return renderTemplate(value, variables)
  if (Array.isArray(value)) return value.map((item) => render(item, variables))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, render(item, variables)]))
  return value
}

export const rpcExecutor: Executor<RpcConfig> = {
  type: 'rpc',
  configSchema: rpcConfigSchema,
  templatedFields: (config) => config.args.flatMap(strings),
  async execute(config, variables, context?: ExecutionContext) {
    const started = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    let pending: unknown
    try {
      if (!context || !rpcBindings(context.env).includes(config.binding)) throw new Error(`RPC binding ${config.binding} is not available (see RPC_BINDINGS and services)`)
      // Validate even when called directly, not just through the task API.
      rpcConfigSchema.parse(config)
      const values = { ...variables, 'task.id': context.run.taskId, 'run.id': context.run.runId, 'run.attempt': String(context.run.attempt) }
      const args = config.args.map((arg) => render(arg, values))
      encodeRpcJson(args, ARGUMENT_LIMIT)
      const service = (context.env as unknown as Record<string, Record<string, (...args: JsonValue[]) => unknown>>)[config.binding]
      const method = service[config.method]
      if (typeof method !== 'function') throw new Error(`RPC method ${config.method} is not callable`)
      pending = Reflect.apply(method, service, args)
      const value = await Promise.race([
        Promise.resolve(pending),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`RPC timeout after ${config.timeoutMs}ms; target may still be running`)), config.timeoutMs) }),
      ])
      const body = value === undefined ? null : encodeRpcJson(value, RETURN_LIMIT)
      const error = config.successCondition ? evaluateSuccessCondition(config.successCondition, 0, body ?? '') : null
      return { ok: error === null, httpStatus: null, responseBody: body === null ? null : truncate(body, undefined, Object.values(variables)), error, durationMs: Date.now() - started }
    } catch (err) {
      return { ok: false, httpStatus: null, responseBody: null, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - started }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      // Disposes the RPC session/result stubs, including when the local deadline expires.
      try {
        const dispose = (Symbol as unknown as { dispose?: symbol }).dispose
        if (dispose && pending != null) (pending as Record<symbol, (() => void) | undefined>)[dispose]?.()
      } catch { /* Preserve the execution outcome. */ }
    }
  },
}
