# cf-task

运行在 Cloudflare 上的轻量定时任务系统：秒级 cron / 一次性 / 手动触发，HTTP 执行器，失败重试与告警，执行统计图表，[Kumo](https://github.com/cloudflare/kumo) 管理后台 + REST API。设计见 [docs/design.md](docs/design.md)。

技术栈：Hono · Workers · Durable Objects（每任务一个，alarm 调度）· Queues（执行）· D1（配置与日志）；后台是 React + Kumo 单页应用，由 Vite + `@cloudflare/vite-plugin` 构建为 Workers 静态资源。需要 Workers Paid 套餐。

```
src/        Worker：API、调度 DO、Queue 消费者、对账
  shared/   Worker 与前端共用的类型
web/src/    后台前端（React + Kumo + TanStack Query + wouter）
migrations/ D1 迁移
test/       vitest（在 workerd 中运行）
```

## 本地开发

```sh
pnpm install
cp .dev.vars.example .dev.vars   # 填入 ENCRYPTION_KEY：openssl rand -base64 32
pnpm db:migrate:local
pnpm dev                          # Vite + Worker：http://localhost:5173/admin（admin / .dev.vars 里的 ADMIN_PASSWORD）
```

```sh
pnpm test        # vitest，在 workerd 中运行（@cloudflare/vitest-plugin）
pnpm typecheck   # Worker、前端、测试三套 tsconfig
pnpm build       # 产物在 dist/（client 静态资源 + Worker）
pnpm cf-typegen  # 修改 wrangler.jsonc 后重新生成 worker-configuration.d.ts
```

## 部署

```sh
wrangler d1 create cf-task              # 把输出的 database_id 填进 wrangler.jsonc
wrangler queues create cf-task-runs
wrangler queues create cf-task-runs-dlq
pnpm db:migrate:remote
wrangler secret put API_TOKEN           # 任意强随机字符串
wrangler secret put ENCRYPTION_KEY      # openssl rand -base64 32；丢失后已存变量无法解密
wrangler secret put ADMIN_PASSWORD      # 后台 basic 认证密码
pnpm deploy                             # vite build && wrangler deploy
```

## 配置

`wrangler.jsonc` 的 `vars`：

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADMIN_AUTH_MODE` | `basic` | 后台认证方式：`basic` 或 `access` |
| `ADMIN_USERNAME` | `admin` | basic 模式用户名（密码是 secret `ADMIN_PASSWORD`） |
| `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` | 空 | access 模式必填 |
| `RUN_RETENTION_DAYS` | `30` | 执行日志保留天数（1–3650） |
| `STATS_RETENTION_DAYS` | `90` | 小时级统计保留天数（1–3650），与日志保留互相独立 |

后台默认使用 basic 认证；没设置 `ADMIN_PASSWORD` 时 `/admin` 返回 503。改用 Cloudflare Access：在 Zero Trust 中为 `<你的域名>/admin` 创建 Self-hosted 应用，把 `ADMIN_AUTH_MODE` 设为 `access`，填入团队域名（如 `myteam.cloudflareaccess.com`）和应用的 AUD tag 后重新部署。`/api` 不受这两种方式影响，始终用 `Authorization: Bearer $API_TOKEN`。

## API 速查

| 方法 | 路径 | 说明 |
|---|---|---|
| GET / POST | `/api/tasks` | 列表 / 创建 |
| GET / PUT / DELETE | `/api/tasks/:id` | 查看 / 全量更新 / 删除 |
| POST | `/api/tasks/:id/enable` · `/disable` · `/trigger` | 启用 / 停用 / 手动触发 |
| GET | `/api/tasks/:id/runs?limit=50&before=<createdAt>` | 执行记录（分页） |
| GET | `/api/runs/:id` | 单次执行 |
| GET · PUT · DELETE | `/api/variables` · `/api/variables/:name` | 加密变量（值不返回） |
| GET · PUT | `/api/settings/alert` | 全局告警 |
| GET | `/api/stats/overview?range=24h\|7d\|30d\|90d&tz=Asia/Shanghai` | 全局统计：汇总、时间序列、失败最多 / 最慢的任务 |
| GET | `/api/tasks/:id/stats?range=…&tz=…` | 单任务统计，附耗时分布 |

```sh
curl -X POST https://<host>/api/tasks -H "Authorization: Bearer $API_TOKEN" -H 'content-type: application/json' -d '{
  "name": "每 10 秒心跳",
  "schedule": { "type": "cron", "cron": "*/10 * * * * *", "timezone": "Asia/Shanghai" },
  "executor": { "type": "http", "config": { "url": "https://example.com/ping", "headers": { "Authorization": "Bearer {{PING_TOKEN}}" } } },
  "retry": { "count": 2, "intervalSeconds": 30 }
}'
```
