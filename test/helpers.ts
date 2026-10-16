import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import type { RunMessage } from '../src/domain/runs-repo'
import { taskInputSchema, toSnapshot, type ScheduleSnapshot, type TaskInputRaw } from '../src/domain/task'
import { insertTask } from '../src/domain/tasks-repo'
import type { TaskScheduler } from '../src/scheduler/task-scheduler'

export function taskInput(overrides: Partial<TaskInputRaw> = {}) {
  return taskInputSchema.parse({
    name: 'demo',
    schedule: { type: 'cron', cron: '*/10 * * * * *' },
    executor: { type: 'http', config: { url: 'https://downstream.test/hook' } },
    ...overrides,
  })
}

export async function createTaskRow(overrides: Partial<TaskInputRaw> = {}) {
  return insertTask(env.DB, taskInput(overrides), Date.now())
}

export function snapshotFor(overrides: Partial<ScheduleSnapshot> = {}): ScheduleSnapshot {
  return {
    taskId: crypto.randomUUID(),
    version: 1,
    enabled: true,
    scheduleType: 'cron',
    cron: '*/10 * * * * *',
    timezone: 'UTC',
    runAt: null,
    overlapPolicy: 'skip',
    leaseMs: 60_000,
    executionMode: 'inherit',
    timeoutMs: 30_000,
    ...overrides,
  }
}

export { toSnapshot }

/** Replace the DO's queue binding with an in-memory recorder. */
export async function captureQueue(stub: DurableObjectStub<TaskScheduler>): Promise<RunMessage[]> {
  const sent: RunMessage[] = []
  await runInDurableObject(stub, (instance: TaskScheduler) => {
    const real = (instance as unknown as { env: CloudflareBindings }).env
    const fake = Object.create(real, {
      RUN_QUEUE: { value: { send: async (m: RunMessage) => void sent.push(m) } },
    })
    Object.defineProperty(instance, 'env', { value: fake })
  })
  return sent
}
