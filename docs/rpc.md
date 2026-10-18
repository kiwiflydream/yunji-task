# RPC 任务

[返回 README](../README.md)

RPC 任务通过 Cloudflare Service Binding 调用同账号下另一个 Worker 的公开方法。Task 负责调度、重试、日志和告警，具体业务由目标 Worker 实现。

## 1. 在目标 Worker 暴露方法

以下是一个可用于验证接入的目标 Worker，实际业务可增加自己的公开方法：

```ts
import { WorkerEntrypoint } from 'cloudflare:workers'

export class TaskMethods extends WorkerEntrypoint {
  async echo(value: unknown) {
    return { ok: true, received: value }
  }
}

export default {
  fetch() {
    return new Response('RPC service')
  },
}
```

先部署目标 Worker，例如名称为 `my-website`。方法参数使用 JSON 数据，返回值使用 JSON 数据或不返回值；异常会被 Task 记录为失败。Task 当前不支持返回流、函数、RpcTarget、Date、BigInt 或循环引用。

## 2. 配置 Task 的服务绑定

在 Task 的 `wrangler.jsonc` 中合并以下配置，保留其他已有绑定和变量：

```json
{
  "services": [
    { "binding": "WEBSITE", "service": "my-website", "entrypoint": "TaskMethods" }
  ],
  "vars": {
    "RPC_BINDINGS": "WEBSITE"
  }
}
```

`service` 是目标 Worker 名称，`entrypoint` 是导出的类名，`binding` 是 Task 中使用的绑定名称。`RPC_BINDINGS` 是允许 RPC 任务使用的服务绑定列表，多个名称用逗号分隔，例如 `WEBSITE,SENDER`。默认空列表，不开放任何服务。

只向可信的目标服务提供调用权限。数据库、队列、静态资源和 Task 调度器等内部绑定不能作为 RPC 目标。RPC 任务不使用目标服务的 HTTP API Key，任务创建与编辑权限本身就包含调用已开放服务公开方法的权限。

更新绑定后重新生成类型并部署 Task：

```sh
pnpm cf-typegen
pnpm run deploy
```

新增、修改服务绑定或开放列表需要重新部署 Task。目标 Worker 在同一入口下新增业务方法时，只需部署目标 Worker，再修改 Task 的任务配置，无需修改 Task 执行器代码。

## 3. 创建任务

在「新建任务 › 任务类型」选择「RPC 调用」，填写：

| 字段 | 示例 | 说明 |
| --- | --- | --- |
| 服务绑定 | `WEBSITE` | 从部署时已开放且实际存在的服务中选择 |
| RPC 方法 | `echo` | 顶层公开方法名，以字母开头，只含字母、数字、下划线 |
| 参数（JSON 数组） | `[{"message":"hello"}]` | 按顺序展开为方法参数，无参数填 `[]` |
| 超时 | 25 秒 | Task 等待本次调用结果的时限 |

保存后点击「立即执行」，示例返回 `{"ok":true,"received":{"message":"hello"}}`。RPC 执行记录的 HTTP 状态为空，返回值记录在响应正文中。

通过 REST API 创建的对应任务为：

```json
{
  "name": "RPC 示例",
  "schedule": { "type": "manual" },
  "executor": {
    "type": "rpc",
    "config": {
      "binding": "WEBSITE",
      "method": "echo",
      "args": [{ "message": "hello" }],
      "timeoutMs": 25000
    }
  }
}
```

任务 API 的认证方式与 HTTP 任务相同，见[使用指南](usage.md)。`fetch`、`connect`、`constructor`、`then` 等保留方法及嵌套方法路径不能调用。参数最多 50 项，序列化后最多 64 KiB，嵌套不超过 32 层；模板展开后仍检查大小。

## 变量与幂等

参数中的字符串支持加密变量引用，例如 `[{"token":"{{TOKEN}}"}]`。替换发生在字符串值中，数字、布尔值和 JSON 结构保持原类型，变量中的引号不会破坏 JSON。

还支持以下内置字符串变量，无需在变量页创建：

| 变量 | 值 |
| --- | --- |
| `{{task.id}}` | 任务 ID |
| `{{run.id}}` | 本次执行 ID，同一次执行的各次重试保持不变 |
| `{{run.attempt}}` | 当前尝试次数，从 1 开始 |

例如向业务方法传入 `[{"requestId":"{{run.id}}","batchSize":100}]`，由业务侧使用 `requestId` 去重。日志会对使用到的加密变量值脱敏。

## 成功条件与超时

默认正常返回即成功，包括返回 `false`、`null` 或不返回值；抛出异常和超时算失败。需要判断业务结果时，使用高级模式的 JSON 字段条件，例如要求 `ok` 等于布尔值 `true`。RPC 高级模式只支持 JSON 条件，不支持 HTTP 状态码或正文条件。

返回值最多 1 MiB，嵌套不超过 32 层，执行日志最多保存前 4 KiB。成功条件基于完整返回值判断，超过返回值上限或不能编码为 JSON 时记录失败。

三种执行方式均支持 RPC：Worker 异步最多等待 25 秒，队列和直接执行最多等待 300 秒。切换全局执行方式后的超时收紧规则与 HTTP 任务一致，见[执行方式与费用](execution.md)。

RPC 超时结束 Task 本次等待，并释放调用资源，但不能保证目标业务已停止或撤销副作用。重试可能与远端仍在执行的操作重叠，业务方法应自行保证幂等。目标 Worker 的 CPU、平台运行限制与配额仍独立适用，Task 的超时设置不会放宽它们。

Cloudflare 接入机制见 [Service Binding RPC 官方文档](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)。
