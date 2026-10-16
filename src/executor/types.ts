import type { z } from 'zod'

export interface ExecutionResult {
  ok: boolean
  httpStatus: number | null
  /** Already truncated for storage. */
  responseBody: string | null
  error: string | null
  durationMs: number
}

export interface Executor<Config> {
  type: string
  configSchema: z.ZodType<Config>
  /** Strings that may contain `{{VAR}}` references, used to load only the needed variables. */
  templatedFields(config: Config): string[]
  execute(config: Config, variables: Record<string, string>): Promise<ExecutionResult>
}
