# 本地开发与验证

[返回 README](../README.md)

## 启动开发环境

使用 Node.js 22.x（22.12 及以上）或 24.x、pnpm 10。在项目目录执行：

```sh
pnpm install
cp .dev.vars.example .dev.vars
```

按照 [.dev.vars.example](../.dev.vars.example) 填写 `API_TOKEN`、`ENCRYPTION_KEY` 和 `ADMIN_PASSWORD`，再启动本地服务：

```sh
pnpm db:migrate:local
pnpm dev
```

打开 `http://localhost:5173/admin`，使用 `admin` 和 `.dev.vars` 中的 `ADMIN_PASSWORD` 登录。端口被占用时，以 Vite 输出地址为准。本地开发无需 Cloudflare 登录，也无需预先创建线上数据库或队列。

`.dev.vars` 和 `.wrangler` 已被 Git 忽略，不要把真实密钥加入版本管理。本地迁移作用于本地 D1，线上部署通过 `pnpm run deploy` 应用远端迁移。

## 验证命令

| 命令 | 覆盖范围 |
| --- | --- |
| `pnpm typecheck` | Worker、前端和测试三套 TypeScript 配置 |
| `pnpm test` | 在 workerd 中运行 Vitest，包括本地 D1 与 DO 测试 |
| `pnpm test:e2e` | 构建后运行桌面英文、移动端中文浏览器用例，使用模拟 API |
| `pnpm test:smoke` | 构建后启动独立本地 Worker，验证 D1、DO、Queue、HTTP 回调及后台保存 |
| `pnpm build` | 构建 Worker 和静态资源，输出到 `dist/` |
| `pnpm cf-typegen` | 按 Wrangler 配置重新生成 `worker-configuration.d.ts` |

首次运行浏览器测试，先安装 Chromium：

```sh
pnpm exec playwright install chromium
pnpm test:e2e
pnpm test:smoke
```

本机已有 Chrome 时，可以指定浏览器渠道：

```sh
E2E_BROWSER_CHANNEL=chrome pnpm test:e2e
E2E_BROWSER_CHANNEL=chrome pnpm test:smoke
```

E2E 默认端口为 6176，可用 `E2E_PORT` 调整。它通过独立静态服务读取构建后的页面，拦截 API 请求，不读写开发数据库。

冒烟测试使用临时密钥、临时数据库和独立端口，应用完整迁移，覆盖三种方式的一次性调度、队列失败重试、槽位释放、Webhook 告警、加密变量、脱敏、认证、维护和后台连续保存。测试结束后停止 Worker 并清理临时状态，不使用项目的 `.dev.vars` 或开发数据库。页面截图保存到系统临时目录的 `cf-task-full-stack-desktop.png`。

本地测试和部署 dry-run 不代表已验证云端资源绑定或真实通知渠道。发布前还需在目标环境验收实际调度、重试和告警。

## 项目结构

```text
src/
  auth/         后台和 API 认证
  domain/       任务、执行记录、设置、变量与统计
  executor/     HTTP 执行、重试和告警
  scheduler/    每任务一个 Durable Object，使用 alarm 调度
  maintenance/  对账、失联恢复与清理
  routes/       REST API 和后台入口
  shared/       Worker 与前端共用类型
web/src/        React 管理后台
migrations/     D1 迁移
test/           Vitest、Playwright 和本地冒烟测试
```

后端使用 Hono，后台使用 React、Kumo、TanStack Query 和 ECharts，由 Vite 与 Cloudflare Vite 插件构建。调度和执行机制见[架构设计](design.md)。
