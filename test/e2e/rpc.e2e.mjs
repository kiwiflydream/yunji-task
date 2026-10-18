import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'

async function fixture(page, bindings = ['WEBSITE']) {
  const now = Date.now()
  const task = {
    id: randomUUID(), name: 'RPC cleanup', description: '', enabled: true,
    schedule: { type: 'manual', timezone: 'Asia/Shanghai' },
    executor: { type: 'rpc', config: { binding: 'WEBSITE', method: 'cleanupExpiredSessions', args: [{ batchSize: 100 }], timeoutMs: 25000 } },
    overlapPolicy: 'skip', retry: { count: 0, intervalSeconds: 10 }, alert: { mode: 'off' },
    executionMode: 'inherit', version: 1, createdAt: now, updatedAt: now, nextRunAt: null,
  }
  const summary = { total: 0, success: 0, failed: 0, skipped: 0, successRate: null, durationAvg: null, durationP50: null, durationP95: null, durationMax: null, delayAvg: null, delayMax: null }
  const state = { task, writes: [], errors: [] }
  page.on('pageerror', (error) => state.errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') state.errors.push(message.text()) })
  await page.route('**/admin/api/**', async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname.slice('/admin/api'.length)
    if (path === '/me') return route.fulfill({ json: { user: 'admin', authMode: 'basic', executionMode: 'worker', retentionDays: 30, statsRetentionDays: 90, queueAvailable: true, senderAvailable: false, rpcBindings: bindings } })
    if (path === '/tasks' && req.method() === 'POST' || path === `/tasks/${task.id}` && req.method() === 'PUT') {
      const body = req.postDataJSON()
      state.writes.push(body)
      Object.assign(task, body)
      return route.fulfill({ json: { task } })
    }
    if (path === '/tasks') return route.fulfill({ json: { tasks: [task] } })
    if (path === `/tasks/${task.id}`) return route.fulfill({ json: { task } })
    if (path.endsWith('/scheduler')) return route.fulfill({ json: { scheduler: { version: 1, alarmAt: null, running: null } } })
    if (path.endsWith('/runs')) return route.fulfill({ json: { runs: [], nextBefore: null } })
    if (path.endsWith('/stats')) return route.fulfill({ json: { range: '7d', granularity: 'hour', from: now - 86400000, to: now, summary, series: [], histogram: [] } })
    throw new Error(`Unexpected RPC fixture request: ${req.method()} ${path}`)
  })
  return state
}
function labels(info) {
  return info.project.name === 'mobile-zh' ? {
    rpc: 'RPC 调用', binding: '服务绑定', method: 'RPC 方法', args: '参数（JSON 数组）', name: '名称', save: '保存', create: '创建任务', simple: '简单模式', advanced: '高级模式', target: '判断对象', json: 'JSON 字段', noServices: '当前没有可用的 RPC 服务。',
  } : { rpc: 'RPC call', binding: 'Service binding', method: 'RPC method', args: 'Arguments (JSON array)', name: 'Name', save: 'Save', create: 'Create task', simple: 'Simple', advanced: 'Advanced', target: 'Target', json: 'JSON field', noServices: 'No RPC services are available.' }
}

test('creates an RPC task and preserves arguments when editing', async ({ page }, info) => {
  const state = await fixture(page)
  const t = labels(info)
  await page.goto('/admin/tasks/new')
  await page.getByRole('textbox', { name: t.name, exact: true }).fill('RPC cleanup')
  await page.getByRole('radio', { name: t.rpc, exact: true }).check()
  await page.getByRole('combobox', { name: t.binding, exact: true }).click()
  await page.getByRole('option', { name: 'WEBSITE', exact: true }).click()
  await page.getByRole('textbox', { name: t.method, exact: true }).fill('cleanupExpiredSessions')
  const args = [{ batchSize: 100, key: '{{run.id}}' }, false, 0]
  await page.getByRole('textbox', { name: t.args, exact: true }).fill(JSON.stringify(args))
  await page.getByRole('radio', { name: t.rpc, exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(tmpdir(), `yunji-task-rpc-${info.project.name}.png`), fullPage: true })
  await page.getByRole('button', { name: t.create, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/tasks/${state.task.id}$`))
  expect(state.writes[0].executor).toEqual({ type: 'rpc', config: { binding: 'WEBSITE', method: 'cleanupExpiredSessions', args, timeoutMs: 25000 } })
  await expect(page.getByText('cleanupExpiredSessions', { exact: true })).toBeVisible()
  await page.goto(`/admin/tasks/${state.task.id}/edit`)
  await expect(page.getByRole('textbox', { name: t.args, exact: true })).toHaveValue(JSON.stringify(args, null, 2))
  await page.getByRole('textbox', { name: t.name, exact: true }).fill('Renamed RPC cleanup')
  await page.getByRole('button', { name: t.save, exact: true }).click()
  await expect.poll(() => state.writes.length).toBe(2)
  expect(state.writes[1].executor).toEqual(state.writes[0].executor)
  expect(state.errors).toEqual([])
})

test('rejects invalid JSON before submitting and limits advanced conditions to JSON', async ({ page }, info) => {
  const state = await fixture(page)
  const t = labels(info)
  await page.goto(`/admin/tasks/${state.task.id}/edit`)
  await page.getByRole('textbox', { name: t.args, exact: true }).fill('{')
  await page.getByRole('button', { name: t.save, exact: true }).click()
  await expect(page.getByText(info.project.name === 'mobile-zh' ? 'RPC 参数必须是有效的 JSON 数组' : 'RPC arguments must be a valid JSON array', { exact: true })).toBeVisible()
  expect(state.writes).toHaveLength(0)
  await page.getByRole('radio', { name: t.advanced, exact: true }).check()
  await page.getByRole('combobox', { name: t.target, exact: true }).click()
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(1)
  await expect(page.getByRole('option', { name: t.json, exact: true })).toBeVisible()
  expect(state.errors).toEqual([])
})

test('explains missing service configuration without breaking the editor', async ({ page }, info) => {
  const state = await fixture(page, [])
  const t = labels(info)
  await page.goto('/admin/tasks/new')
  await page.getByRole('radio', { name: t.rpc, exact: true }).check()
  await expect(page.getByText(new RegExp(t.noServices))).toBeVisible()
  await expect(page.getByRole('textbox', { name: t.args, exact: true })).toBeVisible()
  expect(state.errors).toEqual([])
})
