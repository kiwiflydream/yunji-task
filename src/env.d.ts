// Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them.
interface Secrets {
  API_TOKEN: string
  ENCRYPTION_KEY: string
  ADMIN_PASSWORD: string
}
interface CloudflareBindings extends Secrets {}
declare namespace Cloudflare {
  interface Env extends Secrets {}
}

// Optional integrations are configured after initial deployment.
interface OptionalAdminConfig {
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  RPC_BINDINGS?: string
}
interface CloudflareBindings extends OptionalAdminConfig {}
declare namespace Cloudflare {
  interface Env extends OptionalAdminConfig {}
}
