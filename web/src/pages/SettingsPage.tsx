import { SafetySettingsForm } from '../components/SafetySettingsForm'
import { localizeIssueMessage } from '../locale'
import { tr, useLocale } from '../i18n'
import { Button, Input, InputArea, LayerCard, Radio, Text, useKumoToastManager } from '@cloudflare/kumo'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { BARK_ALERT_TEMPLATE, type AdminMe, type AlertSettings, type RuntimeSettings } from '../../../src/shared/types'
import { api, ApiError, errorMessage, type VersionedAlertSettings } from '../api'
import { DescriptionList } from '../components/DescriptionList'
import { AlertTemplateHelp } from '../components/AlertTemplateHelp'
import { PageHeader } from '../components/PageHeader'
import { ErrorBanner, PageLoader } from '../components/States'
import { FORM_CONFLICT_MESSAGE, useVersionedForm } from '../lib/versioned-form'

export function SettingsPage() {
  useLocale()

  const safety = useQuery({ queryKey: ['safety'], queryFn: api.safety, refetchOnMount: 'always', staleTime: 0 })
  const alert = useQuery({ queryKey: ['alert'], queryFn: api.alert, refetchOnMount: 'always', staleTime: 0 })
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, refetchOnMount: 'always', staleTime: 0 })
  return (
    <>
      <PageHeader title={tr("设置")} />
      <div className="flex flex-col gap-4">
        {me.isError && <ErrorBanner error={me.error} />}
        {!me.isFetchedAfterMount && !me.isError ? <PageLoader /> : me.data && (
          <RuntimeSettingsForm initial={me.data} />
        )}
        {safety.isError && <ErrorBanner error={safety.error} />}
        {!safety.isFetchedAfterMount && !safety.isError ? <PageLoader /> : safety.data && (
          <SafetySettingsForm initial={safety.data} />
        )}
        {alert.isError && <ErrorBanner error={alert.error} />}
        {!alert.isFetchedAfterMount && !alert.isError ? <PageLoader /> : alert.data && (
          <AlertForm initial={alert.data} senderAvailable={me.data?.senderAvailable ?? false} />
        )}
        <LayerCard>
          <LayerCard.Secondary>
            <div className="flex flex-col">
              <span>{tr("后台认证")}</span>
              <Text size="xs" variant="secondary">
                {tr("认证配置来自 wrangler.jsonc 的 vars 和 secrets，修改后重新部署生效。")}</Text>
            </div>
          </LayerCard.Secondary>
          <LayerCard.Primary>
            {me.data ? (
              <DescriptionList
                items={[
                  [tr("后台认证"), me.data.authMode === 'access' ? 'Cloudflare Access (ADMIN_AUTH_MODE=access)' : tr("Basic 认证（ADMIN_AUTH_MODE=basic）")],
                  [tr("当前用户"), me.data.user],
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
  useLocale()

  const { value: form, setValue: setForm, version, conflict, reset } = useVersionedForm({
    mode: initial.executionMode,
    retentionDays: String(initial.retentionDays),
    statsRetentionDays: String(initial.statsRetentionDays),
  }, initial.runtimeSettingsVersion)
  const { mode, retentionDays, statsRetentionDays } = form
  const setMode = (mode: RuntimeSettings['executionMode']) => setForm((previous) => ({ ...previous, mode }))
  const setRetentionDays = (retentionDays: string) => setForm((previous) => ({ ...previous, retentionDays }))
  const setStatsRetentionDays = (statsRetentionDays: string) => setForm((previous) => ({ ...previous, statsRetentionDays }))
  const [errors, setErrors] = useState<Partial<Record<keyof RuntimeSettings, string>>>({})
  const [error, setError] = useState<string | null>(null)
  const toasts = useKumoToastManager()
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: () => api.putRuntimeSettings({
      executionMode: mode,
      retentionDays: Number(retentionDays),
      statsRetentionDays: Number(statsRetentionDays),
    }, version),
    onSuccess: ({ settings, version: savedVersion }) => {
      qc.setQueryData<AdminMe>(['me'], (previous) => previous ? { ...previous, ...settings, runtimeSettingsVersion: savedVersion } : previous)
      reset({ mode: settings.executionMode, retentionDays: String(settings.retentionDays), statsRetentionDays: String(settings.statsRetentionDays) }, savedVersion)
      setErrors({})
      setError(null)
      toasts.add({ title: tr("运行设置已保存"), variant: 'success' })
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
      setError(err instanceof ApiError && err.status === 409 ? tr(FORM_CONFLICT_MESSAGE)
        : Object.keys(fields).length ? tr("保存失败，请检查标出的字段。") : errorMessage(err))
    },
  })
  return (
    <LayerCard>
      <LayerCard.Secondary>
        <div className="flex flex-col">
          <span>{tr("运行设置")}</span>
          <Text size="xs" variant="secondary">
            {tr("保存后生效，无需重启或重新部署。")}</Text>
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
            legend={tr("全局默认执行方式")}
            appearance="card"
            orientation="horizontal"
            value={mode}
            onValueChange={(value) => setMode(value as RuntimeSettings['executionMode'])}
            error={localizeIssueMessage(errors.executionMode)}
            description={tr("仅影响「跟随全局」任务的新执行；已开始的执行和已安排的重试保持原方式。")}
          >
            <Radio.Item label={tr("Worker 异步")} value="worker" description={tr("Worker 后台执行，请求超时最高 25 秒")} />
            <Radio.Item
              label={tr("队列")}
              value="queue"
              disabled={!initial.queueAvailable && mode !== 'queue'}
              description={initial.queueAvailable ? tr("通过 Queue 投递执行") : tr("当前部署没有配置 Queue")}
            />
            <Radio.Item label={tr("直接执行")} value="direct" description={tr("调度器 DO 发起请求，等待按时长计费")} />
          </Radio.Group>
          {mode === 'worker' && (
            <Text size="sm" variant="secondary">
              {tr("已有任务的超时即使超过 25 秒，Worker 每次请求仍以 25 秒为上限，不会自动切换执行方式。")}</Text>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label={tr("日志保留天数")}
              type="number"
              min={1}
              max={3650}
              step={1}
              value={retentionDays}
              onChange={(e) => setRetentionDays(e.target.value)}
              error={localizeIssueMessage(errors.retentionDays)}
              description={tr("1–3650 天，默认 30 天")}
            />
            <Input
              label={tr("统计保留天数")}
              type="number"
              min={1}
              max={3650}
              step={1}
              value={statsRetentionDays}
              onChange={(e) => setStatsRetentionDays(e.target.value)}
              error={localizeIssueMessage(errors.statsRetentionDays)}
              description={tr("1–3650 天，默认 90 天，与日志独立")}
            />
          </div>
          <Text size="sm" variant="secondary">
            {tr("保留天数由下一轮清理任务使用（每 5 分钟一次）。缩短天数会清理更早的数据，调大天数不会恢复已删除的数据。")}</Text>
          {conflict && !error && <Text size="sm" variant="error">{tr(FORM_CONFLICT_MESSAGE)}</Text>}
          {error && <Text size="sm" variant="error">{localizeIssueMessage(error)}</Text>}
          <div>
            <Button type="submit" variant="primary" loading={save.isPending}>{tr("保存运行设置")}</Button>
          </div>
        </form>
      </LayerCard.Primary>
    </LayerCard>
  )
}

function AlertForm({ initial, senderAvailable }: { initial: VersionedAlertSettings; senderAvailable: boolean }) {
  useLocale()

  const { value: form, setValue: setForm, version, conflict, reset } = useVersionedForm<AlertSettings>({
    mode: initial.mode, url: initial.url, bodyTemplate: initial.bodyTemplate, senderChannelGroup: initial.senderChannelGroup,
  }, initial.version)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof AlertSettings, string>>>({})
  const toasts = useKumoToastManager()
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: () => api.putAlert(form, version),
    onSuccess: (saved) => {
      qc.setQueryData(['alert'], saved)
      reset({ mode: saved.mode, url: saved.url, bodyTemplate: saved.bodyTemplate, senderChannelGroup: saved.senderChannelGroup }, saved.version)
      setError(null)
      setFieldErrors({})
      toasts.add({ title: tr("告警设置已保存"), variant: 'success' })
    },
    onError: (err) => {
      const fields: Partial<Record<keyof AlertSettings, string>> = {}
      if (err instanceof ApiError) {
        for (const issue of err.issues) {
          if (issue.path === 'mode' || issue.path === 'url' || issue.path === 'bodyTemplate' || issue.path === 'senderChannelGroup') {
            fields[issue.path] = issue.message
          }
        }
      }
      setFieldErrors(fields)
      setError(err instanceof ApiError && err.status === 409 ? tr(FORM_CONFLICT_MESSAGE)
        : Object.keys(fields).length ? tr("保存失败，请检查标出的字段。") : errorMessage(err))
    },
  })
  return (
    <LayerCard>
      <LayerCard.Secondary>
        <div className="flex flex-col">
          <span>{tr("全局失败告警")}</span>
          <Text size="xs" variant="secondary">
            {tr("任务选择「使用全局设置」时，最终失败按这里选择的方式发送。")}</Text>
        </div>
      </LayerCard.Secondary>
      <LayerCard.Primary>
        <form className="flex flex-col gap-4" noValidate onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
          <Radio.Group
            legend={tr("全局告警方式")}
            appearance="card"
            orientation="horizontal"
            value={form.mode}
            onValueChange={(mode) => {
              setForm({ ...form, mode: mode as AlertSettings['mode'] })
              setFieldErrors({})
              setError(null)
            }}
            error={localizeIssueMessage(fieldErrors.mode)}
          >
            <Radio.Item label="Webhook" value="webhook" description={tr("默认 Bark，也可自定义其他服务")} />
            <Radio.Item label={tr("云吉 Sender")} value="sender" description={tr("通过云吉 Sender 渠道组发送到多个渠道")} />
            <Radio.Item label={tr("关闭")} value="off" description={tr("关闭跟随全局设置的任务告警")} />
          </Radio.Group>
          {form.mode === 'sender' && (
            <Input
              label={tr("渠道组标识")}
              className="font-mono"
              placeholder="ops-alert"
              value={form.senderChannelGroup}
              onChange={(e) => setForm({ ...form, senderChannelGroup: e.target.value })}
              description={senderAvailable
                ? tr("发送到该渠道组绑定的所有渠道（Bark、飞书、Telegram、邮件等）。")
                : tr("当前部署未配置 SENDER 服务绑定，发送会失败。请按 wrangler.jsonc 的 services 说明绑定云吉 Sender。")}
              error={localizeIssueMessage(fieldErrors.senderChannelGroup)}
            />
          )}
          {form.mode === 'webhook' && (
            <>
              <Input
                label={tr("Webhook URL（可选）")}
                className="font-mono"
                placeholder="https://api.day.app/{{BARK_KEY}}"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                description={tr("填写 Bark 推送地址，也支持自建 Bark 服务。留空不发送；可用 {{变量名}} 引用加密变量。")}
                error={localizeIssueMessage(fieldErrors.url)}
              />
              <InputArea
                label={tr("Body 模板（可选）")}
                className="font-mono"
                rows={6}
                value={form.bodyTemplate}
                onChange={(e) => setForm({ ...form, bodyTemplate: e.target.value })}
                description={tr("默认 Bark JSON 模板；清空后发送通用事件 JSON。占位符的值会按 JSON 字符串转义。")}
                error={localizeIssueMessage(fieldErrors.bodyTemplate)}
              />
              <AlertTemplateHelp />
              <div className="flex flex-col gap-2 rounded-lg bg-kumo-recessed p-3">
                <Text size="sm" variant="secondary">{tr("Bark 通知示例：")}</Text>
                <pre className="font-mono text-xs whitespace-pre-wrap break-all">{BARK_ALERT_TEMPLATE}</pre>
                <div>
                  <Button type="button" size="sm" onClick={() => setForm({ ...form, bodyTemplate: BARK_ALERT_TEMPLATE })}>
                    {tr("使用 Bark 模板")}</Button>
                </div>
              </div>
            </>
          )}
          {conflict && !error && <Text size="sm" variant="error">{tr(FORM_CONFLICT_MESSAGE)}</Text>}
          {error && <Text size="sm" variant="error">{localizeIssueMessage(error)}</Text>}
          <div>
            <Button type="submit" variant="primary" loading={save.isPending}>{tr("保存")}</Button>
          </div>
        </form>
      </LayerCard.Primary>
    </LayerCard>
  )
}
