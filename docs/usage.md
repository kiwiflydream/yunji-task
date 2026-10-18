# 使用指南与 API

[返回 README](../README.md)

## 调度

| 类型 | 行为 |
| --- | --- |
| Cron | 按 6 段表达式周期执行，顺序为秒、分、时、日、月、周 |
| 一次性 | 在指定时间执行一次，触发后自动停用 |
| 仅手动 / API | 通过后台「立即执行」或 API 触发 |

例如 `*/10 * * * * *` 表示每 10 秒执行，`0 */5 * * * *` 表示每 5 分钟执行。任务可指定 IANA 时区，默认 `Asia/Shanghai`，后台会预览接下来的执行时间。

默认重叠策略为「跳过本次」：上一次执行或重试尚未结束时，不启动新的定时执行。需要允许重叠时，选择「并行执行」。失败重试可设置 0 至 10 次，间隔为 1 至 3600 秒。

## HTTP 请求与成功条件

任务可配置 URL、请求方法、请求头、正文和超时。默认超时为 25 秒，执行方式的限制见[执行方式与费用](execution.md)。

**简单模式**要求 HTTP 2xx；填写成功关键字后，还要求响应正文包含该字符串。

**高级模式**支持响应码、响应正文和 JSON 字段规则，可选择全部满足（AND）或任一满足（OR），最多 20 条。高级模式只判断配置的条件；需要同时限定 HTTP 2xx 时，应保留响应码 200 至 299 的条件。

例如响应为 `{"code":0,"data":{"status":"done"}}`，可将以下对象放入 `executor.config.successCondition`：

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

JSON 路径支持 `data.items[0].id` 和根节点 `$`。数字 `0` 与字符串 `"0"` 不相等，字符串包含判断区分大小写；`null` 视为字段存在。

执行记录最多保存响应正文的前 4 KiB。简单模式的关键字检查扫描前 1 MiB；高级正文或 JSON 条件要求完整响应不超过 1 MiB。响应过大、JSON 无法解析或比较未命中时，对应条件不成立，执行记录会显示原因。

## 加密变量

在「变量」页保存令牌等凭据，通过 `{{变量名}}` 在任务 URL、请求头、正文或告警 URL、正文模板中引用：

```text
Authorization: Bearer {{PING_TOKEN}}
```

变量使用 `ENCRYPTION_KEY` 加密保存，接口不会返回已保存的明文值。执行日志会对已引用的变量值做脱敏。更换加密密钥前，应先安排现有变量的迁移。

## 失败通知

在「设置 › 全局失败告警」选择 Webhook、云吉 Sender 或关闭。任务默认使用全局设置，也可关闭通知，或配置自己的 Webhook、Sender 渠道组。只有最终失败才发送告警，等待重试中的执行不会立即告警。

### Webhook 与 Bark

Webhook 默认提供 Bark JSON 模板，可直接填写自己的 Bark 推送地址，例如 `https://api.day.app/{{BARK_KEY}}`，并在变量页保存 `BARK_KEY`。清空正文模板后，会发送通用的 `task.failed` 事件 JSON。

自定义正文模板可用以下变量，替换值会按 JSON 字符串转义：

```text
{{task.id}}  {{task.name}}
{{run.id}}  {{run.status}}  {{run.attempt}}  {{run.trigger}}
{{run.http_status}}  {{run.error}}  {{run.finished_at}}
```

### 云吉 Sender

先部署云吉 Sender，并创建接收告警的渠道组，再在 `wrangler.jsonc` 中启用 Service Binding：

```json
{
  "services": [
    { "binding": "SENDER", "service": "yunji-sender", "entrypoint": "SenderRpc" }
  ]
}
```

将 `services` 合并到现有配置中，然后执行 `pnpm cf-typegen` 并重新部署。在后台选择「云吉 Sender」并填写渠道组标识，任务告警会通过 `channelGroup` 发往该组绑定的渠道，无需另配 Sender API Key。

任务告警配置为 `{ "mode": "sender", "channelGroup": "ops-alert" }`，全局设置对应字段为 `senderChannelGroup`。旧任务、全局配置和待发送告警中的 `topic`、`senderTopic` 在读取时兼容转换；新旧字段同时提供时，以新字段为准。

告警先保存再投递，发送失败后间隔 30 秒、60 秒重试，最多发送 3 次。Webhook 采用至少一次投递语义，接收端可按 `run.id` 去重；Sender 调用使用 `yunji-task:alert:<run.id>` 幂等键。

## 全局运行设置

「设置 › 运行设置」保存在 D1，修改后无需重启或重新部署：

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| 全局执行方式 | Worker 异步 | 从下一次新触发开始影响「跟随全局」的任务 |
| 日志保留天数 | 30 天 | 可设置 1 至 3650 天 |
| 统计保留天数 | 90 天 | 可设置 1 至 3650 天，与日志独立 |

已开始的执行和已安排的重试保持原执行方式。保留设置由每 5 分钟运行的维护任务读取；缩短保留时间会清理更早的数据，调大后不会恢复已删除的数据。

通过 API 更新运行设置时，PUT 需要提交完整的 `executionMode`、`retentionDays` 和 `statsRetentionDays`。响应同时返回配置和 `version`，尚未保存时版本为 0。

统计按分钟聚合，查询时按小时或当地自然日汇总，包含成功率、耗时分布与调度延迟。删除过期执行日志不会同时删除仍在保留期内的统计。

## 后台认证

默认使用 Basic 认证，用户名为 `wrangler.jsonc` 中的 `ADMIN_USERNAME`，默认 `admin`；密码来自 secret `ADMIN_PASSWORD`。未设置密码时，后台返回 503。

如需 Cloudflare Access，在 Zero Trust 中创建覆盖 `/admin` 及其子路径的 Self-hosted 应用，配置访问策略，并在 `wrangler.jsonc` 的 `vars` 中设置：

| 变量 | 值 |
| --- | --- |
| `ADMIN_AUTH_MODE` | `access` |
| `ACCESS_TEAM_DOMAIN` | 团队域名，如 `myteam.cloudflareaccess.com` |
| `ACCESS_AUD` | 对应应用的 AUD tag |

修改后重新部署。后台认证方式不改变 REST API 的认证要求，`/api/*` 始终使用 Bearer Token。

## REST API

以下示例中的 `TASK_BASE_URL` 是部署后的地址，`API_TOKEN` 是部署时设置的令牌。将示例 URL 替换为自己的任务接口。

```sh
export TASK_BASE_URL="https://your-worker.workers.dev"
export API_TOKEN="your-api-token"

curl "$TASK_BASE_URL/api/tasks" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "每 5 分钟心跳",
    "schedule": { "type": "cron", "cron": "0 */5 * * * *", "timezone": "Asia/Shanghai" },
    "executor": { "type": "http", "config": { "url": "https://example.com/ping" } },
    "retry": { "count": 2, "intervalSeconds": 30 },
    "executionMode": "inherit"
  }'
```

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET / POST | `/api/tasks` | 列出、创建任务 |
| GET / PUT / DELETE | `/api/tasks/:id` | 查看、全量更新、删除任务 |
| POST | `/api/tasks/:id/enable` | 启用任务 |
| POST | `/api/tasks/:id/disable` | 停用任务 |
| POST | `/api/tasks/:id/trigger` | 手动触发一次 |
| GET | `/api/tasks/:id/scheduler` | 查看调度器状态 |
| GET | `/api/tasks/:id/runs` | 分页查询执行记录 |
| GET | `/api/runs/:id` | 查看单次执行 |
| GET | `/api/variables` | 列出变量，不返回明文值 |
| POST / PUT / DELETE | `/api/variables/:name` | 创建、创建或更新、删除变量 |
| GET / PUT | `/api/settings/alert` | 全局告警设置 |
| GET / PUT | `/api/settings/runtime` | 全局运行设置 |
| GET | `/api/stats/overview` | 全局统计 |
| GET | `/api/tasks/:id/stats` | 单任务统计 |

执行记录支持 `limit`，默认 50，最多 200。下一页将响应中的 `nextBefore` 原样作为 `before` 参数并进行 URL 编码，不要截取其中的时间戳，否则同一时间创建的记录可能被漏掉。

统计接口支持 `range=24h|7d|30d|90d` 和 `tz=Asia/Shanghai`，默认范围为 24 小时，默认时区为 UTC。

任务详情及全局运行、告警设置的 GET、PUT 响应包含 `ETag`。更新时在 `If-Match` 中原样传回，例如 `If-Match: "2"`，版本不一致返回 409。未传此请求头时按全量覆盖处理。变量 POST 遇到同名返回 409，PUT 保留创建或更新语义。
