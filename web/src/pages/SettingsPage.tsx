import { Button, Input, InputArea, LayerCard, Text, useKumoToastManager } from '@cloudflare/kumo'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { AlertSettings } from '../../../src/shared/types'
import { api, ApiError, errorMessage } from '../api'
import { DescriptionList } from '../components/DescriptionList'
import { PageHeader } from '../components/PageHeader'
import { ErrorBanner, PageLoader } from '../components/States'

const PLACEHOLDERS = [
  'task.id',
  'task.name',
  'run.id',
  'run.status',
  'run.attempt',
  'run.trigger',
  'run.http_status',
  'run.error',
  'run.finished_at',
]

const FEISHU_EXAMPLE = '{"msg_type":"text","content":{"text":"任务 {{task.name}} 失败：{{run.error}}"}}'

export function SettingsPage() {
  const alert = useQuery({ queryKey: ['alert'], queryFn: api.alert })
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: Infinity })
  return (
    <>
      <PageHeader title="设置" />
      <div className="flex flex-col gap-4">
        {alert.isPending ? (
          <PageLoader />
        ) : alert.isError ? (
          <ErrorBanner error={alert.error} />
        ) : (
          <AlertForm initial={alert.data} />
        )}
        <LayerCard>
          <LayerCard.Secondary>
            <div className="flex flex-col">
              <span>运行配置</span>
              <Text size="xs" variant="secondary">
                来自 wrangler.jsonc 的 vars 和 secrets，修改后重新部署生效。
              </Text>
            </div>
          </LayerCard.Secondary>
          <LayerCard.Primary>
            {me.data ? (
              <DescriptionList
                items={[
                  ['后台认证', me.data.authMode === 'access' ? 'Cloudflare Access（ADMIN_AUTH_MODE=access）' : 'Basic 认证（ADMIN_AUTH_MODE=basic）'],
                  ['当前用户', me.data.user],
                  ['日志保留', `${me.data.retentionDays} 天（RUN_RETENTION_DAYS）`],
                  ['统计保留', `${me.data.statsRetentionDays} 天（STATS_RETENTION_DAYS）`],
                  [
                    '执行方式',
                    me.data.executionMode === 'direct'
                      ? '直接执行：调度器 DO 自己发起请求（EXECUTION_MODE=direct）'
                      : '队列：经 Queue 投递给消费者执行（EXECUTION_MODE=queue）',
                  ],
                ]}
              />
            ) : (
              <PageLoader />
            )}
          </LayerCard.Primary>
        </LayerCard>
      </div>
    </>
  )
}

function AlertForm({ initial }: { initial: AlertSettings }) {
  const [form, setForm] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const toasts = useKumoToastManager()
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: () => api.putAlert(form),
    onSuccess: (saved) => {
      qc.setQueryData(['alert'], saved)
      setError(null)
      toasts.add({ title: '告警设置已保存', variant: 'success' })
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : errorMessage(err)),
  })
  return (
    <LayerCard>
      <LayerCard.Secondary>
        <div className="flex flex-col">
          <span>全局失败告警</span>
          <Text size="xs" variant="secondary">
            任务的告警方式为「使用全局设置」时，最终失败会调用这里的 webhook。
          </Text>
        </div>
      </LayerCard.Secondary>
      <LayerCard.Primary>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
        >
          <Input
            label="Webhook URL（可选）"
            className="font-mono"
            placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/{{FEISHU_HOOK}}"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            description="留空表示不告警。可以用 {{变量名}} 引用加密变量。"
            {...(error ? { error } : {})}
          />
          <InputArea
            label="Body 模板（可选）"
            className="font-mono"
            rows={5}
            value={form.bodyTemplate}
            onChange={(e) => setForm({ ...form, bodyTemplate: e.target.value })}
            description="留空则 POST 默认 JSON。占位符的值会按 JSON 字符串转义。"
          />
          <div className="flex flex-col gap-2 rounded-lg bg-kumo-recessed p-3">
            <Text size="sm" variant="secondary">
              可用占位符
            </Text>
            <div className="flex flex-wrap gap-1.5">
              {PLACEHOLDERS.map((p) => (
                <Text key={p} variant="mono" size="lg" as="code">
                  {`{{${p}}}`}
                </Text>
              ))}
            </div>
            <Text size="sm" variant="secondary">
              飞书机器人示例：
            </Text>
            <Text variant="mono" as="pre">
              {FEISHU_EXAMPLE}
            </Text>
            <div>
              <Button type="button" size="sm" onClick={() => setForm({ ...form, bodyTemplate: FEISHU_EXAMPLE })}>
                使用飞书模板
              </Button>
            </div>
          </div>
          <div>
            <Button type="submit" variant="primary" loading={save.isPending}>
              保存
            </Button>
          </div>
        </form>
      </LayerCard.Primary>
    </LayerCard>
  )
}
