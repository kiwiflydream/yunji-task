import { z } from 'zod'
import { httpConfigSchema, httpExecutor } from './http'
import type { Executor } from './types'

// To add an executor: implement Executor, register it here and add its
// variant to executorSpecSchema.
const executors: Record<string, Executor<any>> = {
  [httpExecutor.type]: httpExecutor,
}

export const executorSpecSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('http'), config: httpConfigSchema }),
])

export type ExecutorSpec = z.output<typeof executorSpecSchema>

export function getExecutor(type: string): Executor<unknown> {
  const executor = executors[type]
  if (!executor) throw new Error(`unknown executor type: ${type}`)
  return executor
}
