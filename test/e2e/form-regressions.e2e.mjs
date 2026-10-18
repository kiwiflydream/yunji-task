import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'

// This fixture never contacts a Worker, D1, or a real account.
// Updates require If-Match, matching the API contract.
async function fixture(page, testInfo) {
  const zh = testInfo.project.name === 'mobile-zh'
  const text = zh ? {
    name: '名称', edit: '编辑', save: '保存', settings: '设置', tasks: '任务', variables: '变量',
    taskLimit: '单任务每日上限', globalLimit: '全系统每日上限', safetySave: '保存执行安全设置', pause: '紧急暂停', running: '正常运行',
    retention: '日志保留天数', url: 'Webhook URL（可选）', runtimeSave: '保存运行设置', add: '添加变量', value: '值',
    conflict: '配置已被其他操作更新，请重新加载后再保存。', duplicate: '同名变量已存在，请使用更新操作。',
  } : {
    name: 'Name', edit: 'Edit', save: 'Save', settings: 'Settings', tasks: 'Tasks', variables: 'Variables',
    taskLimit: 'Daily limit per task', globalLimit: 'Daily limit across all tasks', safetySave: 'Save execution safety settings', pause: 'Emergency pause', running: 'Running',
    retention: 'Log retention (days)', url: 'Webhook URL (optional)', runtimeSave: 'Save runtime settings', add: 'Add variable', value: 'Value',
    conflict: 'This configuration was updated elsewhere. Reload before saving again.', duplicate: 'A variable with this name already exists. Use Update value instead.',
  }
  const now = Date.now()
  const task = {
    id: randomUUID(), name: 'Original task', description: '', enabled: true,
    schedule: { type: 'manual', timezone: 'Asia/Shanghai' },
    executor: { type: 'http', config: { url: 'https://example.com/job', method: 'GET', headers: {}, body: '', timeoutMs: 25000, successKeyword: '' } },
    overlapPolicy: 'skip', retry: { count: 0, intervalSeconds: 10 }, alert: { mode: 'off' },
    executionMode: 'worker', version: 1, createdAt: now, updatedAt: now, nextRunAt: null,
  }
  const state = {
    task, runtime: { executionMode: 'worker', retentionDays: 30, statsRetentionDays: 90 }, runtimeVersion: 1,
    alert: { mode: 'webhook', url: 'https://example.com/original', bodyTemplate: '', senderChannelGroup: '' }, alertVersion: 1,
    safety: { paused: false, taskDailyLimit: 10000, globalDailyLimit: 100000 }, safetyVersion: 1,
    reads: { task: 0, runtime: 0, alert: 0, safety: 0 }, writes: [], fail: null, delay: null,
    variables: { SECRET: { value: 'keep-this-secret', description: 'Existing variable' } },
  }
  await page.route('**/admin/api/**', async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname.slice('/admin/api'.length)
    const method = req.method()
    const surface = path === `/tasks/${task.id}` ? 'task' : path === '/me' || path === '/settings/runtime' ? 'runtime' : path === '/settings/alert' ? 'alert' : path === '/settings/safety' ? 'safety' : null
    if (surface && method === 'GET') {
      state.reads[surface]++
      if (state.delay?.surface === surface) await state.delay.promise
      if (state.fail === surface) return route.fulfill({ status: 500, json: { error: 'simulated_refresh_failure' } })
      const json = surface === 'task' ? { task: state.task } : surface === 'runtime'
        ? { user: 'fixture', authMode: 'basic', queueAvailable: true, senderAvailable: false, ...state.runtime, runtimeSettingsVersion: state.runtimeVersion }
        : surface === 'safety' ? { settings: state.safety, version: state.safetyVersion } : { alert: state.alert, version: state.alertVersion }
      return route.fulfill({ json })
    }
    if (surface && method === 'PUT') {
      const version = surface === 'task' ? state.task.version : state[`${surface}Version`]
      const match = req.headers()['if-match']
      const body = req.postDataJSON()
      state.writes.push({ surface, match, body })
      if (match === undefined) return route.fulfill({ status: 428, json: { error: 'precondition_required' } })
      if (match !== `"${version}"`) return route.fulfill({ status: 409, json: { error: 'conflict', message: '配置已被其他操作更新，请重新加载后再保存。' } })
      if (surface === 'safety') {
        const issues = ['taskDailyLimit', 'globalDailyLimit'].filter((field) => !Number.isInteger(body[field]) || body[field] < 1 || body[field] > (field === 'taskDailyLimit' ? 1000000 : 10000000))
          .map((path) => ({ path, message: 'Too small: expected number to be >=1' }))
        if (issues.length) return route.fulfill({ status: 422, json: { error: 'validation_failed', issues } })
      }
      if (surface === 'task') {
        state.task = { ...state.task, ...body, version: version + 1 }
        return route.fulfill({ json: { task: state.task } })
      }
      state[surface] = body
      state[`${surface}Version`]++
      return route.fulfill({ json: { [surface === 'alert' ? 'alert' : 'settings']: body, version: version + 1 } })
    }
    if (path === '/tasks') return route.fulfill({ json: { tasks: [state.task] } })
    if (path === '/variables') return route.fulfill({ json: { variables: Object.entries(state.variables).map(([name, v]) => ({ name, description: v.description, updatedAt: now })) } })
    if (path.startsWith('/variables/')) {
      const name = decodeURIComponent(path.slice('/variables/'.length))
      const body = req.postDataJSON()
      state.writes.push({ surface: 'variable', method, name, body })
      if (state.fail === 'variable') return route.fulfill({ status: 500, json: { error: 'simulated_save_failure' } })
      if (method === 'POST' && state.variables[name]) return route.fulfill({ status: 409, json: { error: 'conflict', message: '同名变量已存在，请使用更新操作。' } })
      state.variables[name] = body
      return route.fulfill({ status: 204 })
    }
    if (path.endsWith('/scheduler')) return route.fulfill({ json: { scheduler: { version: state.task.version, alarmAt: null, running: null } } })
    if (path.endsWith('/runs')) return route.fulfill({ json: { runs: [], nextBefore: null } })
    if (path.endsWith('/stats')) return route.fulfill({ json: { range: '24h', granularity: 'hour', from: now - 86400000, to: now, summary: { total: 0, success: 0, failed: 0, skipped: 0, successRate: null, durationAvg: null, durationP50: null, durationP95: null, durationMax: null, delayAvg: null, delayMax: null }, series: [], histogram: [] } })
    throw new Error(`Unexpected fixture request: ${method} ${path}`)
  })
  return { state, text, zh }
}

async function nav(page, text, zh, target) {
  if (zh) await page.getByRole('button', { name: '打开导航菜单', exact: true }).click()
  await page.getByRole('link', { name: text[target], exact: true }).first().click()
}

async function refresh(page, state, surface) {
  const before = state.reads[surface]
  // TanStack uses visibilitychange to revalidate active stale queries.
  await page.waitForTimeout(2100)
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
  await expect.poll(() => state.reads[surface]).toBeGreaterThan(before)
}

function controls(page, text, surface) {
  return {
    input: page.getByRole('textbox', { name: surface === 'task' ? text.name : text.url, exact: true }),
    save: page.getByRole('button', { name: surface === 'runtime' ? text.runtimeSave : surface === 'safety' ? text.safetySave : text.save, exact: true }),
  }
}
function inputFor(page, text, surface) {
  return surface === 'runtime' || surface === 'safety' ? page.getByRole('spinbutton', { name: surface === 'runtime' ? text.retention : text.taskLimit, exact: true }) : controls(page, text, surface).input
}
function remote(state, surface, generation) {
  if (surface === 'task') state.task = { ...state.task, name: `Remote ${generation}`, version: generation }
  else if (surface === 'runtime') { state.runtime = { ...state.runtime, retentionDays: 30 + generation }; state.runtimeVersion = generation }
  else if (surface === 'safety') { state.safety = { ...state.safety, paused: true, taskDailyLimit: 10000 + generation }; state.safetyVersion = generation }
  else { state.alert = { ...state.alert, url: `https://example.com/remote-${generation}` }; state.alertVersion = generation }
  return surface === 'task' ? `Remote ${generation}` : surface === 'runtime' ? String(30 + generation) : surface === 'safety' ? String(10000 + generation) : `https://example.com/remote-${generation}`
}
async function open(page, state, surface) {
  await page.goto(surface === 'task' ? `/admin/tasks/${state.task.id}/edit` : '/admin/settings')
}

const browserErrors = new WeakMap()
test.beforeEach(({ page }) => {
  const errors = []
  page.on('pageerror', (err) => errors.push(err.message))
  browserErrors.set(page, errors)
})
test.afterEach(({ page }) => expect(browserErrors.get(page)).toEqual([]))

for (const surface of ['task', 'alert']) {
  test(`${surface}: Yunji Sender uses channel groups in the editor and save payload`, async ({ page }, testInfo) => {
    const { state, text, zh } = await fixture(page, testInfo)
    await open(page, state, surface)
    await inputFor(page, text, surface).waitFor()
    const sender = surface === 'task'
      ? (zh ? '云吉 Sender 渠道组' : 'Yunji Sender channel group')
      : (zh ? '云吉 Sender' : 'Yunji Sender')
    await page.getByRole('radio', { name: new RegExp(sender) }).check()
    const group = page.getByRole('textbox', { name: zh ? '渠道组标识' : 'Channel group ID', exact: true })
    await expect(group).toBeVisible()
    await group.fill('ops-alert')
    await controls(page, text, surface).save.click()
    await expect.poll(() => state.writes.length).toBe(1)
    const payload = surface === 'task' ? state.writes[0].body.alert : state.writes[0].body
    expect(payload).toMatchObject(surface === 'task'
      ? { mode: 'sender', channelGroup: 'ops-alert' }
      : { mode: 'sender', senderChannelGroup: 'ops-alert' })
    expect(payload).not.toHaveProperty(surface === 'task' ? 'topic' : 'senderTopic')
    await page.screenshot({ path: testInfo.outputPath('sender-channel-group.png') })
  })
}

for (const surface of ['task', 'runtime', 'alert', 'safety']) {
  test(`${surface}: entering an editor waits for a fresh snapshot instead of freezing cached values`, async ({ page }, testInfo) => {
    const { state, text, zh } = await fixture(page, testInfo)
    if (surface === 'task') {
      await page.goto(`/admin/tasks/${state.task.id}`)
      await expect(page.getByRole('heading', { name: state.task.name, exact: true })).toBeVisible()
    } else {
      await page.goto('/admin/settings')
      await expect(inputFor(page, text, surface)).toHaveValue(surface === 'runtime' ? '30' : surface === 'safety' ? '10000' : state.alert.url)
      await nav(page, text, zh, 'tasks')
    }
    const expected = remote(state, surface, 2)
    let release
    state.delay = { surface, promise: new Promise((resolve) => { release = resolve }) }
    const before = state.reads[surface]
    if (surface === 'task') await page.getByRole('link', { name: text.edit, exact: true }).click()
    else await nav(page, text, zh, 'settings')
    // A fresh cache is still not a valid editing baseline when another actor wrote.
    await expect.poll(() => state.reads[surface]).toBeGreaterThan(before)
    await expect(inputFor(page, text, surface)).toHaveCount(0)
    release()
    state.delay = null
    await expect(inputFor(page, text, surface)).toHaveValue(expected)
    await inputFor(page, text, surface).fill(surface === 'runtime' ? '45' : surface === 'safety' ? '2000' : surface === 'task' ? 'Mine' : 'https://example.com/mine')
    await controls(page, text, surface).save.click()
    await expect.poll(() => state.writes.length).toBe(1)
    expect(state.writes[0].match).toBe('"2"')
  })

  test(`${surface}: a pristine form adopts refreshed values and their version`, async ({ page }, testInfo) => {
    const { state, text } = await fixture(page, testInfo)
    await open(page, state, surface)
    const input = inputFor(page, text, surface)
    await expect(input).toBeVisible()
    const expected = remote(state, surface, 2)
    await refresh(page, state, surface)
    await expect(input).toHaveValue(expected)
    await controls(page, text, surface).save.click()
    await expect.poll(() => state.writes.length).toBe(1)
    expect(state.writes[0].match).toBe('"2"')
    if (surface !== 'task') {
      await expect(controls(page, text, surface).save).toBeEnabled()
      await input.fill(surface === 'runtime' ? '50' : surface === 'safety' ? '3000' : 'https://example.com/second-save')
      await controls(page, text, surface).save.click()
      await expect.poll(() => state.writes.length).toBe(2)
      expect(state.writes[1].match).toBe('"3"')
    }
  })

  test(`${surface}: dirty drafts survive refresh and save with their original version`, async ({ page }, testInfo) => {
    const { state, text } = await fixture(page, testInfo)
    await open(page, state, surface)
    const input = inputFor(page, text, surface)
    const mine = surface === 'runtime' ? '45' : surface === 'safety' ? '2000' : surface === 'task' ? 'My unsaved draft' : 'https://example.com/my-draft'
    await input.fill(mine)
    const expected = remote(state, surface, 2)
    await refresh(page, state, surface)
    await expect(input).toHaveValue(mine)
    await expect(page.getByText(text.conflict, { exact: true }).first()).toBeVisible()
    await controls(page, text, surface).save.click()
    await expect.poll(() => state.writes.length).toBe(1)
    expect(state.writes[0].match).toBe('"1"')
    await expect(input).toHaveValue(mine)
    expect(surface === 'task' ? state.task.name : surface === 'runtime' ? String(state.runtime.retentionDays) : surface === 'safety' ? String(state.safety.taskDailyLimit) : state.alert.url).toBe(expected)
    await page.screenshot({ path: testInfo.outputPath(`${surface}-draft-conflict.png`) })
  })

  test(`${surface}: a background refresh error preserves the mounted draft`, async ({ page }, testInfo) => {
    const { state, text } = await fixture(page, testInfo)
    await open(page, state, surface)
    const input = inputFor(page, text, surface)
    const mine = surface === 'runtime' ? '45' : surface === 'safety' ? '2000' : surface === 'task' ? 'Keep my draft' : 'https://example.com/keep-draft'
    await input.fill(mine)
    state.fail = surface
    await refresh(page, state, surface)
    await expect(page.getByText('simulated_refresh_failure', { exact: true }).first()).toBeVisible({ timeout: 6000 })
    await expect(input).toHaveValue(mine)
    state.fail = null
    await refresh(page, state, surface)
    await expect(input).toHaveValue(mine)
  })

  test(`${surface}: a server conflict without prior refresh keeps the draft and explains recovery`, async ({ page }, testInfo) => {
    const { state, text } = await fixture(page, testInfo)
    await open(page, state, surface)
    const input = inputFor(page, text, surface)
    const mine = surface === 'runtime' ? '45' : surface === 'safety' ? '2000' : surface === 'task' ? 'Keep on 409' : 'https://example.com/keep-on-409'
    await input.fill(mine)
    const expected = remote(state, surface, 2)
    await controls(page, text, surface).save.click()
    await expect.poll(() => state.writes.length).toBe(1)
    expect(state.writes[0].match).toBe('"1"')
    await expect(page.getByText(text.conflict, { exact: true }).first()).toBeVisible()
    await expect(input).toHaveValue(mine)
    expect(surface === 'task' ? state.task.name : surface === 'runtime' ? String(state.runtime.retentionDays) : surface === 'safety' ? String(state.safety.taskDailyLimit) : state.alert.url).toBe(expected)
  })
}

test('variable creation is create-only and a duplicate keeps the dialog and secret intact', async ({ page }, testInfo) => {
  const { state, text } = await fixture(page, testInfo)
  await page.goto('/admin/variables')
  await page.getByRole('button', { name: text.add, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: text.add, exact: true })
  await dialog.getByRole('textbox', { name: text.name, exact: true }).fill('SECRET')
  await dialog.getByLabel(text.value, { exact: true }).fill('new-fixture-value')
  await dialog.getByRole('button', { name: text.save, exact: true }).click()
  await expect.poll(() => state.writes.length).toBe(1)
  expect(state.writes[0].method).toBe('POST')
  expect(state.variables.SECRET.value).toBe('keep-this-secret')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(text.duplicate, { exact: true })).toBeVisible()
  await expect(dialog.getByLabel(text.value, { exact: true })).toHaveValue('new-fixture-value')
  await dialog.getByRole('textbox', { name: text.name, exact: true }).fill('NEW_SECRET')
  await dialog.getByRole('button', { name: text.save, exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(state.variables.NEW_SECRET.value).toBe('new-fixture-value')
})

test('variable update uses PUT and failed saves preserve the dialog for a retry', async ({ page }, testInfo) => {
  const { state, text, zh } = await fixture(page, testInfo)
  await page.goto('/admin/variables')
  await page.getByRole('button', { name: zh ? '更新 SECRET 的值' : 'Update the value of SECRET', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: zh ? '更新 SECRET' : 'Update SECRET', exact: true })
  await expect(dialog.getByRole('textbox', { name: text.name, exact: true })).toBeDisabled()
  await dialog.getByLabel(text.value, { exact: true }).fill('replacement-fixture-value')
  state.fail = 'variable'
  await dialog.getByRole('button', { name: text.save, exact: true }).click()
  await expect(dialog.getByText('simulated_save_failure')).toBeVisible()
  await expect(dialog.getByLabel(text.value, { exact: true })).toHaveValue('replacement-fixture-value')
  expect(state.variables.SECRET.value).toBe('keep-this-secret')
  state.fail = null
  await dialog.getByRole('button', { name: text.save, exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(state.writes.map((write) => write.method)).toEqual(['PUT', 'PUT'])
  expect(state.variables.SECRET.value).toBe('replacement-fixture-value')
})


test('safety: saves both daily limits, persists pause, and resumes with the new version', async ({ page }, testInfo) => {
  const { state, text } = await fixture(page, testInfo)
  await page.goto('/admin/settings')
  const taskLimit = page.getByRole('spinbutton', { name: text.taskLimit, exact: true })
  const globalLimit = page.getByRole('spinbutton', { name: text.globalLimit, exact: true })
  await expect(taskLimit).toHaveValue('10000')
  await expect(globalLimit).toHaveValue('100000')
  await taskLimit.fill('2000')
  await globalLimit.fill('20000')
  await page.getByRole('radio', { name: new RegExp(text.pause) }).check()
  await page.getByRole('button', { name: text.safetySave, exact: true }).click()
  await expect.poll(() => state.safety).toEqual({ paused: true, taskDailyLimit: 2000, globalDailyLimit: 20000 })
  await page.reload()
  await expect(taskLimit).toHaveValue('2000')
  await expect(globalLimit).toHaveValue('20000')
  await expect(page.getByRole('radio', { name: new RegExp(text.pause) })).toBeChecked()
  await page.getByRole('radio', { name: new RegExp(text.running) }).check()
  await page.getByRole('button', { name: text.safetySave, exact: true }).click()
  await expect.poll(() => state.writes.length).toBe(2)
  expect(state.writes.map((w) => w.match)).toEqual(['"1"', '"2"'])
  expect(state.safety.paused).toBe(false)
  await expect(page).toHaveURL(/\/admin\/settings$/)
  await expect(page).not.toHaveTitle('')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await taskLimit.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(tmpdir(), `cf-task-safety-${testInfo.project.name}.png`), fullPage: true })
})

test('safety: invalid daily limits retain the draft and display field errors', async ({ page }, testInfo) => {
  const { state, text, zh } = await fixture(page, testInfo)
  await page.goto('/admin/settings')
  const taskLimit = page.getByRole('spinbutton', { name: text.taskLimit, exact: true })
  await taskLimit.fill('0')
  await page.getByRole('button', { name: text.safetySave, exact: true }).click()
  await expect(page.getByText(zh ? '数值不能小于 1' : 'Value must be at least 1', { exact: true })).toBeVisible()
  await expect(taskLimit).toHaveValue('0')
  expect(state.safety.taskDailyLimit).toBe(10000)
  expect(state.safetyVersion).toBe(1)
})
