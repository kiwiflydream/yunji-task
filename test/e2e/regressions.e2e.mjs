import { randomUUID } from 'node:crypto'
import { test, expect } from '@playwright/test'

async function mockApi(page) {
  const now = Date.now()
  const task = {
    id: randomUUID(), name: 'Regression task', description: '', enabled: true,
    schedule: { type: 'manual', timezone: 'Asia/Shanghai' },
    executor: { type: 'http', config: { url: 'https://example.com/job', method: 'GET', headers: {}, body: '', timeoutMs: 25000, successKeyword: '' } },
    overlapPolicy: 'skip', retry: { count: 0, intervalSeconds: 10 }, alert: { mode: 'off' },
    executionMode: 'worker', version: 1, createdAt: now, updatedAt: now, nextRunAt: null,
  }
  const run = {
    id: randomUUID(), taskId: task.id, trigger: 'manual', status: 'success', attempt: 1,
    executionMode: 'worker', effectiveTimeoutMs: 25000, scheduledAt: now, startedAt: now,
    finishedAt: now + 10, durationMs: 10, httpStatus: 200, responseBody: '{"code":0}', error: null,
    createdAt: now, updatedAt: now + 10,
  }
  const summary = {
    total: 0, success: 0, failed: 0, skipped: 0, successRate: null,
    durationAvg: null, durationP50: null, durationP95: null, durationMax: null, delayAvg: null, delayMax: null,
  }
  const state = { task, run, runs: [run], deleted: false, deleteCalls: 0, detailReads: 0 }
  await page.route('**/admin/api/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname.slice('/admin/api'.length)
    if (path === '/me') return route.fulfill({ json: { user: 'admin', authMode: 'basic', executionMode: 'worker', retentionDays: 30, statsRetentionDays: 90, runtimeSettingsVersion: 1, queueAvailable: true, senderAvailable: false } })
    if (path === '/tasks') return route.fulfill({ json: { tasks: state.deleted ? [] : [task] } })
    if (path === '/variables') return route.fulfill({ json: { variables: [] } })
    if (path === `/tasks/${task.id}`) {
      if (req.method() === 'DELETE') {
        if (++state.deleteCalls === 1) return route.fulfill({ status: 500, json: { error: 'simulated_delete_failure' } })
        state.deleted = true
        return route.fulfill({ status: 204 })
      }
      return route.fulfill({ json: { task } })
    }
    if (path === `/tasks/${task.id}/scheduler`) return route.fulfill({ json: { scheduler: { version: 1, alarmAt: null, running: null } } })
    if (path === `/tasks/${task.id}/stats`) return route.fulfill({ json: { range: '24h', granularity: 'hour', from: now - 86400000, to: now, summary, series: [], histogram: [] } })
    if (path === `/tasks/${task.id}/runs`) {
      const before = url.searchParams.get('before')
      const index = before ? state.runs.findIndex((r) => `${r.createdAt}:${r.id}` === before) : -1
      if (before && index === -1) return route.fulfill({ status: 422, json: { error: 'invalid_cursor' } })
      const runs = state.runs.slice(index + 1, index + 51)
      const last = runs.at(-1)
      return route.fulfill({ json: { runs, nextBefore: runs.length === 50 ? `${last.createdAt}:${last.id}` : null } })
    }
    if (path === `/runs/${run.id}`) {
      state.detailReads++
      return route.fulfill({ json: { run: state.run } })
    }
    throw new Error(`Unexpected API request: ${req.method()} ${path}`)
  })
  return state
}

function labels(testInfo) {
  return testInfo.project.name === 'mobile-zh'
    ? { tasks: '任务', edit: '编辑', more: '更多操作', remove: '删除', deleteTask: '删除任务', failed: '删除失败', details: '执行详情', running: '执行中', retrying: '等待重试', success: '成功', older: '加载更早的记录' }
    : { tasks: 'Tasks', edit: 'Edit', more: 'More actions', remove: 'Delete', deleteTask: 'Delete task', failed: 'Delete failed', details: 'Run details', running: 'Running', retrying: 'Retry pending', success: 'Success', older: 'Load earlier runs' }
}

const pageErrors = new WeakMap()
test.beforeEach(({ page }) => {
  const errors = []
  page.on('pageerror', (err) => errors.push(err.message))
  pageErrors.set(page, errors)
})
test.afterEach(({ page }) => expect(pageErrors.get(page)).toEqual([]))

test('breadcrumbs navigate to the task and back to the list', async ({ page }, testInfo) => {
  const { task } = await mockApi(page)
  const text = labels(testInfo)
  await page.goto(`/admin/tasks/${task.id}/edit`)
  const crumbs = page.getByRole('navigation', { name: 'breadcrumb' })
  const taskLink = crumbs.getByRole('link', { name: task.name, exact: true })
  await expect(taskLink).toHaveAttribute('href', `/admin/tasks/${task.id}`)
  await taskLink.click()
  await expect(page).toHaveURL(new RegExp(`/admin/tasks/${task.id}$`))
  await crumbs.getByRole('link', { name: text.tasks, exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/$/)
  await expect(page.getByRole('heading', { name: text.tasks, exact: true })).toBeVisible()
})

test('failed deletion keeps the confirmation open and a successful retry navigates away', async ({ page }, testInfo) => {
  const state = await mockApi(page)
  const text = labels(testInfo)
  const path = `/admin/tasks/${state.task.id}`
  await page.goto(path)
  await page.getByRole('button', { name: text.more, exact: true }).click()
  await page.getByRole('menuitem', { name: text.remove, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: text.deleteTask, exact: true })
  await dialog.getByRole('button', { name: text.remove, exact: true }).click()
  await expect(page.getByText(text.failed, { exact: true })).toBeVisible()
  await expect(dialog).toBeVisible()
  await expect(page).toHaveURL(new RegExp(path + '$'))
  expect(state.deleted).toBe(false)
  await dialog.getByRole('button', { name: text.remove, exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/$/)
  expect(state.deleted).toBe(true)
  expect(state.deleteCalls).toBe(2)
})

for (const status of ['running', 'retrying']) {
  test(`an open ${status} run updates independently of the list and stops polling when finished`, async ({ page }, testInfo) => {
    const state = await mockApi(page)
    const text = labels(testInfo)
    state.run = { ...state.run, status, finishedAt: null, httpStatus: null, responseBody: null }
    state.runs = [state.run]
    await page.goto(`/admin/tasks/${state.task.id}`)
    await page.getByRole('row').filter({ hasText: text[status] }).click()
    const dialog = page.getByRole('dialog', { name: text.details, exact: true })
    await expect(dialog.getByText(text[status], { exact: true })).toBeVisible()
    state.run = { ...state.run, status: 'success', attempt: status === 'retrying' ? 2 : 1, finishedAt: Date.now(), httpStatus: 200, responseBody: '{"code":0}' }
    state.runs = []
    await expect(dialog.getByText(text.success, { exact: true })).toBeVisible({ timeout: 8000 })
    await expect(dialog.getByText('200', { exact: true })).toBeVisible()
    await expect(dialog.getByText('{"code":0}', { exact: true })).toBeVisible()
    await expect(dialog).toHaveCSS('opacity', '1')
    await page.screenshot({ path: testInfo.outputPath('completed-run.png') })
    const reads = state.detailReads
    // Observe longer than one polling interval to verify that final runs stop polling.
    await page.waitForTimeout(2500)
    expect(state.detailReads).toBe(reads)
  })
}

test('load older runs sends the complete cursor and retains timestamp ties', async ({ page }, testInfo) => {
  const state = await mockApi(page)
  state.runs = Array.from({ length: 53 }, () => ({ ...state.run, id: randomUUID() }))
  await page.goto(`/admin/tasks/${state.task.id}`)
  await expect(page.getByRole('row')).toHaveCount(51)
  await page.getByRole('button', { name: labels(testInfo).older, exact: true }).click()
  await expect(page.getByRole('row')).toHaveCount(54)
  await expect(page.getByRole('button', { name: labels(testInfo).older, exact: true })).toHaveCount(0)
})

test('reopening a completed row does not reuse its previously cached running status', async ({ page }, testInfo) => {
  const state = await mockApi(page)
  const text = labels(testInfo)
  state.run = { ...state.run, status: 'running', finishedAt: null, httpStatus: null, responseBody: null }
  state.runs = [state.run]
  await page.goto(`/admin/tasks/${state.task.id}`)
  await page.getByRole('row').filter({ hasText: text.running }).click()
  const dialog = page.getByRole('dialog', { name: text.details, exact: true })
  await expect(dialog.getByText(text.running, { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: testInfo.project.name === 'mobile-zh' ? '关闭' : 'Close', exact: true }).click()
  state.run = { ...state.run, status: 'success', finishedAt: Date.now(), httpStatus: 200, responseBody: '{"code":0}' }
  state.runs = [state.run]
  await page.getByRole('row').filter({ hasText: text.success }).click({ timeout: 8000 })
  await expect(dialog.getByText(text.success, { exact: true })).toBeVisible()
})
