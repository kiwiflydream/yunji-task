import { Button, Input, InputArea, LayerCard, Radio, Text, useKumoToastManager } from '@cloudflare/kumo'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { BARK_ALERT_TEMPLATE, type AdminMe, type AlertSettings, type RuntimeSettings } from '../../../src/shared/types'
import { api, ApiError, errorMessage } from '../api'
import { DescriptionList } from '../components/DescriptionList'
import { AlertTemplateHelp } from '../components/AlertTemplateHelp'
import { PageHeader } from '../components/PageHeader'
import { ErrorBanner, PageLoader } from '../components/States'

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
          <AlertForm initial={alert.data} senderAvailable={me.data?.senderAvailable ?? false} />
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

function AlertForm({ initial, senderAvailable }: { initial: AlertSettings; senderAvailable: boolean }) {
  const [form, setForm] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof AlertSettings, string>>>({})
  const toasts = useKumoToastManager()
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: () => api.putAlert(form),
    onSuccess: (saved) => {
      qc.setQueryData(['alert'], saved)
      setForm(saved)
      setError(null)
      setFieldErrors({})
      toasts.add({ title: '告警设置已保存', variant: 'success' })
    },
    onError: (err) => {
      const fields: Partial<Record<keyof AlertSettings, string>> = {}
      if (err instanceof ApiError) {
        for (const issue of err.issues) {
          if (issue.path === 'mode' || issue.path === 'url' || issue.path === 'bodyTemplate' || issue.path === 'senderTopic') {
            fields[issue.path] = issue.message
          }
        }
      }
      setFieldErrors(fields)
      setError(Object.keys(fields).length ? '保存失败，请检查标出的字段。' : errorMessage(err))
    },
  })
  return (
    <LayerCard>
      <LayerCard.Secondary>
        <div className="flex flex-col">
          <span>全局失败告警</span>
          <Text size="xs" variant="secondary">
            任务选择「使用全局设置」时，最终失败按这里选择的方式发送。
          </Text>
        </div>
      </LayerCard.Secondary>
      <LayerCard.Primary>
        <form className="flex flex-col gap-4" noValidate onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
          <Radio.Group
            legend="全局告警方式"
            appearance="card"
            orientation="horizontal"
            value={form.mode}
            onValueChange={(mode) => {
              setForm({ ...form, mode: mode as AlertSettings['mode'] })
              setFieldErrors({})
              setError(null)
            }}
            error={fieldErrors.mode}
          >
            <Radio.Item label="Webhook" value="webhook" description="默认 Bark，也可自定义其他服务" />
            <Radio.Item label="CF Sender" value="sender" description="通过 cf-sender 主题发送到多个渠道" />
            <Radio.Item label="关闭" value="off" description="关闭跟随全局设置的任务告警" />
          </Radio.Group>
          {form.mode === 'sender' && (
            <Input
              label="cf-sender 主题"
              className="font-mono"
              placeholder="ops-alert"
              value={form.senderTopic}
              onChange={(e) => setForm({ ...form, senderTopic: e.target.value })}
              description={senderAvailable
                ? '发送到该主题绑定的所有渠道（Bark、飞书、Telegram、邮件等）。'
                : '当前部署未配置 SENDER 服务绑定，发送会失败。请按 wrangler.jsonc 的 services 说明绑定 cf-sender。'}
              error={fieldErrors.senderTopic}
            />
          )}
          {form.mode === 'webhook' && (
            <>
              <Input
                label="Webhook URL（可选）"
                className="font-mono"
                placeholder="https://api.day.app/{{BARK_KEY}}"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                description="填写 Bark 推送地址，也支持自建 Bark 服务。留空不发送；可用 {{变量名}} 引用加密变量。"
                error={fieldErrors.url}
              />
              <InputArea
                label="Body 模板（可选）"
                className="font-mono"
                rows={6}
                value={form.bodyTemplate}
                onChange={(e) => setForm({ ...form, bodyTemplate: e.target.value })}
                description="默认 Bark JSON 模板；清空后发送通用事件 JSON。占位符的值会按 JSON 字符串转义。"
                error={fieldErrors.bodyTemplate}
              />
              <AlertTemplateHelp />
              <div className="flex flex-col gap-2 rounded-lg bg-kumo-recessed p-3">
                <Text size="sm" variant="secondary">Bark 通知示例：</Text>
                <pre className="font-mono text-xs whitespace-pre-wrap break-all">{BARK_ALERT_TEMPLATE}</pre>
                <div>
                  <Button type="button" size="sm" onClick={() => setForm({ ...form, bodyTemplate: BARK_ALERT_TEMPLATE })}>
                    使用 Bark 模板
                  </Button>
                </div>
              </div>
            </>
          )}
          {error && <Text size="sm" variant="error">{error}</Text>}
          <div>
            <Button type="submit" variant="primary" loading={save.isPending}>保存</Button>
          </div>
        </form>
      </LayerCard.Primary>
    </LayerCard>
  )
}
