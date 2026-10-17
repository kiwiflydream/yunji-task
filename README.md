# 云吉 Task（Yunji Task）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR_USERNAME/yunji-task)

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

后台支持简体中文与英文，可通过页面顶部的语言选择器切换。首次打开时跟随浏览器的首个受支持语言，其他语言回退到英文；手动选择会保存在当前浏览器，并在同源标签页间同步。语言切换不影响未保存的表单、任务时区、用户填写的数据或通知模板。英文界面的应用名为 Yunji Task。

```sh
pnpm install
cp .dev.vars.example .dev.vars   # 填入 API_TOKEN、ENCRYPTION_KEY 和 ADMIN_PASSWORD，生成方式见文件注释
pnpm db:migrate:local
pnpm dev                          # Vite + Worker：http://localhost:5173/admin（admin / .dev.vars 里的 ADMIN_PASSWORD）
```

```sh
pnpm test        # vitest，在 workerd 中运行（@cloudflare/vitest-plugin）
pnpm test:e2e    # 构建后运行浏览器回归测试，使用独立静态服务与模拟 API，不读写本地 D1
pnpm typecheck   # Worker、前端、测试三套 tsconfig
pnpm build       # 产物在 dist/（client 静态资源 + Worker）
pnpm cf-typegen  # 修改 wrangler.jsonc 后重新生成 worker-configuration.d.ts
```

首次运行浏览器测试前执行 `pnpm exec playwright install chromium`；本机已有 Chrome 时，也可直接运行 `E2E_BROWSER_CHANNEL=chrome pnpm test:e2e`。测试默认使用端口 6176，可通过 `E2E_PORT` 调整。

## 部署

### 一键部署

项目尚未发布到 GitHub，顶部按钮中的 `https://github.com/YOUR_USERNAME/yunji-task` 是占位地址。发布为公开仓库后，将它替换为实际仓库地址，按钮即可直接导入本项目。

点击顶部按钮，按以下步骤部署。流程见 [Cloudflare 官方文档](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。

1. 登录 Cloudflare，授权 GitHub 或 GitLab，将项目复制到自己的仓库。
2. 确认 Worker、D1 和 Queue 的名称，Cloudflare 会根据 `wrangler.jsonc` 创建并绑定资源。
3. 填写下面三个密钥，再确认部署。

| 密钥 | 填写方式 |
|---|---|
| `ADMIN_PASSWORD` | 设置独立的强密码，用于后台登录，默认用户名为 `admin` |
| `API_TOKEN` | 用 `openssl rand -hex 32` 生成，用于 REST API 的 Bearer 认证 |
| `ENCRYPTION_KEY` | 用 `openssl rand -base64 32` 生成，用于加密任务变量；妥善保存，更换后已存变量将无法解密 |

构建和部署命令会从 `package.json` 自动读取，保留默认值即可。部署脚本会构建应用、执行尚未应用的 D1 迁移，再发布 Worker。部署成功后打开应用地址的 `/admin`，用 `admin` 和刚设置的 `ADMIN_PASSWORD` 登录。

### 命令行部署

```sh
wrangler d1 create yunji-task              # 把输出的 database_id 填进 wrangler.jsonc
wrangler queues create yunji-task-runs     # 不用队列方式时不需要这两个队列
wrangler queues create yunji-task-runs-dlq
wrangler secret put API_TOKEN           # 任意强随机字符串
wrangler secret put ENCRYPTION_KEY      # openssl rand -base64 32；丢失后已存变量无法解密
wrangler secret put ADMIN_PASSWORD      # 后台 basic 认证密码
pnpm deploy                             # 构建、执行 D1 迁移并发布 Worker
```

## 配置

`wrangler.jsonc` 的 `vars`：

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADMIN_AUTH_MODE` | `basic` | 后台认证方式：`basic` 或 `access` |
| `ADMIN_USERNAME` | `admin` | basic 模式用户名（密码是 secret `ADMIN_PASSWORD`） |
| `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` | 空 | access 模式必填 |

后台「设置 → 运行设置」保存到 D1，无需重启或重新部署：

| 设置 | 默认 | 生效方式 |
|---|---|---|
| 全局默认执行方式 | Worker 异步 | 「跟随全局」任务从下一次新触发开始使用；显式选择的方式、已开始的执行及已安排的重试保持原方式 |
| 日志保留天数 | 30 | 1–3650 天，下一轮清理使用 |
| 统计保留天数 | 90 | 1–3650 天，与日志独立，下一轮清理使用 |

运行配置只有 D1 中这一处来源；未保存时使用上表默认值。API：`GET /api/settings/runtime`、`PUT /api/settings/runtime`，配置字段为 `executionMode`、`retentionDays`、`statsRetentionDays`，PUT 需要提交完整配置；后台对应 `/admin/api/settings/runtime`。保存队列方式前会检查 Queue 绑定，非法配置返回 422，不覆盖原值。调度器在每次新触发时读取最新配置，不等待每 5 分钟的对账；保留天数由每 5 分钟的清理任务读取，调大天数不会恢复已删除的数据。

后台默认使用 basic 认证；没设置 `ADMIN_PASSWORD` 时 `/admin` 返回 503。改用 Cloudflare Access：在 Zero Trust 中为 `<你的域名>/admin` 创建 Self-hosted 应用，把 `ADMIN_AUTH_MODE` 设为 `access`，填入团队域名（如 `myteam.cloudflareaccess.com`）和应用的 AUD tag 后重新部署。`/api` 不受这两种方式影响，始终用 `Authorization: Bearer $API_TOKEN`。

## 选择执行方式

每次执行都要发一个 HTTP 请求。谁来发这个请求，有三种方式：

- **Worker 异步（`worker`，默认）**：任务的调度器 DO 到点后把执行交给本项目的 Worker，Worker 在后台发请求，DO 几毫秒就结束。只支持**超时 ≤ 25 秒**的任务。
- **队列（`queue`）**：调度器 DO 往 Queue 投一条消息，由 Worker 消费并发请求。失败重试用 Queue 的延迟投递。
- **直接执行（`direct`）**：调度器 DO 自己发请求，不经过 Queue。

队列首次投递失败时，调度器会保留原执行 ID，并以 30 秒起、最多 5 分钟的退避间隔重投，直到 Queue 确认接收；一次性任务停用后仍保留这次待投递执行。重投始终使用原队列方式，消费端按执行 ID 去重。这与接口执行失败后的任务重试设置分别处理。

三种方式的功能完全一样（重试、跳过 / 并行、告警、统计、手动触发），D1 写入量也一样，区别只在计费和限制：

| | Worker 异步 | 队列 | 直接执行 |
|---|---|---|---|
| 等待接口响应的时间 | 由 Worker 承担，不收费（Worker 只按 CPU 计费） | 由 Worker 承担，不收费 | **按 DO 运行时长收费**（128MB × 等待秒数） |
| 每次执行的 Queue 操作 | 0 | 3 次 | 0 |
| 需要创建 Queue | 不需要 | 需要 | 不需要 |
| 超时上限 | **25 秒** | 300 秒 | 300 秒 |

为什么 DO 等待要收费：DO 按「在内存里的时间」计费，只要还有没返回的请求就不能休眠；普通 Worker 只按 CPU 计费，等待网络响应时不收费。Worker 异步的 25 秒上限来自 Worker 后台任务（`waitUntil`）在返回后最多再跑 30 秒的限制，留 5 秒给记录结果。

### 先分短任务和长任务

按任务设置的**超时**分，而不是接口实际跑多久：

- **短任务**：超时 ≤ 25 秒。可以用 Worker 异步。
- **长任务**：超时 > 25 秒。不能用 Worker 异步，在直接执行和队列之间选。

接口实际很快、只是超时设得宽的任务，把超时调到 25 秒以内就变成短任务，可以用更省钱的 Worker 异步。超时一般设成接口 P95 耗时的 3 倍左右就够了（任务详情页的统计里能看到 P95）。新建任务的默认超时就是 25 秒。

### 怎么选：一张表

| | Free 套餐 | Paid 套餐 |
|---|---|---|
| **短任务**（超时 ≤ 25 秒） | **Worker 异步** | **Worker 异步** |
| **长任务**，接口一般 1 秒内返回 | **直接执行** | **直接执行** |
| **长任务**，接口一般 1–30 秒返回 | **直接执行** | **队列** |
| **长任务**，接口一般 30 秒以上返回 | 都只能跑很少次数，量大请升级 Paid（见下文） | **队列** |
| 长任务不能被部署打断 | 队列（注意每天约 3,300 次的上限） | **队列** |

原因：

- **短任务都选 Worker 异步**：等待不花钱，每百万次约 $0.45，和接口快慢无关；Free 套餐下也不占 Queue 和 DO 运行时长的额度。唯一更便宜的情况是 Paid 套餐、接口 0.3 秒内返回时的直接执行，但每百万次只差不到 $0.3，不值得分开配置。
- **长任务在 Free 套餐选直接执行**：Queue 的免费额度每天只够约 3,300 次，直接执行每天约 1.6 万次（接口越慢越少，见下文）。
- **长任务在 Paid 套餐按接口快慢选**：直接执行按等待时间计费，约每秒每百万次 $1.56；队列是固定的每百万次约 $1.5。所以接口 1 秒以内返回选直接执行，更慢选队列。
- **部署打断**：Worker 异步和直接执行都在后台发请求，部署时可能被中断（这次执行会被记为失败）。部署频繁、而长任务又不能失败时，选队列更稳。

### 执行方式与超时

全局默认是 Worker 异步，可在设置页修改；新任务的执行方式默认是「跟随全局」。执行方式只由任务配置和全局配置决定，不会根据超时、接口实际耗时或 Queue 是否可用自动切换。

| 配置的执行方式 | 保存校验 | 执行时的请求超时 |
|---|---|---|
| Worker 异步（显式选择，或跟随当前全局 `worker`） | 超过 25 秒返回 422 | 任务超时与 25 秒的较小值 |
| 队列（显式选择，或跟随当前全局 `queue`） | 未配置 Queue 返回 422 | 任务设置的超时，最多 300 秒 |
| 直接执行（显式选择，或跟随当前全局 `direct`） | 超时最多 300 秒 | 任务设置的超时 |

如果先保存了超时 60 秒、跟随全局的任务，之后把全局改为 `worker`，这个任务仍按配置走 Worker 异步，但每次请求最多执行 25 秒；不会修改已保存的 60 秒，也不会改走队列或直接执行。达到实际超时还没返回时，请求被中止、执行记为超时失败，后续按任务设置重试，重试仍走 Worker 异步并遵守同样的上限。设置了更短超时（如 10 秒）时，仍按更短的值执行。

需要执行超过 25 秒的任务时，应明确选择队列或直接执行：

- **Free 套餐**：可以删掉 `queues` 配置段，长任务单独选「直接执行」，部署时不用创建队列。
- **Paid 套餐**：保留 `queues`，长任务单独选「队列」；接口 1 秒以内返回的长任务，也可以选「直接执行」节省费用。

如果配置了队列执行，之后移除了 Queue 绑定，执行会报错，不会自动改成直接执行。

执行记录保存最后一次尝试的实际执行方式和生效超时，不随之后的全局设置变化。重试动作与本次结果一起写入 D1；投递失败后会补投，沿用原执行方式及重试时间，不重复执行已完成的尝试。

最终失败告警也先持久化，再由独立 Worker 发送，不占用任务请求的 25 秒上限所在的后台执行窗口。告警目标和模板取失败时的配置；单次发送最多 10 秒，失败后间隔 30、60 秒重试，最多发送 3 次。中断后的投递由每 5 分钟的维护任务恢复。投递采用至少一次语义：发送成功但确认写入前中断时，可能重复，接收端可按 `run.id` 去重。

**通过 cf-sender 发告警**：部署 [cf-sender](../cf-sender) 后，取消 wrangler.jsonc 里 `services` 一段的注释（绑定名 `SENDER`，入口 `SenderRpc`），运行 `pnpm cf-typegen` 再部署。之后可以在「设置 → 全局失败告警」选择「CF Sender」并填写主题，或在任务里选「cf-sender 主题」，告警会以 Markdown 扇出到该主题的飞书、Telegram、邮件等渠道。调用带 `yunji-task:alert:<run.id>` 幂等键，重试不会重复发送。全局告警方式可明确选择 Webhook、CF Sender 或关闭，按所选方式发送；缺少 SENDER 绑定时会明确失败。Webhook 默认提供 [Bark](https://github.com/Finb/Bark/blob/master/docs/en-us/tutorial.md) JSON 模板，推送地址可填写 `https://api.day.app/{{BARK_KEY}}`，并在「变量」中保存 `BARK_KEY`。

**成功判定**：创建或编辑任务时，可以选择简单模式或高级模式。简单模式要求 HTTP 2xx，填写成功关键字后还需响应体包含该字符串。高级模式支持响应码等于／不等于／范围、响应正文等于／包含，以及 JSON 字段的等于、包含、大小比较、存在性判断；多个条件可选「全部满足（AND）」或「任一满足（OR）」。高级模式只按所配置的条件判断，若需要限定 2xx，请保留默认的响应码 200–299 条件。

例如接口返回 `{"code":0,"data":{"status":"done"}}`，可以配置「响应码 200–299」且「JSON 字段 `code` 等于数字 `0`」且「JSON 字段 `data.status` 等于字符串 `done`」。路径也支持 `data.items[0].id` 和根节点 `$`；数字 `0` 与字符串 `"0"` 不相等。包含比较区分大小写，支持字符串子串或 JSON 数组中的单个标量值。字段缺失时只有「不存在」成立；`null` 视为字段存在。

API 中的高级条件放在 `executor.config.successCondition`（最多 20 条），不设置该字段即为简单模式。例如：

```json
{
  "match": "all",
  "rules": [
    { "type": "status", "operator": "between", "value": 200, "valueTo": 299 },
    { "type": "json", "path": "code", "operator": "eq", "value": 0 },
    { "type": "json", "path": "data.status", "operator": "eq", "value": "done" }
  ]
}
```

没有正文校验时只读取日志需要的前 4 KiB（另读 1 字节判断是否截断）；简单模式的成功关键字扫描前 1 MiB。高级模式的正文／JSON 条件要求完整响应不超过 1 MiB，超出大小、JSON 无法解析或条件未命中时，该条条件不成立，失败记录会显示具体原因。响应日志仍最多保存 4 KiB。

编辑页会根据任务的超时和近 7 天的 P95 耗时给出建议，并估算每百万次的费用。只给建议，不会自动切换。

### Free 套餐的额度

Free 套餐的额度按天计算（每天北京时间 08:00 重置），用完后当天剩下的执行会直接失败。三种方式每天最多能跑多少次：

| 限制（每天） | Worker 异步 | 队列 | 直接执行 |
|---|---|---|---|
| Queue 操作 1 万次（每次执行 3 次） | 不占用 | **约 3,300 次** | 不占用 |
| D1 写入 10 万行（每次执行约 6 行） | **约 1.6 万次** | 约 1.6 万次 | 约 1.6 万次 |
| DO 运行时长 13,000 GB-s | 几乎不占用 | 几乎不占用 | **约 10.4 万次 ÷ 接口秒数** |
| Worker 请求 10 万次 | 约 10 万次 | 约 10 万次 | 不占用 |

几点说明：

- 粗体是每种方式最先用完的那项。**这些额度是所有任务合计的**：比如 D1 的 1.6 万次是全部任务加起来，不是每种方式各 1.6 万次。
- D1 的约 6 行按同一任务在一分钟内有多次执行估算；每个任务在该分钟首次写入统计时多一行索引。低频任务约 7 行／次，对应每天约 1.4 万次，其他写入与维护还会占用额度。
- 直接执行的上限随接口变慢而下降：6 秒以内的接口约 1.6 万次（D1 先用完），10 秒约 1 万次，30 秒约 3,500 次，60 秒约 1,700 次。所以接口超过约 30 秒时，队列（3,300 次）反而能跑更多；但两者都很少，这种任务量大时应该用 Paid。

举例：

- 10 个短任务每 5 分钟一次：每天约 2,900 次，每次都创建新的分钟统计行，Worker 异步用掉约 2 万行 D1 写入，远在额度内。
- 1 个每 10 秒一次的任务：每天约 8,600 次。短任务用 Worker 异步、长任务用直接执行都够，用队列不够。
- 1 个每秒一次的任务：每天 8.6 万次，超过 D1 的 1.6 万次，哪种方式都不够，需要 Paid。

### Paid 套餐的费用

Paid 套餐每月 $5 起，额度按月计算，超出后按量计费。执行量不大时都在额度内，**不额外花钱**：

- Worker 异步：主要占用 Worker 请求（每月 1,000 万次）和 DO 请求（每月 100 万次，每次执行 2 次，约够 50 万次执行）。
- 队列：Queue 每月 100 万次操作，约够 **33 万次执行**。
- 直接执行：DO 每月 40 万 GB-s，约够 **320 万次执行 ÷ 接口秒数**（1 秒约 320 万次，3.4 秒约 94 万次）。

超出额度后，每百万次执行的边际成本：

| 接口一般多久返回 | Worker 异步（仅短任务） | 队列 | 直接执行 |
|---|---|---|---|
| 0.1 秒 | 约 $0.45 | 约 $1.5 | 约 $0.16 |
| 0.5 秒 | 约 $0.45 | 约 $1.5 | 约 $0.78 |
| 1 秒 | 约 $0.45 | 约 $1.5 | 约 $1.56 |
| 3 秒 | 约 $0.45 | 约 $1.5 | 约 $4.7 |
| 10 秒 | 约 $0.45 | 约 $1.5 | 约 $15.6 |
| 60 秒 | — | 约 $1.5 | 约 $94 |

（共同的 D1 写入、调度闹钟等费用不计入。数字来自 Cloudflare 官方价格：Worker 请求 $0.30 / 百万次，DO 请求 $0.15 / 百万次，Queue $0.40 / 百万次操作，DO 运行时长 $12.50 / 百万 GB-s。）

举例：一个长任务每分钟一次、接口一般 5 秒返回，每月约 4.3 万次。直接执行每月约 $0.34，队列约 $0.06，且都还在每月额度内；量再大 100 倍、按超出额度的价格算，差别才变成每月约 $34 对约 $6.5。

### 其他差异

- **计费有两点待确认**：DO 调用 Worker 是否算一次 Worker 请求（上面按算来估），以及 Worker 后台等待是否确实只按 CPU 计费（Workers 的计费规则是这样，但官方文档没有专门说明这种情况）。部署后请在 Cloudflare 后台核对用量。
- **部署时**：Worker 异步和直接执行的请求都在后台进行，部署或运行时更新时可能被中断，15 分钟内由对账任务标记为失败。队列方式下 Worker 也可能被中断，结果相同，只是更少见。不希望部署打断执行的长任务，选队列更稳。
- **没有配置 Queue 时**：保存任务时选「队列」会被拒绝；已有任务执行时缺少 Queue 绑定会明确报错，不会自动切换执行方式。
- **额度按账号共享**：同一个 Cloudflare 账号下所有 Workers 项目共用这些额度，上面的估算假设只有云吉 Task 在用。维护任务每 5 分钟只补同步未成功的任务版本，每小时全量对账修复丢失的 alarm（100 个稳定任务每月约 7.2 万次 DO 对账请求，另加修改、重试投递和告警的请求）。

## API 速查

| 方法 | 路径 | 说明 |
|---|---|---|
| GET / POST | `/api/tasks` | 列表 / 创建 |
| GET / PUT / DELETE | `/api/tasks/:id` | 查看 / 全量更新 / 删除 |
| POST | `/api/tasks/:id/enable` · `/disable` · `/trigger` | 启用 / 停用 / 手动触发 |
| GET | `/api/tasks/:id/runs?limit=50&before=<nextBefore>` | 执行记录（分页；将上页返回的 `nextBefore` URL 编码后原样传回，包含时间戳与 ID） |
| GET | `/api/runs/:id` | 单次执行 |
| GET · PUT · DELETE | `/api/variables` · `/api/variables/:name` | 加密变量（值不返回） |
| GET · PUT | `/api/settings/alert` | 全局告警 |
| GET · PUT | `/api/settings/runtime` | 全局执行方式、日志与统计保留天数 |
| GET | `/api/stats/overview?range=24h\|7d\|30d\|90d&tz=Asia/Shanghai` | 全局统计：汇总、时间序列、失败最多 / 最慢的任务 |
| GET | `/api/tasks/:id/stats?range=…&tz=…` | 单任务统计，附耗时分布 |

统计按 UTC 分钟预聚合，查询时在数据库内合并成小时或当地自然日，支持半小时、45 分钟及固定分钟偏移的时区；不依赖执行日志是否仍保留。每个有执行结果的任务／分钟最多一条统计行，图表返回点数不增加。高频任务的统计存储和查询扫描量最多为原小时聚合的 60 倍，可在设置页调整统计保留天数；每条执行仍只更新一条聚合记录，每个任务在该分钟首次写入统计时多写一条时间索引。

```sh
curl -X POST https://<host>/api/tasks -H "Authorization: Bearer $API_TOKEN" -H 'content-type: application/json' -d '{
  "name": "每 10 秒心跳",
  "schedule": { "type": "cron", "cron": "*/10 * * * * *", "timezone": "Asia/Shanghai" },
  "executor": { "type": "http", "config": { "url": "https://example.com/ping", "headers": { "Authorization": "Bearer {{PING_TOKEN}}" } } },
  "retry": { "count": 2, "intervalSeconds": 30 },
  "executionMode": "inherit"
}'
```
