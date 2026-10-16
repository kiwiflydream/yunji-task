import { Button, Dialog } from '@cloudflare/kumo'
import type { ReactNode } from 'react'

export function ConfirmDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  confirmLabel: string
  pending?: boolean
  onConfirm: () => void
}) {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog className="p-6">
        <Dialog.Title className="text-lg font-semibold">{props.title}</Dialog.Title>
        <Dialog.Description className="mt-2 text-kumo-subtle">{props.description}</Dialog.Description>
        <div className="mt-6 flex justify-end gap-2">
          <Dialog.Close render={(p) => <Button {...p}>取消</Button>} />
          <Button variant="destructive" loading={props.pending} onClick={props.onConfirm}>
            {props.confirmLabel}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
