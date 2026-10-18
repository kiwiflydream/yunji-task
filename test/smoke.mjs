import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

// Exercise the built application, real local D1/DO/Queue, and HTTP callbacks.
// All credentials and persisted state are isolated from the developer's setup.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'yunji-task-smoke-'))
const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js')
const token = randomBytes(24).toString('hex')
const password = randomBytes(24).toString('hex')
const calls = new Map()
const alerts = []
let worker, browser
let workerLog = ''
const upstream = createServer(async (req, res) => {
  const count = (calls.get(req.url) ?? 0) + 1
  calls.set(req.url, count)
  if (req.url === '/alert') {
    let body = ''
    for await (const chunk of req) body += chunk
    alerts.push(JSON.parse(body))
  }
  if (req.url === '/ok/worker') assert.equal(req.headers['x-smoke-token'], token)
  res.writeHead(req.url === '/fail' || (req.url === '/retry' && count === 1) ? 500 : 200)
  res.end('smoke response')
})

async function waitFor(check, label, timeout = 30_000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await check()) return
    await delay(100)
  }
  throw new Error(`Timed out: ${label}`)
}

try {
  const built = JSON.parse(await readFile(join(root, 'dist/yunji_task/wrangler.json'), 'utf8'))
  const config = join(temporary, 'wrangler.json')
  const state = join(temporary, 'state')
  await writeFile(config, JSON.stringify({
    name: 'yunji-task-smoke', main: join(root, 'dist/yunji_task/index.js'),
    compatibility_date: built.compatibility_date, no_bundle: true,
    assets: { ...built.assets, directory: join(root, 'dist/client') },
    d1_databases: built.d1_databases.map((db) => ({ ...db, migrations_dir: join(root, 'migrations') })),
    durable_objects: built.durable_objects, migrations: built.migrations,
    queues: built.queues, triggers: built.triggers, vars: built.vars,
  }))
  await writeFile(join(temporary, '.dev.vars'), [
    `API_TOKEN=${token}`, `ADMIN_PASSWORD=${password}`,
    `ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,
  ].join('\n'), { mode: 0o600 })
  const commandEnv = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }
  execFileSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', '--config', config, '--persist-to', state], {
    cwd: temporary, env: commandEnv, stdio: 'pipe', timeout: 30_000,
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const destination = `http://127.0.0.1:${upstream.address().port}`
  const reserve = createServer()
  reserve.listen(0, '127.0.0.1')
  await once(reserve, 'listening')
  const port = reserve.address().port
  await new Promise((done) => reserve.close(done))
  const base = `http://127.0.0.1:${port}`
  worker = spawn(process.execPath, [wrangler, 'dev', '--local', '--config', config, '--persist-to', state,
    '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0', '--test-scheduled', '--log-level', 'warn'], {
    cwd: temporary, env: commandEnv, stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (const output of [worker.stdout, worker.stderr]) output.on('data', (chunk) => { workerLog = (workerLog + chunk).slice(-12_000) })
  await waitFor(async () => {
    if (worker.exitCode !== null) throw new Error(`Local Worker exited: ${workerLog}`)
    return fetch(`${base}/health`).then((r) => r.ok).catch(() => false)
  }, 'Worker startup')
  const api = async (path, method = 'GET', body) => {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    if (method === 'PUT' && (path.startsWith('/tasks/') || ['/settings/alert', '/settings/runtime', '/settings/safety'].includes(path))) {
      const current = await fetch(`${base}/api${path}`, { headers })
      assert.ok(current.ok)
      headers['if-match'] = current.headers.get('etag')
    }
    const res = await fetch(`${base}/api${path}`, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    assert.ok(res.ok, `${method} ${path}: ${res.status} ${res.ok ? '' : await res.text()}`)
    return res.status === 204 ? undefined : res.json()
  }
  assert.equal((await fetch(`${base}/api/tasks`)).status, 401)
  assert.equal((await fetch(`${base}/admin`)).status, 401)
  await api('/variables/SMOKE_TOKEN', 'PUT', { value: token, description: 'isolated smoke variable' })
  const tasks = []
  for (const [name, mode, path, retry] of [
    ['worker', 'worker', '/ok/worker', 0], ['direct', 'direct', '/ok/direct', 0],
    ['queue', 'queue', '/ok/queue', 0], ['retry', 'queue', '/retry', 1], ['alert', 'worker', '/fail', 0],
  ]) {
    const { task } = await api('/tasks', 'POST', {
      name, schedule: { type: 'once', runAt: Date.now() + 2000 }, executionMode: mode,
      executor: { type: 'http', config: { url: destination + path, timeoutMs: 5000,
        headers: name === 'worker' ? { 'X-Smoke-Token': '{{SMOKE_TOKEN}}' } : {} } },
      retry: { count: retry, intervalSeconds: 1 },
      alert: name === 'alert' ? { mode: 'custom', url: `${destination}/alert` } : { mode: 'off' },
    })
    tasks.push({ task, name, mode, retry })
  }
  for (const { task, name, mode, retry } of tasks) {
    await waitFor(async () => {
      const { runs } = await api(`/tasks/${task.id}/runs`)
      return runs.length === 1 && runs[0].status === (name === 'alert' ? 'failed' : 'success')
    }, `${name} final outcome`)
    const { runs } = await api(`/tasks/${task.id}/runs`)
    assert.equal(runs[0].attempt, retry + 1)
    assert.equal(runs[0].executionMode, mode)
    assert.equal(runs[0].trigger, 'schedule')
    assert.ok(!JSON.stringify(runs).includes(token), 'logs must redact decrypted variables')
    await waitFor(async () => (await api(`/tasks/${task.id}/scheduler`)).scheduler.running === null, `${name} slot release`)
    assert.equal((await api(`/tasks/${task.id}`)).task.enabled, false)
    console.log(`PASS scheduled ${name}: ${runs[0].status}, attempt ${runs[0].attempt}, slot released`)
  }
  assert.equal(calls.get('/retry'), 2)
  await waitFor(() => alerts.length === 1, 'durable alert delivery')
  assert.equal(alerts[0].task.id, tasks.find((t) => t.name === 'alert').task.id)
  assert.ok((await fetch(`${base}/__scheduled`)).ok)
  console.log('PASS authentication, encrypted variables, log redaction, alert callback and maintenance')

  await api('/settings/alert', 'PUT', { mode: 'webhook', url: `${destination}/alert`, bodyTemplate: '', senderChannelGroup: '' })
  browser = await chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL })
  const context = await browser.newContext({ httpCredentials: { username: 'admin', password }, locale: 'en-US', viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${base}/admin/settings`)
  assert.ok((await page.title()).length > 0)
  const input = page.getByRole('textbox', { name: 'Webhook URL (optional)', exact: true })
  await input.waitFor()
  const { version } = await api('/settings/alert')
  for (let index = 0; index < 2; index++) {
    await input.fill(`${destination}/alert?save=${index}`)
    const response = page.waitForResponse((res) => res.url().endsWith('/admin/api/settings/alert') && res.request().method() === 'PUT')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const saved = await response
    assert.equal(saved.status(), 200)
    assert.equal(saved.request().headers()['if-match'], `"${version + index}"`)
    await saved.finished()
  }
  const taskLimit = page.getByRole('spinbutton', { name: 'Daily limit per task', exact: true })
  const globalLimit = page.getByRole('spinbutton', { name: 'Daily limit across all tasks', exact: true })
  assert.equal(await taskLimit.inputValue(), '10000')
  assert.equal(await globalLimit.inputValue(), '100000')
  for (const paused of [true, false]) {
    await taskLimit.fill(paused ? '9000' : '10000')
    await globalLimit.fill(paused ? '90000' : '100000')
    await page.getByRole('radio', { name: paused ? /Emergency pause/ : /Running/ }).check()
    const response = page.waitForResponse((res) => res.url().endsWith('/admin/api/settings/safety') && res.request().method() === 'PUT')
    await page.getByRole('button', { name: 'Save execution safety settings', exact: true }).click()
    const saved = await response
    assert.equal(saved.status(), 200)
    assert.equal(saved.request().headers()['if-match'], paused ? '"0"' : '"1"')
    await saved.finished()
    const state = await api('/settings/safety')
    assert.deepEqual(state.settings, { paused, taskDailyLimit: paused ? 9000 : 10000, globalDailyLimit: paused ? 90000 : 100000 })
  }
  await page.reload()
  await taskLimit.waitFor()
  assert.equal(await taskLimit.inputValue(), '10000')
  assert.equal(await globalLimit.inputValue(), '100000')
  assert.equal(await page.getByRole('radio', { name: /Running/ }).isChecked(), true)
  await taskLimit.scrollIntoViewIfNeeded()
  console.log('PASS real safety settings UI: defaults, edit limits, pause/resume, versioned saves and reload')
  await page.screenshot({ path: join(tmpdir(), 'cf-task-full-stack-desktop.png') })
  assert.deepEqual(errors, [])
  console.log('PASS real admin UI: two consecutive saves, current If-Match, no page errors')
} finally {
  await browser?.close()
  if (worker && worker.exitCode === null) {
    const exited = once(worker, 'exit')
    worker.kill('SIGTERM')
    const force = setTimeout(() => worker.kill('SIGKILL'), 5000)
    await exited
    clearTimeout(force)
  }
  upstream.closeAllConnections()
  await new Promise((done) => upstream.close(done))
  await rm(temporary, { recursive: true, force: true })
}
