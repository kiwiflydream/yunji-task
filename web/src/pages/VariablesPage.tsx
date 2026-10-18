import { localizeIssueMessage } from '../locale'
import { tr, useLocale } from '../i18n'
import {
  Banner,
  Button,
  Dialog,
  Empty,
  Input,
  InlineCopyText,
  LayerCard,
  SensitiveInput,
  Table,
  Text,
  useKumoToastManager,
} from '@cloudflare/kumo'
import { InfoIcon, KeyIcon, PlusIcon, TrashIcon, ArrowsClockwiseIcon } from '@phosphor-icons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { VARIABLE_NAME_RE } from '../../../src/lib/template'
import type { VariableInfo } from '../../../src/shared/types'
import { api, ApiError, errorMessage } from '../api'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { PageHeader } from '../components/PageHeader'
import { ErrorBanner, PageLoader } from '../components/States'
import { fmtTime } from '../lib/format'

export function VariablesPage() {
  useLocale()

  const variables = useQuery({ queryKey: ['variables'], queryFn: api.variables })
  const [editing, setEditing] = useState<{ name: string; description: string; isNew: boolean } | null>(null)
  const [deleting, setDeleting] = useState<VariableInfo | null>(null)
  const toasts = useKumoToastManager()
  const qc = useQueryClient()
  const remove = useMutation({
    mutationFn: (name: string) => api.deleteVariable(name),
    onSuccess: () => {
      toasts.add({ title: tr("变量已删除"), variant: 'success' })
      setDeleting(null)
      qc.invalidateQueries({ queryKey: ['variables'] })
    },
    onError: (err) => toasts.add({ title: tr("删除失败"), description: errorMessage(err), variant: 'error' }),
  })

  const addButton = (
    <Button variant="primary" icon={PlusIcon} onClick={() => setEditing({ name: '', description: '', isNew: true })}>
      {tr("添加变量")}</Button>
  )

  return (
    <>
      <PageHeader
        title={tr("变量")}
        description={tr("加密保存的密钥和令牌，在任务中用 {{NAME}} 引用。")}
        actions={addButton}
      />
      <div className="mb-4">
        <Banner
          variant="secondary"
          icon={<InfoIcon weight="fill" />}
          description={tr("变量值用 AES-GCM 加密后存入 D1，保存后不再显示。可在任务的 URL、请求头、Body 以及告警 URL / 模板中引用；执行日志里出现的变量值会被替换为 ***。")}
        />
      </div>
      {variables.isPending ? (
        <PageLoader />
      ) : variables.isError ? (
        <ErrorBanner error={variables.error} />
      ) : variables.data.length === 0 ? (
        <LayerCard className="py-12">
          <Empty
            icon={<KeyIcon size={48} className="text-kumo-inactive" />}
            title={tr("还没有变量")}
            description={tr("把 API Token、Webhook 密钥等存成变量，避免明文写在任务里。")}
            contents={addButton}
          />
        </LayerCard>
      ) : (
        <LayerCard className="overflow-x-auto p-0">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>{tr("名称")}</Table.Head>
                <Table.Head>{tr("描述")}</Table.Head>
                <Table.Head>{tr("更新时间")}</Table.Head>
                <Table.Head className="w-24" />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {variables.data.map((v) => (
                <Table.Row key={v.name}>
                  <Table.Cell>
                    <InlineCopyText value={`{{${v.name}}}`}>
                      <span className="font-mono">{v.name}</span>
                    </InlineCopyText>
                  </Table.Cell>
                  <Table.Cell>
                    <Text size="sm" variant="secondary">
                      {v.description || '—'}
                    </Text>
                  </Table.Cell>
                  <Table.Cell className="whitespace-nowrap">{fmtTime(v.updatedAt)}</Table.Cell>
                  <Table.Cell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        shape="square"
                        icon={ArrowsClockwiseIcon}
                        aria-label={tr("更新 {0} 的值", v.name)}
                        title={tr("更新值")}
                        onClick={() => setEditing({ name: v.name, description: v.description, isNew: false })}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        shape="square"
                        icon={TrashIcon}
                        aria-label={tr("删除 {0}", v.name)}
                        title={tr("删除")}
                        onClick={() => setDeleting(v)}
                      />
                    </div>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </LayerCard>
      )}

      {editing && <VariableDialog initial={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={tr("删除变量")}
        description={tr("确定删除 {0}？引用它的任务会执行失败。", deleting?.name)}
        confirmLabel={tr("删除")}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.name)}
      />
    </>
  )
}

function VariableDialog({
  initial,
  onClose,
}: {
  initial: { name: string; description: string; isNew: boolean }
  onClose: () => void
}) {
  useLocale()

  const [name, setName] = useState(initial.name)
  const [value, setValue] = useState('')
  const [description, setDescription] = useState(initial.description)
  const [error, setError] = useState<{ name?: string; value?: string; other?: string }>({})
  const toasts = useKumoToastManager()
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: () => initial.isNew
      ? api.createVariable(name.trim(), value, description.trim())
      : api.putVariable(name.trim(), value, description.trim()),
    onSuccess: () => {
      toasts.add({ title: initial.isNew ? tr("变量已添加") : tr("变量已更新"), variant: 'success' })
      qc.invalidateQueries({ queryKey: ['variables'] })
      onClose()
    },
    onError: (err) => setError({ other: initial.isNew && err instanceof ApiError && err.status === 409
      ? tr('同名变量已存在，请使用更新操作。') : errorMessage(err) }),
  })
  const submit = () => {
    const next: typeof error = {}
    if (!VARIABLE_NAME_RE.test(name.trim())) next.name = tr("只能包含字母、数字、下划线，且不能以数字开头")
    if (!value) next.value = tr("值不能为空")
    setError(next)
    if (!next.name && !next.value) save.mutate()
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog size="lg" className="p-6">
        <Dialog.Title className="text-lg font-semibold">{initial.isNew ? tr("添加变量") : tr("更新 {0}", initial.name)}</Dialog.Title>
        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <Input
            label={tr("名称")}
            className="font-mono"
            placeholder="API_TOKEN"
            value={name}
            disabled={!initial.isNew}
            onChange={(e) => setName(e.target.value)}
            {...(error.name ? { error: localizeIssueMessage(error.name) } : {})}
          />
          <SensitiveInput
            label={tr("值")}
            value={value}
            onValueChange={setValue}
            autoComplete="off"
            {...(error.value ? { error: localizeIssueMessage(error.value) } : {})}
          />
          <Input
            label={tr("描述（可选）")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          {error.other && <Banner variant="error" size="sm" description={error.other} />}
          <div className="flex justify-end gap-2">
            <Dialog.Close render={(p) => <Button {...p}>{tr("取消")}</Button>} />
            <Button type="submit" variant="primary" loading={save.isPending}>
              {tr("保存")}</Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  )
}
