import { tr } from "../i18n"
import { useKumoToastManager } from '@cloudflare/kumo'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, errorMessage } from '../api'

/** Trigger / enable / disable / delete with toasts and cache refresh. */
export function useTaskActions() {
  const toasts = useKumoToastManager()
  const qc = useQueryClient()
  const refresh = (id: string) => {
    qc.invalidateQueries({ queryKey: ['tasks'] })
    qc.invalidateQueries({ queryKey: ['task', id] })
    qc.invalidateQueries({ queryKey: ['runs', id] })
    qc.invalidateQueries({ queryKey: ['scheduler', id] })
  }
  const fail = (title: string) => (err: unknown) =>
    toasts.add({ title, description: errorMessage(err), variant: 'error' })

  const trigger = useMutation({
    mutationFn: (id: string) => api.trigger(id),
    onSuccess: (_runId, id) => {
      toasts.add({ title: tr("已触发"), description: tr("执行结果稍后出现在执行记录中。"), variant: 'success' })
      setTimeout(() => refresh(id), 1500)
    },
    onError: fail(tr("触发失败")),
  })
  const setEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setEnabled(id, enabled),
    onSuccess: (task) => {
      toasts.add({ title: task.enabled ? tr("任务已启用") : tr("任务已停用"), variant: 'success' })
      refresh(task.id)
    },
    onError: fail(tr("操作失败")),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteTask(id),
    onSuccess: (_v, id) => {
      toasts.add({ title: tr("任务已删除"), variant: 'success' })
      qc.invalidateQueries({ queryKey: ['tasks'] })
    },
    onError: fail(tr("删除失败")),
  })
  return { trigger, setEnabled, remove }
}
