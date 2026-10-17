import { defineConfig } from '@playwright/test'

const port = Number(process.env.E2E_PORT ?? 6176)

export default defineConfig({
  testDir: './test/e2e',
  testMatch: '**/*.e2e.mjs',
  fullyParallel: true,
  workers: 2,
  timeout: 20_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: process.env.E2E_BROWSER_CHANNEL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop-en', use: { viewport: { width: 1440, height: 1000 }, locale: 'en-US', colorScheme: 'light' } },
    { name: 'mobile-zh', use: { viewport: { width: 390, height: 844 }, locale: 'zh-CN', colorScheme: 'dark' } },
  ],
  webServer: {
    command: 'node test/e2e/server.mjs',
    url: `http://127.0.0.1:${port}/admin/`,
    reuseExistingServer: false,
    timeout: 10_000,
  },
})
