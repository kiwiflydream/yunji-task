# 云吉 Task · Yunji Task

部署在 Cloudflare 上的轻量 HTTP 定时任务管理工具。

把接口心跳、数据同步、缓存刷新等定时请求放到一个后台管理，查看每次执行的结果、耗时和失败原因，并在最终失败时接收通知。无需维护常驻服务器。

[快速部署](#快速部署) · [使用指南与 API](docs/usage.md) · [执行方式与费用](docs/execution.md) · [本地开发](docs/development.md)

## 功能

- **灵活调度**：支持秒级 Cron、指定时间执行一次，以及手动或 API 触发，可为任务设置时区。
- **HTTP 请求**：配置请求方法、请求头、正文和超时，通过状态码、关键字或 JSON 字段判断是否成功。
- **失败处理**：设置重试次数和间隔，选择上次执行未结束时跳过或并行运行。
- **记录与统计**：查看执行日志、成功率、耗时分布和调度延迟，分别设置日志与统计的保留时间。
- **失败通知**：通过 Webhook 发送通知，也可接入云吉 Sender，将告警发到指定渠道组。
- **凭据管理**：加密保存任务变量，在请求和告警中引用；后台支持 Basic 认证或 Cloudflare Access。
- **管理界面**：支持简体中文、English、深浅色主题和移动端，也可通过 REST API 管理任务。

## 快速部署

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

分别执行以下命令，按提示输入密钥：

```sh
pnpm exec wrangler secret put ADMIN_PASSWORD
pnpm exec wrangler secret put API_TOKEN
pnpm exec wrangler secret put ENCRYPTION_KEY
```

首次设置时，如果提示创建同名 Worker，确认创建后继续即可。

| 密钥 | 用途 | 设置方式 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 管理后台登录密码 | 设置独立的强密码，默认用户名为 `admin` |
| `API_TOKEN` | REST API 访问令牌 | 用 `openssl rand -hex 32` 生成 |
| `ENCRYPTION_KEY` | 加密任务变量 | 用 `openssl rand -base64 32` 生成，并妥善备份 |

`ENCRYPTION_KEY` 丢失或更换后，原有加密变量将无法解密。本地开发使用的 `.dev.vars` 不会自动上传为线上密钥。

### 5. 部署并打开后台

```sh
pnpm deploy
```

此命令会构建前后端、应用尚未执行的 D1 迁移，再发布 Worker。部署完成后，打开输出地址的 `/admin`，使用 `admin` 和刚设置的 `ADMIN_PASSWORD` 登录。

## 创建第一个任务

1. 在「任务」页点击「新建任务」，填写任务名称和自己的 HTTP 接口地址。
2. 选择 Cron 调度，例如 `0 */5 * * * *` 表示每 5 分钟执行一次，并确认时区。
3. 保持默认的「跟随全局」执行方式，先将请求超时设置在 25 秒以内，然后保存。
4. 在任务菜单中点击「立即执行」，到任务详情查看执行记录。

需要认证的接口，可先在「变量」页保存令牌，再在请求头中填写 `Authorization: Bearer {{TOKEN_NAME}}`。最终失败后的通知方式可在「设置」页统一配置，也可由任务单独指定。

## 选择执行方式

默认使用 **Worker 异步**。请求需要等待更久时，再为该任务选择队列或直接执行。

| 方式 | 单次请求超时上限 | 适用情况 |
| --- | --- | --- |
| Worker 异步 | 25 秒 | 日常短请求，默认选项 |
| 队列 | 300 秒 | 需要更长等待时间，并希望由队列投递的任务 |
| 直接执行 | 300 秒 | 不配置 Queue，由调度器直接请求接口 |

执行方式由任务和全局设置决定，不会根据接口耗时自动切换。平台额度、计费差异和部署中断的处理见[执行方式与费用](docs/execution.md)。

## 文档

- [使用指南与 API](docs/usage.md)：调度规则、成功条件、变量、通知、认证和接口示例。
- [执行方式与费用](docs/execution.md)：三种执行方式、超时限制、恢复行为及 Cloudflare 计费说明。
- [本地开发与验证](docs/development.md)：开发环境、测试命令、构建和项目结构。
- [架构设计](docs/design.md)：调度器、执行状态、幂等与统计实现。

## 使用边界

云吉 Task 当前执行 HTTP 请求，单次请求最长 300 秒。秒级 Cron 表示支持按秒配置计划，实际触发仍受平台调度和网络影响；错过的周期触发不会补跑。

部署或运行时更新可能打断进行中的请求。接收任务请求的业务接口应处理自身的幂等与重复调用，执行记录和失败重试不能代替业务事务。
