import { tr, useLocale } from '../i18n'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'wouter'
import { api } from '../api'

const BUILTINS = [
  ['task.id', '任务 ID', '550e8400-e29b-41d4-a716-446655440000'],
  ['task.name', '任务名称', '夜间数据同步'],
  ['run.id', '这次执行的 ID', '550e8400-e29b-41d4-a716-446655440001'],
  ['run.status', '执行状态；失败告警中固定为 failed', 'failed'],
  ['run.attempt', '本次是第几次尝试，首次为 1，包含重试', '3'],
  ['run.trigger', '触发来源：schedule 为定时，manual 为手动或 API', 'schedule'],
  ['run.http_status', 'HTTP 响应状态码；未收到响应时为空字符串', '502'],
  ['run.error', '失败原因；没有错误信息时为空字符串', 'timeout after 25000ms'],
  ['run.finished_at', '本次执行结束时间，UTC 的 ISO 8601 格式', '2026-10-17T01:02:03.000Z'],
] as const

export function AlertTemplateHelp() {
  useLocale()

  const variables = useQuery({ queryKey: ['variables'], queryFn: api.variables })
  return (
    <section aria-label={tr("通知模板变量说明")} className="flex flex-col gap-3 rounded-lg bg-kumo-recessed p-3 text-sm">
      <div>
        <h3 className="font-medium">{tr("通知模板可用变量")}</h3>
        <p className="mt-1 text-kumo-subtle">{tr("最终失败时自动填入以下信息，无需创建变量。内置变量仅支持 Body 模板。")}</p>
      </div>
      <table className="w-full table-fixed text-left text-xs sm:text-sm">
        <caption className="sr-only">{tr("Body 模板内置变量、含义和示例值")}</caption>
        <thead>
          <tr className="border-b border-kumo-line">
            <th scope="col" className="w-[42%] py-2 pr-3 font-medium">{tr("变量写法")}</th>
            <th scope="col" className="py-2 font-medium">{tr("含义与示例")}</th>
          </tr>
        </thead>
        <tbody>
          {BUILTINS.map(([name, description, example]) => (
            <tr key={name} className="border-b border-kumo-line last:border-0">
              <th scope="row" className="py-2 pr-3 align-top font-normal"><code className="break-all">{`{{${name}}}`}</code></th>
              <td className="py-2 align-top">
                <div>{tr(description)}</div>
                <div className="mt-1 break-all text-kumo-subtle">{tr("示例：")}<code>{tr(example)}</code></div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-col gap-2 border-t border-kumo-line pt-3">
        <h4 className="font-medium">{tr("自定义加密变量")}</h4>
        <p className="text-kumo-subtle">
          {tr("在")}<Link href="/variables" className="mx-1 underline">{tr("「变量」页")}</Link>{tr("创建，按名称引用，例如")}<code>{'{{BARK_KEY}}'}</code>{tr("。 Webhook URL 和 Body 模板都支持自定义变量。")}</p>
        {variables.isPending ? (
          <p className="text-kumo-subtle">{tr("正在读取已配置的自定义变量…")}</p>
        ) : variables.isError ? (
          <p className="text-kumo-subtle">{tr("暂时无法加载自定义变量列表，请前往「变量」页查看。")}</p>
        ) : variables.data.length ? (
          <ul aria-label={tr("已配置的自定义变量")} className="flex flex-col gap-1.5">
            {variables.data.map((variable) => (
              <li key={variable.name} className="break-words">
                <code className="break-all">{`{{${variable.name}}}`}</code>
                {variable.description && <span className="ml-2 text-kumo-subtle">{variable.description}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-kumo-subtle">{tr("尚未配置自定义变量；使用 BARK_KEY 等名称前，请先在「变量」页添加。")}</p>
        )}
      </div>
      <p className="border-t border-kumo-line pt-3 text-kumo-subtle">
        {tr("Body 中的变量均按字符串替换，请放在 JSON 双引号内，例如")}<code className="break-all">{'"attempt":"{{run.attempt}}"'}</code>{tr("。 引号、换行等会自动转义；变量名拼错或自定义变量未创建，会导致告警发送失败。")}</p>
    </section>
  )
}
