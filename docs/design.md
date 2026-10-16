# cf-task 设计

运行在 Cloudflare 上的轻量定时任务系统（cf 版 xxl-job / 青龙的简化版）。单管理员自用，几十到几百个任务，支持秒级调度。

## 架构

```
            ┌────────────── Worker (Hono) ──────────────┐
 浏览器 ──► │ /admin  (Basic / Access, Kumo SPA)         │
 脚本   ──► │ /api    (Bearer Token, JSON)               │
            │      │ 写 D1（真相源） → sync 到 DO         │
            └──────┼────────────────────────────────────┘
                   ▼
   TaskScheduler DO（每个任务一个，id = taskId）
     alarm() ─ 计算下次触发并 setAlarm ─ 投递 RunMessage ──► Queue cf-task-runs
                                                              │
   Queue consumer（同一个 Worker） ◄─────────────────────────┘
     抢占 run → 执行器(HTTP) → 判定成功 → 写 runs / 重试(delaySeconds) / 告警
     → 通知 DO complete(runId) 释放「执行中」标记

   Cron Trigger */5 * * * *：对账（D1 → DO）、标记丢失的 run、清理过期日志和统计
```

## 关键决策

| 方面 | 决定 |
|---|---|
| 执行器 | 可插拔注册表，v1 只有 `http`（URL / method / headers / body / 超时 / 成功关键字） |
| 调度类型 | `cron`（6 段，秒级，带时区，默认 Asia/Shanghai）、`once`（指定时间执行一次，执行后自动停用）、`manual`（只能手动/API 触发） |
| 调度引擎 | 每任务一个 SQLite 后端的 Durable Object，靠 alarm 实现秒级触发 |
| 执行路径 | 由 `EXECUTION_MODE` 选择：`queue`（默认），alarm 先 setAlarm(下一次) 再投递消息，消费者执行；`direct`，不用 Queue，由调度器 DO 自己执行。见下文「执行方式」 |
| 错过的触发 | 不补跑。下一次触发时间总是从 `max(now, 本次计划时间)` 往后算 |
| 重叠策略 | 每任务配置：`skip`（默认）/ `parallel`。skip 模式下 DO 记录 `running {runId, leaseUntil}`，消费者结束后调用 `complete(runId)` 释放；租约过期视为释放 |
| 失败处理 | 重试次数 0–10、间隔 1–3600 秒，用 Queue `delaySeconds` 实现；最终失败调用告警 webhook |
| 成功判定 | 2xx，且（如配置）响应体包含关键字。关键字在前 1MB 内匹配 |
| 密钥 | `variables` 表，AES-GCM 加密（主密钥 `ENCRYPTION_KEY`，AAD = 变量名）。请求 URL / headers / body 与告警 URL 中用 `{{NAME}}` 引用；日志里出现的明文会被替换为 `***` |
| 告警 | 全局默认（settings 表）+ 每任务 `inherit` / `off` / `custom`。默认 POST 固定结构 JSON；可写 body 模板，内置变量 `{{task.id}} {{task.name}} {{run.id}} {{run.status}} {{run.attempt}} {{run.trigger}} {{run.http_status}} {{run.error}} {{run.finished_at}}`，值做 JSON 字符串转义 |
| 日志 | 每次执行一行 `runs`，响应体截断 4KB，保留天数由 `RUN_RETENTION_DAYS` 配置（默认 30） |
| 统计 | 写入时预聚合到 `run_stats_hourly`（任务 × 小时），保留天数由 `STATS_RETENTION_DAYS` 配置（默认 90），与日志保留互相独立。详见下文「统计」 |
| 真相源 | D1。所有写操作 `version + 1` 后 sync 到 DO；DO 拒绝更旧的 version；对账每 5 分钟重放一次 |
| 管理后台 | React + [Kumo](https://github.com/cloudflare/kumo) 单页应用（`web/`），Vite + `@cloudflare/vite-plugin` 构建为 Workers 静态资源。`run_worker_first` 只覆盖 `/`、`/health`、`/api/*`、`/admin`、`/admin/*`：`/admin/*` 先过后台认证再返回 HTML 壳，`/admin/api/*` 复用与 `/api` 相同的路由（只是认证方式不同）；`/assets/*` 下带 hash 的 JS/CSS 直接由静态资源返回（不含数据）。跟随系统深浅色。 |
| 鉴权 | `/admin` 由 `ADMIN_AUTH_MODE` 选择：`basic`（默认，`ADMIN_USERNAME` + `ADMIN_PASSWORD`）或 `access`（Cloudflare Access JWT）；配置缺失或模式未知时返回 503（fail closed）；另有 CSRF Origin 校验。`/api` 用 `API_TOKEN` Bearer |
| 套餐 | Workers Paid（DO、Queues、秒级负载） |

## 投递语义与幂等

- Queue 至少投递一次。每次执行有 `runId`：首次 `INSERT ... ON CONFLICT DO NOTHING` 抢占，重试用 `UPDATE ... WHERE status='retrying' AND attempt=n-1` 抢占，抢占失败即视为重复消息直接 ack。
- 消费者抢占后崩溃会留下 `running` / `retrying` 状态的 run，对账任务会把超时（running 15 分钟、retrying 75 分钟）的 run 标记为 `failed`（lost）。宁可丢一次执行，也不重复调用下游。
- DO alarm 处理函数不抛异常（避免 alarm 自动重试导致重复投递）；投递失败只记日志，由下一次触发继续。
- 抢占是幂等的，所以 Queue 重投一个已经抢占过的 run 不会再执行一次。Queue 的自动重投只在抢占之前出错（例如 D1 暂时不可用）时有用；direct 模式用 30 秒后重新投递来模拟（最多 3 次）。
- once 任务触发后，DO 记录 `onceFiredVersion` 并尝试把 D1 中的任务停用（version + 1）；如果这一步失败，对账时会补做。

## 执行方式（`EXECUTION_MODE`）

| | `queue`（默认） | `direct` |
|---|---|---|
| 谁执行 HTTP | Queue 消费者（Worker） | 调度器 DO：alarm 先改状态、重新设 alarm，再用 `ctx.waitUntil` 在后台执行，立刻返回，不阻塞下一次触发 |
| 失败重试 | Queue `delaySeconds` | 存进 DO 存储（每个待执行一个 `pending:<runId>` 键，避免并发执行读改写同一个列表）；alarm 指向「下一次触发」和「最早的待执行」中较早的那个 |
| skip 槽位释放 | 消费者调用 DO `complete()` | DO 内部直接释放 |
| 手动触发 | 投递消息 | 调用 DO 的 `execute()` |
| 每次执行的计费 | Queue 3 次操作、Worker 1 次请求、DO 2 次请求 | DO 1 次请求，加上 **HTTP 等待时长 × 128MB 的 DO duration** |
| 适合 | 慢接口、高并发 | 免费套餐、对价格敏感、接口响应在 1 秒以内 |

- **为什么默认用 Queue**：Worker 等待 HTTP 响应不计费，DO 等待要按墙钟时间计 duration。接口平均响应超过约 1 秒时，Queue 模式更便宜（Paid 套餐下 Queue 路径每百万次约 $1.5，DO 每秒约 $1.56 每百万次）。
- **免费套餐**：Queue 每天 1 万次操作只够约 3300 次执行；direct 模式下瓶颈变成 D1 写入，约 1.6 万次每天。
- **direct 模式的代价**：部署或运行时更新时，正在执行的请求最多有 30 秒宽限。被中断的 run 由丢失扫描标记为 failed，和 Queue 模式下消费者崩溃的结果一样。一个任务的所有执行都落在它自己那个 DO 上。DO 等待待处理 I/O 最多 15 分钟，超时上限 300 秒，在范围内。
- 切换模式只改配置，不迁移数据。从 queue 切到 direct 时，Queue 里已经投递的消息需要旧的消费者跑完再删除队列。

## 数据模型（D1）

- `tasks`：配置（扁平列 + `executor_config` / `alert_config` JSON）、`version`。
- `runs`（`WITHOUT ROWID`）：`id(runId)`、`task_id`、`trigger(schedule|manual)`、`status(running|retrying|success|failed|skipped)`、`attempt`、时间、`http_status`、`response_body(≤4KB)`、`error`。
- `run_stats_hourly`：主键 `(task_id, hour)`，见下文「统计」。
- `variables`：`name`、`value_encrypted`、`description`。
- `settings`：`key` → JSON（目前只有 `alert`）。

下次触发时间不落库，列表页按 cron 现算，避免秒级任务每秒写 D1。

## 统计

- **口径**：只统计最终结果，每个 run 计一次——成功、最终失败（含重试耗尽和被对账标记为 lost 的）、跳过。`retrying` 等中间状态不计。成功率 = 成功 ÷（成功 + 失败），不含跳过。
- **归属的小时**：按 `scheduled_at` 所在的 UTC 小时。
- **耗时**：最后一次尝试的 `duration_ms`，记入 11 档直方图（≤50 / 100 / 250 / 500ms / 1 / 2.5 / 5 / 10 / 30 / 60s / 更长），同时记 count / sum / max。P50 / P95 在直方图上线性插值估算，并且不超过实际最大值。lost 的 run 没有耗时。
- **调度延迟**：`started_at - scheduled_at`，只统计定时触发（手动触发没有计划时间）。
- **写入**：统计 upsert 和把 run 移出 `running` 的 UPDATE 放在同一个 D1 batch（事务）里，前者以 `status = 'running'` 为条件，后者也只更新 `running` 的 run。所以重复投递、对账先一步标记 lost、晚到的结果都不会重复计数；晚到的结果不会覆盖 lost，也不会再发告警。跳过的执行和对账标记 lost 也在同一个 batch 里计数。
- **查询**：24h / 7d 按小时，30d / 90d 按浏览器时区的自然日（由前端传 `tz`，服务端把小时行归到当地的日）。半小时时区的日边界会有半小时误差。空桶补 0。
- **历史数据**：不回填，从启用统计（迁移 `0002`）之后开始累计。删除任务时一并删除它的统计。
- **前端**：「统计」页（全局）和任务详情页（单任务）。图表用 Kumo `Chart` + 按需注册的 ECharts，懒加载。每张图都有表格视图。颜色经过 dataviz 校验：成功 / 失败用 Kumo 的语义色（深色模式单独取值），红绿在色觉障碍模拟下 ΔE ≈ 6.3，属于需要辅助编码的区间，所以堆叠段之间留 2px 表面色间隔（7 天视图柱子过密时为 1px），并保持固定顺序（成功在下），同时配图例和表格。

## 容量提示

D1 按写入行数计费，写操作碰到的每个索引都算额外一行。一次成功执行的完整生命周期实测（`test/cost.test.ts` 固定了这些数字）：

| 步骤 | 写入行数 |
|---|---|
| 抢占（INSERT） | 3：表本身 + 按任务的索引 + 执行中索引 |
| 记录结果（UPDATE） | 1：离开执行中索引不计费 |
| 统计 upsert | 1（该小时第一次执行为 2） |
| 到期清理（DELETE） | 1 |
| **合计** | **约 6** |

跳过的执行约 4 行（不进入执行中索引）。为此 `runs` 是 `WITHOUT ROWID` 表（TEXT 主键不再额外维护一个唯一索引），只保留两个索引：

- `(task_id, created_at)`：列表和按任务清理都用它。
- `updated_at WHERE status IN ('running','retrying')` 部分索引：给丢失 run 的扫描用。

迁移 `0003` 之前合计约 9 行。插入 run 时会在同一条语句里确认任务还存在，所以不会产生按任务清理清不到的孤儿记录。

统计行数只和任务数 × 小时数有关（100 个任务保留 90 天约 21.6 万行），与执行频率无关。1 秒一次的任务一个月约 260 万次执行；按默认保留 30 天、每条 ≤4KB 计最坏约 10GB，接近 D1 单库上限。高频任务应让下游返回简短响应体，或调小 `RUN_RETENTION_DAYS`。

## 配置

| 名称 | 类型 | 说明 |
|---|---|---|
| `API_TOKEN` | secret | `/api` 的 Bearer token |
| `ENCRYPTION_KEY` | secret | base64 编码的 32 字节 AES 密钥（`openssl rand -base64 32`） |
| `ADMIN_PASSWORD` | secret | basic 模式的后台密码；未设置时后台返回 503 |
| `ADMIN_AUTH_MODE` | var | `basic`（默认）或 `access` |
| `ADMIN_USERNAME` | var | basic 模式用户名，默认 `admin` |
| `ACCESS_TEAM_DOMAIN` | var | access 模式：例如 `myteam.cloudflareaccess.com` |
| `ACCESS_AUD` | var | access 模式：Access 应用的 AUD tag |
| `EXECUTION_MODE` | var | `queue`（默认）或 `direct`，见「执行方式」；未知值按 `queue` 处理并记录警告 |
| `RUN_RETENTION_DAYS` | var | 执行日志保留天数，1–3650，默认 30；非法值按默认处理并记录警告 |
| `STATS_RETENTION_DAYS` | var | 统计保留天数，1–3650，默认 90；非法值按默认处理并记录警告 |
