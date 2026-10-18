import { Button, Input, LayerCard, Radio, Text, useKumoToastManager } from '@cloudflare/kumo'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { SafetySettings } from '../../../src/shared/types'
import { api, ApiError, errorMessage, type SafetySettingsState } from '../api'
import { tr, useLocale } from '../i18n'
import { localizeIssueMessage } from '../locale'
import { FORM_CONFLICT_MESSAGE, useVersionedForm } from '../lib/versioned-form'

const formValue = (settings: SafetySettings) => ({
  paused: settings.paused,
  taskDailyLimit: String(settings.taskDailyLimit),
  globalDailyLimit: String(settings.globalDailyLimit),
})

export function SafetySettingsForm({ initial }: { initial: SafetySettingsState }) {
  useLocale()
  const { value: form, setValue, version, conflict, reset } = useVersionedForm(formValue(initial.settings), initial.version)
  const [errors, setErrors] = useState<Partial<Record<keyof SafetySettings, string>>>({})
  const [error, setError] = useState<string | null>(null)
  const qc = useQueryClient()
  const toasts = useKumoToastManager()
  const save = useMutation({
    mutationFn: () => api.putSafety({
      paused: form.paused,
      taskDailyLimit: Number(form.taskDailyLimit),
      globalDailyLimit: Number(form.globalDailyLimit),
    }, version),
    onSuccess: (saved) => {
      qc.setQueryData(['safety'], saved)
      reset(formValue(saved.settings), saved.version)
      setErrors({})
      setError(null)
      toasts.add({ title: tr('执行安全设置已保存'), variant: 'success' })
    },
    onError: (err) => {
      const fields: Partial<Record<keyof SafetySettings, string>> = {}
      if (err instanceof ApiError) for (const issue of err.issues) {
        if (issue.path === 'paused' || issue.path === 'taskDailyLimit' || issue.path === 'globalDailyLimit') fields[issue.path] = issue.message
      }
      setErrors(fields)
      setError(err instanceof ApiError && err.status === 409 ? tr(FORM_CONFLICT_MESSAGE)
        : Object.keys(fields).length ? tr('保存失败，请检查标出的字段。') : errorMessage(err))
    },
  })
  return (
    <LayerCard>
      <LayerCard.Secondary>
        <div className="flex flex-col">
          <span>{tr('执行安全')}</span>
          <Text size="xs" variant="secondary">{tr('限制每日调用次数；保存后生效，不会重置今天已使用的额度。')}</Text>
        </div>
      </LayerCard.Secondary>
      <LayerCard.Primary>
        <form noValidate onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
          <fieldset disabled={save.isPending} className="flex min-w-0 flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label={tr('单任务每日上限')} type="number" min={1} max={1000000} step={1}
                value={form.taskDailyLimit} onChange={(e) => setValue((prev) => ({ ...prev, taskDailyLimit: e.target.value }))}
                error={localizeIssueMessage(errors.taskDailyLimit)} description={tr('每个任务统一使用此上限，默认 10,000 次。')} />
              <Input label={tr('全系统每日上限')} type="number" min={1} max={10000000} step={1}
                value={form.globalDailyLimit} onChange={(e) => setValue((prev) => ({ ...prev, globalDailyLimit: e.target.value }))}
                error={localizeIssueMessage(errors.globalDailyLimit)} description={tr('所有任务合计，默认 100,000 次。')} />
            </div>
            <Text size="sm" variant="secondary">{tr('派发和实际执行分别计数、分别受以上额度限制；失败和重试也计入执行次数。每日 UTC 00:00（北京时间 08:00）换日。')}</Text>
            <Radio.Group legend={tr('执行状态')} appearance="card" orientation="horizontal"
              value={form.paused ? 'paused' : 'running'} onValueChange={(value) => setValue((prev) => ({ ...prev, paused: value === 'paused' }))}
              error={localizeIssueMessage(errors.paused)}>
              <Radio.Item label={tr('正常运行')} value="running" description={tr('在每日额度内执行任务')} />
              <Radio.Item label={tr('紧急暂停')} value="paused" description={tr('停止新派发、尚未开始的执行和告警')} />
            </Radio.Group>
            <Text size="sm" variant="secondary">{tr('暂停不会撤销已经发出的调用。恢复后，定时调度由后续维护重新安排，暂停期间被终止的执行不会自动补跑。')}</Text>
            {conflict && !error && <Text size="sm" variant="error">{tr(FORM_CONFLICT_MESSAGE)}</Text>}
            {error && <Text size="sm" variant="error">{localizeIssueMessage(error)}</Text>}
            <div><Button type="submit" variant="primary" loading={save.isPending}>{tr('保存执行安全设置')}</Button></div>
          </fieldset>
        </form>
      </LayerCard.Primary>
    </LayerCard>
  )
}
