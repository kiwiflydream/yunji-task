import { tr, useLocale } from '../i18n'
import { Button, DropdownMenu } from '@cloudflare/kumo'
import { DotsThreeIcon, PauseIcon, PencilSimpleIcon, PlayIcon, TrashIcon, LightningIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import { useLocation } from 'wouter'
import type { Task } from '../../../src/domain/task'
import { ConfirmDialog } from './ConfirmDialog'
import { useTaskActions } from './useTaskActions'

/** Row/page overflow menu: run now, edit, enable/disable, delete. */
export function TaskMenu({ task, onDeleted }: { task: Task; onDeleted?: () => void }) {
  useLocale()

  const [, navigate] = useLocation()
  const { trigger, setEnabled, remove } = useTaskActions()
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={<Button variant="ghost" size="sm" shape="square" icon={DotsThreeIcon} aria-label={tr("更多操作")} />}
        />
        <DropdownMenu.Content>
          <DropdownMenu.Item icon={LightningIcon} onClick={() => trigger.mutate(task.id)}>
            {tr("立即执行")}</DropdownMenu.Item>
          <DropdownMenu.Item icon={PencilSimpleIcon} onClick={() => navigate(`/tasks/${task.id}/edit`)}>
            {tr("编辑")}</DropdownMenu.Item>
          <DropdownMenu.Item
            icon={task.enabled ? PauseIcon : PlayIcon}
            onClick={() => setEnabled.mutate({ id: task.id, enabled: !task.enabled })}
          >
            {task.enabled ? tr("停用") : tr("启用")}
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item icon={TrashIcon} variant="danger" onClick={() => setConfirming(true)}>
            {tr("删除")}</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={tr("删除任务")}
        description={tr("确定删除「{0}」？它的全部执行记录也会一并删除，无法恢复。", task.name)}
        confirmLabel={tr("删除")}
        pending={remove.isPending}
        onConfirm={async () => {
          // mutateAsync resolves even if this menu unmounts mid-flight, unlike per-call onSuccess.
          await remove.mutateAsync(task.id).catch(() => undefined)
          setConfirming(false)
          if (!remove.isError) onDeleted?.()
        }}
      />
    </>
  )
}
