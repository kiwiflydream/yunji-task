import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations')
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            API_TOKEN: 'test-api-token',
            ADMIN_PASSWORD: 'test-admin-password',
            // Test-only key: base64 of 32 bytes.
            ENCRYPTION_KEY: 'q6Qz3hS1n0QnQ2tY2l8m3dXg7Kp0rZb9Vw4Uo1Ey5cI=',
            // Most tests follow runs through the queue; the other modes set it per test.
            EXECUTION_MODE: 'queue',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
  }
})
