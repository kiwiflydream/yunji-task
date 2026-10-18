# 云吉 Task · Yunji Task

部署在 Cloudflare 上的轻量 HTTP 与 Worker RPC 定时任务管理工具。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kiwiflydream/yunji-task)

把接口心跳、数据同步、缓存刷新等定时请求放到一个后台管理，查看每次执行的结果、耗时和失败原因，并在最终失败时接收通知。无需维护常驻服务器。

[快速部署](#快速部署) · [配置总览](#配置总览) · [使用指南与 API](docs/usage.md) · [执行方式与费用](docs/execution.md) · [本地开发](docs/development.md)

## 功能

- **灵活调度**：支持秒级 Cron、指定时间执行一次，以及手动或 API 触发，可为任务设置时区。
- **Worker RPC**：定时调用已绑定 Worker 的公开方法，支持 JSON 参数、返回值条件和执行幂等键。
- **HTTP 请求**：配置请求方法、请求头、正文和超时，通过状态码、关键字或 JSON 字段判断是否成功。
- **调用保护**：恢复投递有次数和期限上限，默认单任务每天最多 1 万次、全系统每天最多 10 万次，可在「设置 › 执行安全」调整额度或紧急暂停，并拦截递归触发，见[配置说明](docs/execution.md#调用保护与紧急暂停)。
- **失败处理**：设置重试次数和间隔，选择上次执行未结束时跳过或并行运行。
- **记录与统计**：查看执行日志、成功率、耗时分布和调度延迟，分别设置日志与统计的保留时间。
- **失败通知**：通过 Webhook 发送通知，也可接入云吉 Sender，将告警发到指定渠道组。
- **凭据管理**：加密保存任务变量，在请求和告警中引用；后台默认使用 Basic 认证，可按需切换 Cloudflare Access。
- **管理界面**：支持简体中文、English、深浅色主题和移动端，也可通过 REST API 管理任务。

## 快速部署

点击上方 **Deploy to Cloudflare** 按钮进入部署向导，按提示连接 GitHub、选择 Cloudflare 账号并填写密钥。部署命令使用 `pnpm run deploy`，以完成构建、D1 数据库迁移和 Worker 发布。首次部署只需填写 `ADMIN_PASSWORD` 和 `ENCRYPTION_KEY`；登录模式 `basic`、用户名 `admin` 保留默认即可。

如果希望在本地通过命令行部署，按以下步骤操作。

准备一个 Cloudflare 账号，以及 Node.js 22.x（22.12 及以上）或 24.x、pnpm 10。下载或克隆本项目后，在项目目录操作。

部署构建使用 `pnpm@10.34.4`（见 `package.json`）。若 Cloudflare 构建日志仍选择 pnpm 9，在 Worker 的 **Builds 构建环境变量**中设置 `PNPM_VERSION=10.34.4` 后重试；它是构建工具配置，不是 Worker 运行时变量。

### 1. 安装依赖并登录

```sh
pnpm install
pnpm exec wrangler login
```

### 2. 创建数据库

```sh
pnpm exec wrangler d1 create yunji-task
```

将命令返回的 `database_id` 填入 [wrangler.jsonc](wrangler.jsonc)，替换原有占位值。

### 3. 创建队列

默认配置包含执行队列和死信队列：

```sh
pnpm exec wrangler queues create yunji-task-runs
pnpm exec wrangler queues create yunji-task-runs-dlq
```

如果只使用 Worker 异步或直接执行，可以删除 `wrangler.jsonc` 中整个 `queues` 配置段，跳过这一步。三种方式的区别见[执行方式与费用](docs/execution.md)。

### 4. 设置密钥

默认使用 Basic 登录，设置以下两个密钥：

```sh
pnpm exec wrangler secret put ADMIN_PASSWORD
pnpm exec wrangler secret put ENCRYPTION_KEY
```

首次设置时，如果提示创建同名 Worker，确认创建后继续即可。

| 密钥 | 用途 | 设置方式 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 后台登录密码 | 设置独立强密码 |
| `ENCRYPTION_KEY` | 加密任务变量 | 用 `openssl rand -base64 32` 生成，并妥善备份 |

`ENCRYPTION_KEY` 丢失或更换后，原有加密变量将无法解密。本地开发使用的 `.dev.vars` 不会自动上传为线上密钥。

### 5. 后台登录与可选配置

默认使用 Basic 认证，用户名为 `admin`，密码为上一步设置的 `ADMIN_PASSWORD`。无需配置 Access 即可打开后台。

需要调用 REST API 时，再用 `openssl rand -hex 32` 生成令牌，并执行 `pnpm exec wrangler secret put API_TOKEN`。只使用后台无需此令牌。RPC 任务需另外添加 `RPC_BINDINGS` 和服务绑定，见 [RPC 接入指南](docs/rpc.md)。

<details>
<summary>可选：切换为 Cloudflare Access</summary>

1. 在 Cloudflare Zero Trust 中创建 **Self-hosted** 应用，为实际使用的后台域名配置访问规则，覆盖 `/admin` 和所有子路径，包括 `/admin/api/*`。
2. 设置 Allow 策略，只允许自己的邮箱或指定团队成员，并配置登录方式。
3. 获取团队域名和该应用的 **Application Audience（AUD）**，在 [wrangler.jsonc](wrangler.jsonc) 的 `vars` 中添加或修改以下字段，保留其他配置：

   | 变量 | 值 |
   | --- | --- |
   | `ADMIN_AUTH_MODE` | `access` |
   | `ACCESS_TEAM_DOMAIN` | 团队域名，例如 `myteam.cloudflareaccess.com`，不含 `https://` |
   | `ACCESS_AUD` | 上述 Access 应用的 AUD tag |

Access 入口策略与应用内配置需要同时完成；切换后无需使用 `ADMIN_PASSWORD`。创建应用的具体步骤见 [Cloudflare 官方指南](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)。

此处的 Access 规则用于后台，`/api/*` 仍通过 `API_TOKEN` 鉴权。如果另行用 Access 保护整个域名，脚本调用 API 也需要满足对应的 Access 策略。

</details>

### 6. 部署并打开后台

```sh
pnpm run deploy
```

此命令会构建前后端、应用尚未执行的 D1 迁移，再发布 Worker。部署完成后，打开部署地址的 `/admin`，使用 `admin` 和设置的后台密码登录；切换为 Access 后则按 Access 页面提示登录。

## 创建第一个任务

1. 在「任务」页点击「新建任务」，填写任务名称和自己的 HTTP 接口地址。
2. 选择 Cron 调度，例如 `0 */5 * * * *` 表示每 5 分钟执行一次，并确认时区。
3. 保持默认的「跟随全局」执行方式，先将请求超时设置在 25 秒以内，然后保存。
4. 在任务菜单中点击「立即执行」，到任务详情查看执行记录。

需要认证的接口，可先在「变量」页保存令牌，再在请求头中填写 `Authorization: Bearer {{TOKEN_NAME}}`。最终失败后的通知方式可在「设置」页统一配置，也可由任务单独指定。

## 设置执行额度

在「设置 › 执行安全」调整「单任务每日上限」「全系统每日上限」，或选择「紧急暂停」，点击「保存执行安全设置」后生效。默认分别为 **10,000 次／天**、**100,000 次／天**。

派发与实际执行尝试分别计数，分别受上述额度限制；失败和重试也消耗执行额度。每天 UTC 00:00（北京时间 08:00）换日，修改设置不会清零当天已用额度。保存时如提示配置冲突，重新加载最新配置后再修改。

紧急暂停会阻止新派发、尚未开始的执行和告警，但不能撤销已经发出的调用。恢复后，维护会分批重新安排定时调度，被终止的执行不会自动补跑。这些是调用次数限制，不是账单金额封顶；详细行为见[调用保护与紧急暂停](docs/execution.md#调用保护与紧急暂停)。

## 选择执行方式

默认使用 **Worker 异步**。请求需要等待更久时，再为该任务选择队列或直接执行。

| 方式 | 单次请求超时上限 | 适用情况 |
| --- | --- | --- |
| Worker 异步 | 25 秒 | 日常短请求，默认选项 |
| 队列 | 300 秒 | 需要更长等待时间，并希望由队列投递的任务 |
| 直接执行 | 300 秒 | 不配置 Queue，由调度器直接请求接口 |

执行方式由任务和全局设置决定，不会根据接口耗时自动切换。平台额度、计费差异和部署中断的处理见[执行方式与费用](docs/execution.md)。

## 配置总览

首次部署只需填写 `ADMIN_PASSWORD` 和 `ENCRYPTION_KEY`，登录模式和用户名保留默认。下表也列出默认模板未启用的可选能力，方便部署后按需添加。

### 环境变量与密钥

普通变量在 `wrangler.jsonc` 的 `vars` 中配置，修改后重新部署；密钥用 `pnpm exec wrangler secret put 名称` 设置，不要写入 Git。也可在 Cloudflare Worker 的变量与密钥页面配置，但应同步普通变量到仓库，避免下次部署覆盖。本地开发统一写入被 Git 忽略的 `.dev.vars`。

| 配置 | 类型 | 默认值 / 填写条件 | 对应功能与用法 |
| --- | --- | --- | --- |
| `ADMIN_AUTH_MODE` | 普通变量 | `basic`；选填 | 后台登录方式，可选 `basic`、`access` |
| `ADMIN_USERNAME` | 普通变量 | `admin`；选填 | Basic 登录用户名，Access 模式不使用 |
| `ADMIN_PASSWORD` | 密钥 | 无默认；Basic 模式必填 | 后台登录密码；Access 模式不使用 |
| `ENCRYPTION_KEY` | 密钥 | 无默认；部署时填写 | 加密任务变量；用 `openssl rand -base64 32` 生成，丢失或更换后旧变量无法解密 |
| `API_TOKEN` | 密钥 | 无默认；调用 REST API 时填写 | 外部程序使用 `Authorization: Bearer 你的令牌`；用 `openssl rand -hex 32` 生成，未配置时 REST API 不可用，后台不依赖它 |
| `ACCESS_TEAM_DOMAIN` | 普通变量 | 未配置；Access 模式必填 | 团队域名，如 `myteam.cloudflareaccess.com`，不含协议或路径 |
| `ACCESS_AUD` | 普通变量 | 未配置；Access 模式必填 | 保护后台的 Access 应用 AUD；还需在 Zero Trust 创建应用及访问策略 |
| `RPC_BINDINGS` | 普通变量 | 未配置，相当于空列表；选填 | 开放给 RPC 任务的服务绑定名称，以英文逗号分隔，如 `WEBSITE,SENDER`；必须同时配置 `services` 绑定，见 [RPC 指南](docs/rpc.md) |

### 后台运行设置

这些值在「设置」页面保存到数据库，保存后生效，无需重新部署。它们不是环境变量，不能通过在 `vars` 中添加同名字段修改。

| 配置字段 | 默认值 | 对应功能 / 可选范围 |
| --- | --- | --- |
| `executionMode` | `worker` | 全局默认执行方式：`worker`、`queue`、`direct`；任务可覆盖，队列模式需要 `RUN_QUEUE` |
| `retentionDays` | `30` | 执行日志保留天数，1–3650 |
| `statsRetentionDays` | `90` | 汇总统计保留天数，1–3650 |
| `paused` | `false` | 执行安全开关；开启后暂停新执行，不能撤回已经发出的请求 |
| `taskDailyLimit` | `10000` | 单任务每日执行额度，1–1000000 |
| `globalDailyLimit` | `100000` | 全系统每日执行额度，1–10000000 |
| 告警 `mode` | `webhook` | 全局失败通知：`webhook`、`sender`、`off`；默认 URL 为空，不发送 Webhook |
| 告警 `url` | 空 | Webhook 接收地址，选择 Webhook 通知时填写 |
| 告警 `bodyTemplate` | Bark JSON 示例 | Webhook 消息正文模板，支持任务、执行及自定义变量 |
| 告警 `senderChannelGroup` | 空 | Sender 通知的渠道组标识；选择 `sender` 时填写，且需绑定 `SENDER` |

每日额度按 UTC 00:00 换日，派发和执行尝试分别计数，失败及重试也会消耗额度。详细计费语义、告警模板及配置 API 见[使用指南](docs/usage.md)和[执行方式与费用](docs/execution.md)。

### Cloudflare 资源与部署设置

这些配置位于 `wrangler.jsonc`，通常保留模板默认值。绑定名称由代码使用，不要只修改名称而不修改代码。

| 配置 / 绑定 | 用途及默认行为 |
| --- | --- |
| `name` | Worker 名称，默认 `yunji-task` |
| `DB` / `d1_databases` | 必需的 D1 数据库，存放任务、变量、日志与额度；命令行部署填写真实 `database_id`，一键部署由向导创建并回填 |
| `TASK_SCHEDULER` / `durable_objects` | 必需的 Durable Object 调度器；保留类名及 `migrations` 声明 |
| `RUN_QUEUE` / `queues` | 可选执行队列，模板已配置；队列默认单批 1 条、最多重试 3 次，并配有死信队列；不使用队列时可删除整个 `queues` 段并重新生成类型 |
| `SENDER` / `services` | 可选的 Yunji Sender 服务绑定，启用 Sender 告警时配置，入口类为 `SenderRpc`；详见[通知配置](docs/usage.md) |
| 自定义 `services` | RPC 任务的目标 Worker 及入口类；绑定名称还需加入 `RPC_BINDINGS` |
| `ASSETS` / `assets` | 后台静态资源及路由；保留 `/admin` 和 `/admin/*` 优先经过 Worker 的规则以执行鉴权 |
| `triggers.crons` | 默认 `*/5 * * * *`，每 5 分钟运行对账、恢复和清理；任务自己的 Cron 在后台单独设置 |
| `observability.enabled` | 默认 `true`，启用 Worker 可观测性日志 |
| `main`、`compatibility_date`、`migrations` | 运行入口、兼容日期及 DO 类迁移声明；属于部署结构，通常无需修改 |

改动资源绑定后运行 `pnpm cf-typegen`，并按部署文档重新发布。不要把 `ENCRYPTION_KEY`、`API_TOKEN` 等密钥放进普通 `vars`。

### 业务配置与浏览器偏好

- **任务**：在任务编辑页配置调度、时区、HTTP/RPC 参数、超时、成功条件、重试、并发策略、执行方式及任务告警，见[使用指南](docs/usage.md)和 [RPC 指南](docs/rpc.md)。
- **加密变量**：在「变量」页保存令牌等值，通过 `{{变量名}}` 引用，不需要为每个变量创建 Worker 环境变量。
- **语言 / 外观**：在「设置」页选择中英文及跟随系统、浅色、深色；只保存在当前浏览器，不改变其他用户的界面或任务配置。

## 文档

- [RPC 任务](docs/rpc.md)：Worker 方法接入、服务绑定、参数、返回值和幂等。
- [使用指南与 API](docs/usage.md)：调度规则、成功条件、变量、通知、认证和接口示例。
- [执行方式与费用](docs/execution.md)：三种执行方式、超时限制、恢复行为及 Cloudflare 计费说明。
- [本地开发与验证](docs/development.md)：开发环境、测试命令、构建和项目结构。
- [架构设计](docs/design.md)：调度器、执行状态、幂等与统计实现。

## 使用边界

云吉 Task 支持 HTTP 请求与已绑定 Worker 的 RPC 方法调用，单次等待最长 300 秒。秒级 Cron 表示支持按秒配置计划，实际触发仍受平台调度和网络影响；错过的周期触发不会补跑。

部署或运行时更新可能打断进行中的请求。接收任务请求的业务接口应处理自身的幂等与重复调用，执行记录和失败重试不能代替业务事务。

## 许可证

本项目采用 [MIT License](LICENSE)。
