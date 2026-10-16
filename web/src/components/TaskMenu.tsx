import { Button, DropdownMenu } from '@cloudflare/kumo'
import { DotsThreeIcon, PauseIcon, PencilSimpleIcon, PlayIcon, TrashIcon, LightningIcon } from '@phosphor-icons/react'
import { useState } from 'react'
import { useLocation } from 'wouter'
import type { Task } from '../../../src/domain/task'
import { ConfirmDialog } from './ConfirmDialog'
import { useTaskActions } from './useTaskActions'

/** Row/page overflow menu: run now, edit, enable/disable, delete. */
export function TaskMenu({ task, onDeleted }: { task: Task; onDeleted?: () => void }) {
  const [, navigate] = useLocation()
  const { trigger, setEnabled, remove } = useTaskActions()
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={<Button variant="ghost" size="sm" shape="square" icon={DotsThreeIcon} aria-label="更多操作" />}
        />
        <DropdownMenu.Content>
          <DropdownMenu.Item icon={LightningIcon} onClick={() => trigger.mutate(task.id)}>
            立即执行
          </DropdownMenu.Item>
          <DropdownMenu.Item icon={PencilSimpleIcon} onClick={() => navigate(`/tasks/${task.id}/edit`)}>
            编辑
          </DropdownMenu.Item>
          <DropdownMenu.Item
            icon={task.enabled ? PauseIcon : PlayIcon}
            onClick={() => setEnabled.mutate({ id: task.id, enabled: !task.enabled })}
          >
            {task.enabled ? '停用' : '启用'}
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item icon={TrashIcon} variant="danger" onClick={() => setConfirming(true)}>
            删除
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="删除任务"
        description={`确定删除「${task.name}」？它的全部执行记录也会一并删除，无法恢复。`}
        confirmLabel="删除"
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
