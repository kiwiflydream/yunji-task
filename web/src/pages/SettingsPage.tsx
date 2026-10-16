import { Button, Input, InputArea, LayerCard, Radio, Text, useKumoToastManager } from '@cloudflare/kumo'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { AdminMe, AlertSettings, RuntimeSettings } from '../../../src/shared/types'
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
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  return (
    <>
      <PageHeader title="设置" />
      <div className="flex flex-col gap-4">
        {me.isPending ? (
          <PageLoader />
        ) : me.isError ? (
          <ErrorBanner error={me.error} />
        ) : (
          <RuntimeSettingsForm initial={me.data} />
        )}
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
              <span>后台认证</span>
              <Text size="xs" variant="secondary">
                认证配置来自 wrangler.jsonc 的 vars 和 secrets，修改后重新部署生效。
              </Text>
            </div>
          </LayerCard.Secondary>
          <LayerCard.Primary>
            {me.data ? (
              <DescriptionList
                items={[
                  ['后台认证', me.data.authMode === 'access' ? 'Cloudflare Access（ADMIN_AUTH_MODE=access）' : 'Basic 认证（ADMIN_AUTH_MODE=basic）'],
                  ['当前用户', me.data.user],
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

function RuntimeSettingsForm({ initial }: { initial: AdminMe }) {
  const [mode, setMode] = useState(initial.executionMode)
  const [retentionDays, setRetentionDays] = useState(String(initial.retentionDays))
  const [statsRetentionDays, setStatsRetentionDays] = useState(String(initial.statsRetentionDays))
  const [errors, setErrors] = useState<Partial<Record<keyof RuntimeSettings, string>>>({})
  const [error, setError] = useState<string | null>(null)
  const toasts = useKumoToastManager()
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: () => api.putRuntimeSettings({
      executionMode: mode,
      retentionDays: Number(retentionDays),
      statsRetentionDays: Number(statsRetentionDays),
    }),
    onSuccess: (saved) => {
      qc.setQueryData<AdminMe>(['me'], (previous) => previous ? { ...previous, ...saved } : previous)
      setMode(saved.executionMode)
      setRetentionDays(String(saved.retentionDays))
      setStatsRetentionDays(String(saved.statsRetentionDays))
      setErrors({})
      setError(null)
      toasts.add({ title: '运行设置已保存', variant: 'success' })
    },
    onError: (err) => {
      const fields: Partial<Record<keyof RuntimeSettings, string>> = {}
      if (err instanceof ApiError) {
        for (const issue of err.issues) {
          if (issue.path === 'executionMode' || issue.path === 'retentionDays' || issue.path === 'statsRetentionDays') {
            fields[issue.path] = issue.message
          }
        }
      }
      setErrors(fields)
      setError(Object.keys(fields).length ? '保存失败，请检查标出的字段。' : errorMessage(err))
    },
  })
  return (
    <LayerCard>
      <LayerCard.Secondary>
        <div className="flex flex-col">
          <span>运行设置</span>
          <Text size="xs" variant="secondary">
            保存后生效，无需重启或重新部署。
          </Text>
        </div>
      </LayerCard.Secondary>
      <LayerCard.Primary>
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
        >
          <Radio.Group
            legend="全局默认执行方式"
            appearance="card"
            orientation="horizontal"
            value={mode}
            onValueChange={(value) => setMode(value as RuntimeSettings['executionMode'])}
            error={errors.executionMode}
            description="仅影响「跟随全局」任务的新执行；已开始的执行和已安排的重试保持原方式。"
          >
            <Radio.Item label="Worker 异步" value="worker" description="Worker 后台执行，请求超时最高 25 秒" />
            <Radio.Item
              label="队列"
              value="queue"
              disabled={!initial.queueAvailable && mode !== 'queue'}
              description={initial.queueAvailable ? '通过 Queue 投递执行' : '当前部署没有配置 Queue'}
            />
            <Radio.Item label="直接执行" value="direct" description="调度器 DO 发起请求，等待按时长计费" />
          </Radio.Group>
          {mode === 'worker' && (
            <Text size="sm" variant="secondary">
              已有任务的超时即使超过 25 秒，Worker 每次请求仍以 25 秒为上限，不会自动切换执行方式。
            </Text>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="日志保留天数"
              type="number"
              min={1}
              max={3650}
              step={1}
              value={retentionDays}
              onChange={(e) => setRetentionDays(e.target.value)}
              error={errors.retentionDays}
              description="1–3650 天，默认 30 天"
            />
            <Input
              label="统计保留天数"
              type="number"
              min={1}
              max={3650}
              step={1}
              value={statsRetentionDays}
              onChange={(e) => setStatsRetentionDays(e.target.value)}
              error={errors.statsRetentionDays}
              description="1–3650 天，默认 90 天，与日志独立"
            />
          </div>
          <Text size="sm" variant="secondary">
            保留天数由下一轮清理任务使用（每 5 分钟一次）。缩短天数会清理更早的数据，调大天数不会恢复已删除的数据。
          </Text>
          {error && <Text size="sm" variant="error">{error}</Text>}
          <div>
            <Button type="submit" variant="primary" loading={save.isPending}>保存运行设置</Button>
          </div>
        </form>
      </LayerCard.Primary>
    </LayerCard>
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
