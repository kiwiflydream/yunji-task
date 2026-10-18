# 云吉 Task · Yunji Task

部署在 Cloudflare 上的轻量 HTTP 与 Worker RPC 定时任务管理工具。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kiwiflydream/yunji-task)

把接口心跳、数据同步、缓存刷新等定时请求放到一个后台管理，查看每次执行的结果、耗时和失败原因，并在最终失败时接收通知。无需维护常驻服务器。

[快速部署](#快速部署) · [使用指南与 API](docs/usage.md) · [执行方式与费用](docs/execution.md) · [本地开发](docs/development.md)

## 功能

- **灵活调度**：支持秒级 Cron、指定时间执行一次，以及手动或 API 触发，可为任务设置时区。
- **Worker RPC**：定时调用已绑定 Worker 的公开方法，支持 JSON 参数、返回值条件和执行幂等键。
- **HTTP 请求**：配置请求方法、请求头、正文和超时，通过状态码、关键字或 JSON 字段判断是否成功。
- **调用保护**：恢复投递有次数和期限上限，默认单任务每天最多 1 万次、全系统每天最多 10 万次，可在「设置 › 执行安全」调整额度或紧急暂停，并拦截递归触发，见[配置说明](docs/execution.md#调用保护与紧急暂停)。
- **失败处理**：设置重试次数和间隔，选择上次执行未结束时跳过或并行运行。
- **记录与统计**：查看执行日志、成功率、耗时分布和调度延迟，分别设置日志与统计的保留时间。
- **失败通知**：通过 Webhook 发送通知，也可接入云吉 Sender，将告警发到指定渠道组。
- **凭据管理**：加密保存任务变量，在请求和告警中引用；后台推荐使用 Cloudflare Access 登录，也支持 Basic 认证。
- **管理界面**：支持简体中文、English、深浅色主题和移动端，也可通过 REST API 管理任务。

## 快速部署

点击上方 **Deploy to Cloudflare** 按钮进入部署向导，按提示连接 GitHub、选择 Cloudflare 账号并填写密钥。部署命令使用 `pnpm run deploy`，以完成构建、D1 数据库迁移和 Worker 发布。正式使用前，请按下方第 5 步配置 **Cloudflare Access** 后台登录。

如果希望在本地通过命令行部署，按以下步骤操作。

准备一个 Cloudflare 账号，以及 Node.js 22.x（22.12 及以上）或 24.x、pnpm 10。下载或克隆本项目后，在项目目录操作。

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

使用推荐的 Cloudflare Access 登录方式时，设置以下两个密钥：

```sh
pnpm exec wrangler secret put API_TOKEN
pnpm exec wrangler secret put ENCRYPTION_KEY
```

首次设置时，如果提示创建同名 Worker，确认创建后继续即可。

| 密钥 | 用途 | 设置方式 |
| --- | --- | --- |
| `API_TOKEN` | REST API 访问令牌 | 用 `openssl rand -hex 32` 生成 |
| `ENCRYPTION_KEY` | 加密任务变量 | 用 `openssl rand -base64 32` 生成，并妥善备份 |

`ENCRYPTION_KEY` 丢失或更换后，原有加密变量将无法解密。本地开发使用的 `.dev.vars` 不会自动上传为线上密钥。

### 5. 配置后台登录（推荐 Cloudflare Access）

**正式部署推荐使用 Cloudflare Access**，由访问策略限制哪些人可以进入后台。本项目会验证 Access 签发的登录凭证；启用此模式后，无需设置 `ADMIN_PASSWORD`。

1. 在 Cloudflare Zero Trust 中创建 **Self-hosted** 应用，为实际使用的后台域名配置访问规则，覆盖 `/admin` 和所有子路径，包括 `/admin/api/*`。
2. 设置 Allow 策略，只允许自己的邮箱或指定团队成员，并配置登录方式。
3. 获取团队域名和该应用的 **Application Audience（AUD）**，修改 [wrangler.jsonc](wrangler.jsonc) 中已有的 `vars` 字段，保留其他配置：

   | 变量 | 值 |
   | --- | --- |
   | `ADMIN_AUTH_MODE` | `access` |
   | `ACCESS_TEAM_DOMAIN` | 团队域名，例如 `myteam.cloudflareaccess.com`，不含 `https://` |
   | `ACCESS_AUD` | 上述 Access 应用的 AUD tag |

Access 入口策略与应用内配置需要同时完成。仓库为方便本地启动，仍以 `basic` 为默认值；正式部署请按上表切换。创建应用的具体步骤见 [Cloudflare 官方指南](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)。

此处的 Access 规则用于后台，`/api/*` 仍通过 `API_TOKEN` 鉴权。如果另行用 Access 保护整个域名，脚本调用 API 也需要满足对应的 Access 策略。

<details>
<summary>可选：本地开发或临时体验使用 Basic 认证</summary>

保留 `ADMIN_AUTH_MODE=basic`，设置后台密码：

```sh
pnpm exec wrangler secret put ADMIN_PASSWORD
```

部署后使用 `ADMIN_USERNAME`（默认 `admin`）和该密码登录。本地开发则在 `.dev.vars` 中设置密码，见[本地开发指南](docs/development.md)。

</details>

### 6. 部署并打开后台

```sh
pnpm run deploy
```

此命令会构建前后端、应用尚未执行的 D1 迁移，再发布 Worker。部署完成后，打开已配置 Access 保护的后台地址，例如 `https://tasks.example.com/admin`，按 Access 页面提示登录。通过访问策略后即可进入系统；若选择了 Basic 方式，则使用配置的用户名和密码登录。

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
