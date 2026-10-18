import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach } from 'vitest'
import { getRuntimeSettingsState, putRuntimeSettings } from '../src/domain/settings'
import { DEFAULT_RUNTIME_SETTINGS } from '../src/shared/types'

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)

// Most execution tests inspect queue dispatch; configure that explicitly per test.
beforeEach(async () => {
  // Each test gets fresh operational throttles/cache; tests of persistence stay within one case.
  await env.DB.batch([env.DB.prepare('DELETE FROM resource_budgets'), env.DB.prepare('DELETE FROM stats_cache')])
  await putRuntimeSettings(env.DB, { ...DEFAULT_RUNTIME_SETTINGS, executionMode: 'queue' }, Date.now(), (await getRuntimeSettingsState(env.DB)).version)
})
