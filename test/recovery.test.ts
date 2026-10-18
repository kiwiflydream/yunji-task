import { env } from 'cloudflare:workers'
import { runDurableObjectAlarm } from 'cloudflare:test'
import { afterEach, expect, it, vi } from 'vitest'
import { getRun, markLostRuns, purgeOldRuns, type RunMessage } from '../src/domain/runs-repo'
import { actionsForRun, claimAction, dueActions } from '../src/domain/actions-repo'
import { deliverAction } from '../src/executor/actions'
import { getAlertSettingsState, putAlertSettings } from '../src/domain/settings'
import { runMaintenance } from '../src/maintenance/maintenance'
import { processRun, queueTransport } from '../src/executor/consumer'
import { createTaskRow, setRuntimeSettings } from './helpers'

afterEach(() => vi.restoreAllMocks())

it('recovers a failed retry handoff on redelivery without repeating the HTTP call', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('failed', { status: 500 }))
  const task = await createTaskRow({ retry: { count: 1, intervalSeconds: 60 }, alert: { mode: 'off' } })
  const msg: RunMessage = { runId: crypto.randomUUID(), taskId: task.id, trigger: 'manual', scheduledAt: Date.now(), attempt: 1 }
  const retry = vi.fn().mockRejectedValueOnce(new Error('retry transport unavailable')).mockResolvedValue(undefined)
  const transport = { ...queueTransport(env), retry }
  await expect(processRun(msg, env, transport)).rejects.toThrow('retry transport unavailable')
  await processRun(msg, env, transport)
  expect(retry).toHaveBeenCalledTimes(2)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(await getRun(env.DB, msg.runId)).toMatchObject({ status: 'retrying', attempt: 1 })
})

it('recovers from durable storage, preserves queue mode and the original retry deadline', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('failed', { status: 500 }))
  const task = await createTaskRow({ retry: { count: 1, intervalSeconds: 60 }, alert: { mode: 'off' } })
  const msg: RunMessage = { runId: crypto.randomUUID(), taskId: task.id, trigger: 'manual', scheduledAt: Date.now(), attempt: 1 }
  const at = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(at)
  await expect(processRun(msg, env, { ...queueTransport(env), retry: async () => { throw new Error('offline') } })).rejects.toThrow('offline')
  await setRuntimeSettings({ executionMode: 'worker' })
  const send = vi.fn().mockResolvedValue(undefined)
  const recoveredEnv = Object.create(env, { RUN_QUEUE: { value: { send } } }) as CloudflareBindings
  vi.mocked(Date.now).mockReturnValue(at + 20_000)
  await deliverAction(`${msg.runId}:retry:2`, recoveredEnv)
  expect(send).toHaveBeenCalledExactlyOnceWith({ ...msg, attempt: 2 }, { delaySeconds: 40 })
  expect(await actionsForRun(env.DB, msg.runId)).toEqual([])
})

it('keeps undelivered retries alive through lost-run and retention cleanup', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('failed', { status: 500 }))
  const task = await createTaskRow({ retry: { count: 1, intervalSeconds: 1 }, alert: { mode: 'off' } })
  const msg: RunMessage = { runId: crypto.randomUUID(), taskId: task.id, trigger: 'manual', scheduledAt: Date.now(), attempt: 1 }
  await expect(processRun(msg, env, { ...queueTransport(env), retry: async () => { throw new Error('offline') } })).rejects.toThrow('offline')
  await markLostRuns(env.DB, Date.now() + 40 * 86_400_000)
  await purgeOldRuns(env.DB, [task.id], Date.now() + 40 * 86_400_000)
  expect((await getRun(env.DB, msg.runId))?.status).toBe('retrying')
  expect(await dueActions(env.DB, Date.now())).toEqual(expect.arrayContaining([expect.objectContaining({ runId: msg.runId })]))
})

it('stores failure before sending an alert and retries the webhook independently, at most three completed attempts', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('failed', { status: 500 }))
  const task = await createTaskRow({ alert: { mode: 'custom', url: 'https://alerts.test/hook' } })
  const msg: RunMessage = { runId: crypto.randomUUID(), taskId: task.id, trigger: 'manual', scheduledAt: Date.now(), attempt: 1 }
  await processRun(msg, env)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect((await getRun(env.DB, msg.runId))?.status).toBe('failed')
  const id = `${msg.runId}:alert`
  const at = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(at)
  for (let attempt = 1; attempt <= 3; attempt++) {
    await deliverAction(id, env)
    vi.mocked(Date.now).mockReturnValue(at + 30_000 * attempt * (attempt + 1) / 2)
  }
  await deliverAction(id, env)
  expect(fetch).toHaveBeenCalledTimes(4)
  const action = await env.DB.prepare('SELECT attempts, failed_at, last_error FROM run_actions WHERE id = ?').bind(id).first()
  expect(action).toMatchObject({ attempts: 3, last_error: 'alert webhook returned HTTP 500' })
  expect(action?.failed_at).not.toBeNull()
  expect((await getRun(env.DB, msg.runId))?.status).toBe('failed')
})

it('reclaims an action after an interrupted delivery lease, without concurrent duplicate sends', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('failed', { status: 500 }))
  const task = await createTaskRow({ alert: { mode: 'custom', url: 'https://alerts.test/hook' } })
  const msg: RunMessage = { runId: crypto.randomUUID(), taskId: task.id, trigger: 'manual', scheduledAt: Date.now(), attempt: 1 }
  await processRun(msg, env)
  const at = Date.now()
  const id = `${msg.runId}:alert`
  expect(await claimAction(env.DB, id, at)).not.toBeNull()
  expect(await claimAction(env.DB, id, at + 44_000)).toBeNull()
  expect(await claimAction(env.DB, id, at + 46_000)).toMatchObject({ attempts: 2 })
})

it.each(['worker', 'direct'] as const)('restores a %s retry to its original transport after a global change', async (mode) => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('failed', { status: 500 }))
  const task = await createTaskRow({ retry: { count: 1, intervalSeconds: 1 }, alert: { mode: 'off' } })
  const msg: RunMessage = { runId: crypto.randomUUID(), taskId: task.id, trigger: 'manual', scheduledAt: Date.now(), attempt: 1 }
  await expect(processRun(msg, env, { ...queueTransport(env), mode, retry: async () => { throw new Error('offline') } })).rejects.toThrow('offline')
  await setRuntimeSettings({ executionMode: 'queue' })
  const schedule = vi.fn().mockResolvedValue(undefined)
  const recoveredEnv = Object.create(env, { TASK_SCHEDULER: { value: { getByName: () => ({ schedule }) } } }) as CloudflareBindings
  await deliverAction(`${msg.runId}:retry:2`, recoveredEnv)
  expect(schedule).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ msg: { ...msg, attempt: 2 }, mode }))
  expect(fetch).toHaveBeenCalledOnce()
})

it('maintenance recovers a lost alert wake and preserves the failure-time target', async () => {
  await putAlertSettings(env.DB, { mode: 'webhook', url: 'https://alerts.test/original', bodyTemplate: '', senderChannelGroup: '' }, Date.now(), (await getAlertSettingsState(env.DB)).version)
  const calls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    calls.push(url)
    return new Response('', { status: url.includes('alerts.test') ? 200 : 500 })
  })
  const task = await createTaskRow({ schedule: { type: 'manual' } })
  const msg: RunMessage = { runId: crypto.randomUUID(), taskId: task.id, trigger: 'manual', scheduledAt: Date.now(), attempt: 1 }
  const broken = Object.create(env, { TASK_SCHEDULER: { value: { getByName: () => ({ scheduleAction: async () => { throw new Error('wake unavailable') } }) } } }) as CloudflareBindings
  await expect(processRun(msg, broken)).rejects.toThrow('wake unavailable')
  expect((await getRun(env.DB, msg.runId))?.status).toBe('failed')
  await putAlertSettings(env.DB, { mode: 'webhook', url: 'https://alerts.test/changed', bodyTemplate: '', senderChannelGroup: '' }, Date.now(), (await getAlertSettingsState(env.DB)).version)
  await runMaintenance(env)
  await runDurableObjectAlarm(env.TASK_SCHEDULER.getByName(task.id))
  await vi.waitFor(() => expect(calls).toContain('https://alerts.test/original'))
  expect(calls).not.toContain('https://alerts.test/changed')
  await vi.waitFor(async () => expect(await actionsForRun(env.DB, msg.runId)).toEqual([]))
})
