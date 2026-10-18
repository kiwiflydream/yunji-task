# 云吉 Task（Yunji Task）设计

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
     alarm() ─ 计算下次触发并 setAlarm ─ 投递 RunMessage ──► Queue yunji-task-runs
                                                              │
   Queue consumer（同一个 Worker） ◄─────────────────────────┘
     抢占 run → 执行器(HTTP) → 判定成功 → 写 runs / 重试(delaySeconds) / 告警
     → 通知 DO complete(runId) 释放「执行中」标记

   Cron Trigger */5 * * * *：对账（D1 → DO）、标记丢失的 run、清理过期日志和统计
```

## 关键决策

| 方面 | 决定 |
|---|---|
| 执行器 | 可插拔注册表，支持 `http`（URL、请求头、正文）和 `rpc`（服务绑定、方法、JSON 参数）；复用调度、重试、日志、告警与统计，见 [RPC 任务](rpc.md) |
| 调度类型 | `cron`（6 段，秒级，带时区，默认 Asia/Shanghai）、`once`（指定时间执行一次，执行后自动停用）、`manual`（只能手动/API 触发） |
| 调度引擎 | 每任务一个 SQLite 后端的 Durable Object，靠 alarm 实现秒级触发 |
| 执行路径 | 每个任务可以单独设置（`executionMode`：`inherit` / `queue` / `direct` / `worker`），`inherit` 跟随设置页保存到 D1 的全局执行方式（默认 `worker`）。见下文「执行方式」 |
| 错过的触发 | 不补跑。下一次触发时间总是从 `max(now, 本次计划时间)` 往后算 |
| 重叠策略 | 每任务配置：`skip`（默认）/ `parallel`。skip 模式下 DO 记录 `running {runId, leaseUntil}`，消费者结束后调用 `complete(runId)` 释放；租约过期视为释放 |
| 失败处理 | 重试次数 0–10、间隔 1–3600 秒；结果与重试动作在同一 D1 事务中提交，按原方式投递，投递失败可恢复 |
| 成功判定 | 简单模式为 2xx 且（可选）包含关键字，扫描前 1 MiB。高级模式配置 `successCondition`，最多 20 条响应码／正文／JSON 字段规则，以 AND 或 OR 组合，取代简单模式条件；正文与 JSON 规则要求完整响应不超过 1 MiB，字段值严格区分类型，缺失不等于 null |
| 密钥 | `variables` 表，AES-GCM 加密（主密钥 `ENCRYPTION_KEY`，AAD = 变量名）。请求 URL / headers / body 与告警 URL 中用 `{{NAME}}` 引用；日志里出现的明文会被替换为 `***` |
| 告警 | 全局默认（settings 表）+ 每任务 `inherit` / `off` / `custom` / `sender`。任务 `channelGroup` 和全局 `senderChannelGroup` 经 Service Binding `SENDER` 调云吉 Sender（服务名 `yunji-sender`）的 `send({ channelGroup, ... })`，带 `yunji-task:alert:<run.id>` 幂等键；全局 `mode` 明确选择 `webhook` / `sender` / `off`，按所选方式发送，缺少绑定时明确失败。失败时保存目标与模板，由独立 Worker 发送，单次最多 10 秒，失败后间隔 30、60 秒重试，最多 3 次。全局 Webhook 默认提供 Bark JSON 模板；Body 模板留空则 POST 固定结构事件 JSON。可写 body 模板，内置变量 `{{task.id}} {{task.name}} {{run.id}} {{run.status}} {{run.attempt}} {{run.trigger}} {{run.http_status}} {{run.error}} {{run.finished_at}}`，值做 JSON 字符串转义 |
| 日志 | 每次执行一行 `runs`，保存最后一次尝试的实际方式与生效超时。响应体截断 4 KiB；没有正文校验时只读取 4 KiB + 1 字节，高级正文／JSON 条件最多读取 1 MiB + 1 字节用于判断是否超限，保留天数在设置页配置（默认 30） |
| 统计 | 写入时预聚合到 `run_stats`（任务 × 分钟），保留天数在设置页配置（默认 90），与日志保留互相独立。详见下文「统计」 |
| 真相源 | D1。所有写操作 `version + 1` 后 sync 到 DO；DO 拒绝更旧的 version。每 5 分钟补同步未成功的版本，每小时全量对账修复 alarm |
| 管理后台 | React + [Kumo](https://github.com/cloudflare/kumo) 单页应用（`web/`），Vite + `@cloudflare/vite-plugin` 构建为 Workers 静态资源。`run_worker_first` 只覆盖 `/`、`/health`、`/api/*`、`/admin`、`/admin/*`：`/admin/*` 先过后台认证再返回 HTML 壳，`/admin/api/*` 复用与 `/api` 相同的路由（只是认证方式不同）；`/assets/*` 下带 hash 的 JS/CSS 直接由静态资源返回（不含数据）。跟随系统深浅色。 |
| 鉴权 | `/admin` 由 `ADMIN_AUTH_MODE` 选择：`basic`（默认，`ADMIN_USERNAME` + `ADMIN_PASSWORD`）或 `access`（Cloudflare Access JWT）；配置缺失或模式未知时返回 503（fail closed）；另有 CSRF Origin 校验。`/api` 用 `API_TOKEN` Bearer |
| 套餐 | Workers Free / Paid，使用 SQLite 后端的 DO；实际容量受账号与服务额度限制，见[执行方式与费用](execution.md) |

## 投递语义与幂等

- Queue 至少投递一次。每次执行有 `runId`：首次 `INSERT ... ON CONFLICT DO NOTHING` 抢占，重试用 `UPDATE ... WHERE status='retrying' AND attempt=n-1` 抢占。重复消息不调用任务接口，但会恢复该 run 尚未完成的投递动作。
- `run_actions` 与执行结果在同一个 D1 batch 中写入，保存重试的原方式、消息及到期时间，或失败告警的配置快照。动作以 45 秒租约抢占，成功后删除；重试投递与槽位释放最多领取 10 次，告警最多领取 3 次；领取后中断也计数，所有动作创建后最多保留 24 小时。达到次数或期限后置为失败并保留原因。DO 用 `action:<id>` 共用 alarm，再交给独立 `ActionExecutor`；维护任务每 5 分钟恢复待投递及过期租约。发送成功但确认前中断可能重复投递；任务接口有 attempt 抢占，告警接收方应按 `run.id` 去重。
- 消费者抢占后崩溃会留下 `running` / `retrying` 状态的 run，对账任务会把超时（running 15 分钟、retrying 75 分钟）且没有待投递动作的 run 标记为 `failed`（lost）。宁可丢一次执行，也不重复调用下游。待投递动作存在时不做 lost 或日志到期清理；删除 run 时级联删除动作。
- DO alarm 处理函数不抛异常（避免 alarm 自动重试导致重复投递）。一次性触发的待投递记录与 `onceFiredVersion` 在同一 DO 存储事务中保存；读取全局方式失败后按 30 秒间隔恢复，使用同一执行 ID，确定方式后固定该方式。周期任务仍不补跑错过的触发。
- 抢占是幂等的，所以 Queue 重投一个已经抢占过的 run 不会再执行一次。Queue 的自动重投只在抢占之前出错（例如 D1 暂时不可用）时有用；direct 模式用 30 秒后重新投递来模拟（最多 3 次）。
- once 任务触发后，DO 记录 `onceFiredVersion` 并尝试把 D1 中的任务停用（version + 1）；如果这一步失败，对账时会补做。
- 对账将失联的定时执行标为失败时，在同一 D1 batch 中创建 `release` 动作，由现有动作投递流程调用 DO `complete(runId)`。失败后持续恢复，且旧执行的释放不会清除较新的槽位；释放完成前保留执行日志。

## 执行方式

三种方式下，调度器 DO 的 alarm 都先改状态、重新设 alarm，再把这次执行交出去，不阻塞下一次触发。区别在于谁去发 HTTP 请求：

| | `queue` | `direct` | `worker`（默认） |
|---|---|---|---|
| 谁执行 HTTP | Queue 消费者（Worker） | 调度器 DO 自己，在 `ctx.waitUntil` 里 | `RunExecutor` 入口（同一个 Worker）：DO 通过 `ctx.exports.RunExecutor.start()` 调用，它把执行放进自己的 `waitUntil` 后立刻返回 |
| 失败重试 | Queue `delaySeconds` | 存进 DO：每个待执行一个 `pending:<runId>` 键（避免并发执行读改写同一个列表），alarm 指向「下一次触发」和「最早的待执行」中较早的那个 | 同 `direct`，由 Worker 回调 DO 的 `schedule()` 登记，到点后 DO 再交给 Worker |
| D1 等基础设施出错 | Queue 自动重投 | 30 秒后重新投递，最多 3 次 | 同 `direct`（交给 Worker 失败时也一样） |
| skip 槽位释放 | 消费者调用 DO `complete()` | DO 内部直接释放 | Worker 调用 DO `complete()` |
| 手动触发 | 投递消息 | 调用 DO 的 `execute()` | 同 `direct` |
| 每次执行的计费 | Queue 3 次操作、Worker 1 次请求、DO 2 次请求 | DO 1 次请求，加上 **HTTP 等待时长 × 128MB 的 DO duration** | Worker 1 次请求、DO 2 次请求；等待时间落在 Worker 上，只按 CPU 计费 |
| 限制 | 无 | DO 等待待处理 I/O 最多 15 分钟，超时上限 300 秒，在范围内 | **超时 ≤ 25 秒**：`waitUntil` 在入口返回后最多再跑 30 秒，留 5 秒给抢占、记录结果和回调 |

- **为什么 DO 等待要收费**：DO 按在内存中的墙钟时间计费，有未完成的出站请求时不能休眠；普通 Worker 只按 CPU 计费，等待 I/O 不收费。`worker` 方式让 DO 只做一次几毫秒的 RPC，等待落在 Worker 上。
- **计费的两个未验证点**：DO 经 `ctx.exports` 调用 Worker 是否算一次 Worker 请求（按最坏情况算了）；`waitUntil` 里的等待是否确实只计 CPU（Workers 的计费规则如此，但文档没有针对 `waitUntil` 单独说明）。部署后在 Cloudflare 后台核对用量。
- **执行方式与超时**：执行方式只由任务覆盖和 D1 中的全局设置决定，超时不参与路径选择。新任务的默认超时是 25 秒。保存时显式选 `worker`，或跟随当前全局 `worker`，超时超过 25 秒均返回 422。如果已有长超时任务因后续全局变更而使用 `worker`，仍交给 Worker，每次请求超时取任务设置与 25 秒的较小值；不修改存储配置，重试也遵守上限。`direct` / `queue` 使用任务原始超时。
- **部署时**：`direct` 和 `worker` 的请求都在 `waitUntil` 里，部署或运行时更新时可能被中断；被中断的 run 由丢失扫描标记为 failed，和 Queue 消费者崩溃的结果一样。
- **按任务设置**：任务的 `executionMode` 默认是 `inherit`，也可以单独指定。这个字段和超时都在调度快照里，修改后版本号加 1 并同步到 DO。重试和槽位释放跟着这次执行实际走的路径，几种方式可以在同一个部署里同时存在。
- **没有 Queue 的部署**：保存任务时显式选 `queue`，或跟随当前全局 `queue`，均返回 422。已有任务运行时选中了 `queue` 而绑定已被移除，则明确报错，不自动改走其他执行方式。
- **表单建议**：超时在 25 秒以内建议 `worker`；否则根据近 7 天的 P95 耗时，低于 1 秒建议 `direct`，更慢建议 `queue`，并提示 Free 套餐优先 `direct`。只给建议，不自动切换，因为自动切换会在没人操作的情况下改变计费方式。各种方式在不同套餐下的选法见 README「选择执行方式」。
- 切换方式只改配置，不迁移数据。不再用 `queue` 时，Queue 里已经投递的消息需要旧的消费者跑完再删除队列。

## 数据模型（D1）

- `tasks`：配置（扁平列 + `executor_config` / `alert_config` JSON）、`version`、`scheduler_synced_version`。同步成功仅确认对应版本，失败保持未同步；增量维护走未同步任务的部分索引。
- `runs`（`WITHOUT ROWID`）：`id(runId)`、`task_id`、`trigger(schedule|manual)`、`status(running|retrying|success|failed|skipped)`、`attempt`、`execution_mode`、`effective_timeout_ms`、时间、`http_status`、`response_body(≤4KB)`、`error`。跳过的触发没有实际方式和超时。
- `run_actions`（`WITHOUT ROWID`）：动作 ID、run / task ID、JSON 负载、到期时间、尝试次数、不可续期的 expires_at、租约、失败原因和终止时间；按到期时间的部分索引恢复未完成动作，按 run ID 查找和级联删除。
- `run_stats`：主键 `(task_id, bucket)`，见下文「统计」。
- `variables`：`name`、`value_encrypted`、`description`。
- `settings`：`key` → JSON，`version` 是每条配置的递增版本（`alert` 为全局告警，`runtime` 为运行设置；内部 `maintenance:scheduler-reconcile` 的更新时间用于控制每小时全量对账）。运行和告警设置的条件保存原子校验版本，未保存的配置版本为 0；后台绑定表单初始版本，冲突返回 409，不覆盖新配置。任务更新同样支持按 `tasks.version` 条件保存。

下次触发时间不落库，列表页按 cron 现算，避免秒级任务每秒写 D1。

## 统计

- **口径**：只统计最终结果，每个 run 计一次——成功、最终失败（含重试耗尽和被对账标记为 lost 的）、跳过。`retrying` 等中间状态不计。成功率 = 成功 ÷（成功 + 失败），不含跳过。
- **归属的分钟**：按 `scheduled_at` 所在的 UTC 分钟。
- **耗时**：最后一次尝试的 `duration_ms`，记入 11 档直方图（≤50 / 100 / 250 / 500ms / 1 / 2.5 / 5 / 10 / 30 / 60s / 更长），同时记 count / sum / max。P50 / P95 在直方图上线性插值估算，并且不超过实际最大值。lost 的 run 没有耗时。
- **调度延迟**：`started_at - scheduled_at`，只统计定时触发（手动触发没有计划时间）。
- **写入**：统计 upsert 和把 run 移出 `running` 的 UPDATE 放在同一个 D1 batch（事务）里，前者以 `status = 'running'` 为条件，后者也只更新 `running` 的 run。所以重复投递、对账先一步标记 lost、晚到的结果都不会重复计数；晚到的结果不会覆盖 lost，也不会再发告警。跳过的执行和对账标记 lost 也在同一个 batch 里计数。
- **查询**：24h / 7d 按小时，30d / 90d 按浏览器时区的自然日（由前端传 `tz`，服务端在 D1 中把分钟行归到当地的日，按实际日边界处理夏令时）。支持半小时、45 分钟和固定分钟偏移；空桶补 0，查询返回行数最多等于图表点数。
- 删除任务时一并删除它的统计。
- **前端**：「统计」页（全局）和任务详情页（单任务）。图表用 Kumo `Chart` + 按需注册的 ECharts，懒加载。每张图都有表格视图。颜色经过 dataviz 校验：成功 / 失败用 Kumo 的语义色（深色模式单独取值），红绿在色觉障碍模拟下 ΔE ≈ 6.3，属于需要辅助编码的区间，所以堆叠段之间留 2px 表面色间隔（7 天视图柱子过密时为 1px），并保持固定顺序（成功在下），同时配图例和表格。

## 容量提示

D1 按写入行数计费，写操作碰到的每个索引都算额外一行。一次成功执行的完整生命周期实测（`test/cost.test.ts` 固定了这些数字）：

| 步骤 | 写入行数 |
|---|---|
| 抢占（INSERT） | 3：表本身 + 按任务的索引 + 执行中索引 |
| 记录结果（UPDATE） | 1：离开执行中索引不计费 |
| 统计 upsert | 1（该分钟第一次执行为 2） |
| 到期清理（DELETE） | 1 |
| **合计** | **约 6** |

跳过的执行约 4 行（不进入执行中索引）。为此 `runs` 是 `WITHOUT ROWID` 表（TEXT 主键不再额外维护一个唯一索引），只保留两个索引：

- `(task_id, created_at)`：列表和按任务清理都用它。
- `updated_at WHERE status IN ('running','retrying')` 部分索引：给丢失 run 的扫描用。

插入 run 时会在同一条语句里确认任务还存在，所以不会产生按任务清理清不到的孤儿记录。

统计只为有结果的任务／分钟保存一行；100 个任务每分钟都有结果且保留 90 天，最多约 1296 万行。与小时聚合相比，高频任务的统计存储和查询扫描量最多增加 60 倍，可单独缩短统计保留天数。1 秒一次的任务一个月约 260 万次执行；按默认保留 30 天、每条 ≤4KB 计最坏约 10GB，接近 D1 单库上限。高频任务应让下游返回简短响应体，或在设置页调小日志保留天数。

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

运行设置保存于 D1 `settings` 表的 `runtime` 键，无环境变量回退或旧数据迁移：

| 字段 | 默认 | 说明 |
|---|---|---|
| `executionMode` | `worker` | 全局默认执行方式：`worker`、`queue` 或 `direct`，任务可单独覆盖 |
| `retentionDays` | 30 | 执行日志保留天数，1–3650 的整数 |
| `statsRetentionDays` | 90 | 统计保留天数，1–3650 的整数 |

- **读写入口**：`GET/PUT /api/settings/runtime` 与 `/admin/api/settings/runtime`；PUT 校验完整配置、检查 Queue 绑定后整体保存。非法输入返回 422，保留原配置。`/admin/api/me` 同样读取最新设置。
- **生效范围**：新触发的手动执行和定时执行在解析 `inherit` 时读取 D1；无进程内缓存，无需对所有 DO 推送或等待对账。每次继承全局方式的触发增加一次按主键读取配置的 D1 查询。任务显式覆盖不查询全局方式。
- **已在途执行**：执行和重试保持已确定的 transport；Worker 的超时上限仍由执行入口强制限制。修改全局设置不重新安排 alarm，也不更改任务版本。
- **保留策略**：每轮维护读取一次设置，分别用于日志和统计清理；下轮维护使用最新值，增加保留天数不会恢复已清理的数据。

## RPC 执行器

RPC 仅访问 `RPC_BINDINGS` 显式开放的 Service Binding，禁止内部基础设施绑定和保留方法。参数按字符串值展开变量，内置 `task.id`、`run.id`、`run.attempt`；执行 ID 在重试间稳定，可供目标业务幂等。返回值限于 JSON 或 void，正常返回默认成功，可追加 JSON 条件。调用会话在完成或本地超时后释放，超时不代表目标业务已取消。


## 执行安全边界

`settings.safety` 保存独立的全局暂停和日额度；`execution_budget` 按 UTC 日、dispatch/attempt 和任务累计。准入用单条条件 UPSERT 同时约束任务与全局数量，三种执行模式及重试共用实际执行额度。暂停或超限失败不再派生业务重试/告警。DO 交接计数在网络调用前持久化；D1 action 在领取时检查上限和期限，维护清理不能重新激活终态。HTTP 任务请求标记用于拒绝递归触发，不能依赖该标记识别丢弃头部的外部系统，日额度仍为最后一道限制。详细配置和语义见 [执行安全保护](execution.md#调用保护与紧急暂停)。
