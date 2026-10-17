/**
 * The subset of cf-sender's `SenderRpc` entrypoint yunji-task uses. Declared
 * here rather than imported so the two Workers stay independently buildable.
 */
export interface SenderService {
  send(
    input: {
      topic: string
      title: string
      body: string
      format: 'text' | 'markdown'
      level: 'info' | 'warn' | 'error'
      tags?: string[]
    },
    options?: { idempotencyKey?: string },
  ): Promise<{ messageId: string }>
}

/**
 * The only place that reads SENDER, typed loosely so the code compiles with or
 * without the "services" binding in wrangler.jsonc.
 */
export function senderService(env: CloudflareBindings): SenderService | null {
  return (env as { SENDER?: SenderService }).SENDER ?? null
}

export const hasSender = (env: CloudflareBindings) => senderService(env) !== null
