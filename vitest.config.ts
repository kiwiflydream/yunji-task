import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations')
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          serviceBindings: { RPC_TEST: { name: 'rpc-fixture', entrypoint: 'TaskMethods' } },
          workers: [{
            name: 'rpc-fixture', compatibilityDate: '2026-10-16', modules: true,
            script: `import { WorkerEntrypoint } from 'cloudflare:workers';
              export class TaskMethods extends WorkerEntrypoint {
                echo(...args) { return { args }; }
                identity(value) { return value; }
                large(size) { return { text: "x".repeat(size) }; }
                cleanupExpiredSessions({ batchSize }) { return { deleted: batchSize }; }
                noResult() {}
                fail(message) { throw new Error(message); }
                nonJson() { return new Date('2026-10-18T00:00:00Z'); }
              }
              export default { fetch() { return new Response('RPC fixture'); } };`,
          }],
          bindings: {
            TEST_MIGRATIONS: migrations,
            RPC_BINDINGS: 'RPC_TEST',
            API_TOKEN: 'test-api-token',
            ADMIN_PASSWORD: 'test-admin-password',
            // Test-only key: base64 of 32 bytes.
            ENCRYPTION_KEY: 'q6Qz3hS1n0QnQ2tY2l8m3dXg7Kp0rZb9Vw4Uo1Ey5cI=',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
  }
})
