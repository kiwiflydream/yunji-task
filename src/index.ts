import { app } from './app'
import type { RunMessage } from './domain/runs-repo'
import { handleRunBatch } from './executor/consumer'
import { runMaintenance } from './maintenance/maintenance'

export { RunExecutor } from './executor/run-executor'
export { ActionExecutor } from './executor/actions'
export { TaskScheduler } from './scheduler/task-scheduler'

export default {
  fetch: app.fetch,
  queue: (batch, env) => handleRunBatch(batch, env),
  scheduled: (_controller, env, ctx) => ctx.waitUntil(runMaintenance(env)),
} satisfies ExportedHandler<CloudflareBindings, RunMessage>
