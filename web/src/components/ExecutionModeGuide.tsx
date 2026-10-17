import { Button, Dialog } from '@cloudflare/kumo'
import { QuestionIcon, XIcon } from '@phosphor-icons/react'
import { useState, type ReactNode } from 'react'
import type { ExecutionMode, TaskExecutionMode } from '../../../src/shared/types'
import { effectiveTaskMode, MODE_LABEL, WORKER_MAX_TIMEOUT_SECONDS } from '../lib/execution-mode'

export function ExecutionModeGuide({ timeoutMs, taskMode, globalMode, queueAvailable }: {
  timeoutMs: number
  taskMode: TaskExecutionMode
  globalMode?: ExecutionMode
  queueAvailable?: boolean
}) {
  const [open, setOpen] = useState(false)
  const effective = globalMode === undefined ? null : effectiveTaskMode(taskMode, timeoutMs, { executionMode: globalMode, queueAvailable: queueAvailable ?? false })
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger render={(props) => <Button {...props} type="button" size="sm" variant="secondary" icon={<QuestionIcon />}>如何选择执行方式</Button>} />
      <Dialog size="xl" className="flex max-h-[85dvh] flex-col overflow-hidden p-0">
        <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-5 py-4">
          <div>
            <Dialog.Title className="text-lg font-semibold">执行方式选择指南</Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-kumo-subtle">按 Workers 套餐、接口耗时与投递需求选择。免费版和付费版都能使用这三种方式。</Dialog.Description>
          </div>
          <Dialog.Close render={(props) => <Button {...props} type="button" variant="ghost" shape="square" icon={<XIcon />} aria-label="关闭指南" />} />
        </div>
        <div className="flex min-h-0 flex-col gap-6 overflow-y-auto px-5 py-5 text-sm leading-relaxed">
          <div className="rounded-lg bg-kumo-recessed p-3" aria-label="当前任务执行配置">
            <p>当前请求超时：{timeoutMs / 1000} 秒 · 全局方式：{globalMode ? MODE_LABEL[globalMode] : '加载中'}</p>
            <p>任务选择：{taskMode === 'inherit' ? '跟随全局' : MODE_LABEL[taskMode]}{effective && `，实际使用${MODE_LABEL[effective.mode]}`}。</p>
            {effective?.mode === 'worker' && timeoutMs > WORKER_MAX_TIMEOUT_SECONDS * 1000 && <p className="mt-1 font-medium">这次配置会将请求超时限制为 {WORKER_MAX_TIMEOUT_SECONDS} 秒；重试也使用 Worker 异步。</p>}
            {queueAvailable === false && <p className="mt-1 font-medium">当前部署未配置 Queue，需先绑定队列才能选择队列执行。</p>}
          </div>

          <GuideSection title="先按场景选择">
            <div className="overflow-x-auto rounded-lg border border-kumo-line">
              <table className="w-full min-w-[30rem] text-left">
                <thead className="bg-kumo-recessed"><tr><Th>任务场景</Th><Th>Workers Free</Th><Th>Workers Paid</Th></tr></thead>
                <tbody className="divide-y divide-kumo-line">
                  <tr><Td>超时不超过 {WORKER_MAX_TIMEOUT_SECONDS} 秒，主要等待 HTTP 响应</Td><Td>优先 Worker 异步</Td><Td>优先 Worker 异步</Td></tr>
                  <tr><Td>超时超过 {WORKER_MAX_TIMEOUT_SECONDS} 秒，但通常 1 秒内返回</Td><Td>直接执行</Td><Td>直接执行，避免额外队列开销</Td></tr>
                  <tr><Td>通常等待数秒到数分钟</Td><Td>低频先用直接执行；关注 DO 时长额度</Td><Td>优先队列，减少 DO 长时间等待</Td></tr>
                  <tr><Td>需要持久投递、处理积压或承受突发任务</Td><Td>队列，先核算每日操作额度</Td><Td>队列</Td></tr>
                  <tr><Td>希望统一调整大多数任务</Td><Td>跟随全局</Td><Td>跟随全局</Td></tr>
                </tbody>
              </table>
            </div>
            <p>表中的“1 秒”是比较额外队列操作与 DO 等待成本的粗略分界，实际取决于免费额度、调用量、CPU 和并发情况。</p>
          </GuideSection>

          <GuideSection title="三种方式分别适合什么">
            <div className="flex flex-col gap-3">
              <p><strong>Worker 异步：</strong>适合健康检查、Webhook、短接口和轻量同步。HTTP 等待不按 Worker 运行时长收费，但仍消耗调用、CPU 和数据库额度。平台后台执行窗口为 30 秒，本项目预留收尾时间，将每次请求限制在 {WORKER_MAX_TIMEOUT_SECONDS} 秒；升级付费版也不会放宽这个上限。接口可能慢于这个上限时，应主动选择其他方式。</p>
              <p><strong>直接执行：</strong>由调度器 DO 发起请求，适合低频、很快返回或不想依赖 Queue 的任务。它支持超过 {WORKER_MAX_TIMEOUT_SECONDS} 秒的等待，但 DO 会累计等待时长；免费额度内不产生额外费用，付费版长时间等待会增加时长成本。</p>
              <p><strong>队列：</strong>适合慢接口、突发流量，以及需要持久投递和积压缓冲的任务。请求交给队列消费者执行，HTTP 等待不增加普通 Worker 的时长费用；会消耗 Queue 操作和消费者的调用／CPU 额度。必须先配置 Queue；免费版也可用，但每日额度较少。</p>
              <p><strong>跟随全局：</strong>使用设置页的全局默认方式。调整全局设置会影响之后的新执行，已开始的执行和已安排的重试保持原方式。任务耗时较特殊时，单独指定执行方式更直观。</p>
            </div>
          </GuideSection>

          <GuideSection title="免费与付费：重点看哪些额度">
            <ul className="list-disc space-y-2 pl-5">
              <li><strong>Workers Free：</strong>普通 Worker 每天 10 万次请求，每次 HTTP 调用的 CPU 预算为 10 毫秒。CPU 时间只计算实际执行代码，网络等待不算；这不代表接口必须在 10 毫秒内返回。大量 JSON 处理或加解密仍可能碰到 CPU 限制。</li>
              <li><strong>Queue 免费额度：</strong>每天 10,000 次操作。小消息一次正常投递通常包含写入、读取、删除三次操作，约能投递 3,333 条消息；重试和其他队列使用会进一步消耗额度。超过免费额度会失败，应降低频率或升级套餐。</li>
              <li><strong>DO 免费额度：</strong>每天 100,000 次请求和 13,000 GB-s 运行时长，所有任务共同消耗。低频慢任务可先选直接执行；任务多、等待长时，要同时关注 DO 时长和数据库写入。</li>
              <li><strong>Workers Paid：</strong>通常 $5／月起，含月度额度，超出后按量计费。Worker 请求超额 $0.30／百万次，CPU 另计；Queue 含每月 100 万次操作，超额 $0.40／百万次操作；DO 时长含每月 400,000 GB-s，超额 $12.50／百万 GB-s，DO 请求另计。免费额度内的成本差别通常很小。</li>
            </ul>
            <p>这些是服务额度和单价，并非每个任务的完整账单。三种方式都还会使用调度、执行记录和数据存储；本应用不会自动识别你的 Workers 付费状态。</p>
          </GuideSection>

          <GuideSection title="耗时与可靠性还要注意什么">
            <p>本项目 HTTP 请求超时可设为 1–300 秒。Worker 异步每次最多 {WORKER_MAX_TIMEOUT_SECONDS} 秒；直接执行和队列按任务设置执行，最多 300 秒。超过 300 秒的业务应改成快速返回任务 ID 的异步接口，再用另一任务查询结果。</p>
            <p>三种方式都会按任务的重试配置重试。队列额外提供持久投递和积压缓冲，但可能重复投递；业务接口应支持幂等。请求超时表示本次等待结束，不保证对端业务已停止。</p>
            <p>执行方式由配置决定。超时变长或缺少 Queue 绑定时，系统不会自动换一种方式；使用 Worker 异步时，即使跟随全局任务设置了更长超时，也以 {WORKER_MAX_TIMEOUT_SECONDS} 秒为上限。</p>
          </GuideSection>

          <GuideSection title="选择总结">
            <ul className="list-disc space-y-1 pl-5">
              <li>短接口、超时在 {WORKER_MAX_TIMEOUT_SECONDS} 秒内：先选 Worker 异步。</li>
              <li>需要更长超时：免费版低频任务先选直接执行；付费版慢接口优先队列。</li>
              <li>通常 1 秒内返回，但偶尔需要更长等待：直接执行也适合。</li>
              <li>持久投递、积压缓冲更重要：选队列，并核算操作额度。</li>
              <li>大多数任务同一种策略：跟随全局，特殊任务单独配置。</li>
            </ul>
          </GuideSection>
          <div className="border-t border-kumo-line pt-3 text-xs text-kumo-subtle">
            <p>额度与价格核对于 2026-10-17，以 Cloudflare 官方文档为准：</p>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-2">
              {[
                ['Workers 时限', 'https://developers.cloudflare.com/workers/platform/limits/'],
                ['Workers 计费', 'https://developers.cloudflare.com/workers/platform/pricing/'],
                ['Queues 计费', 'https://developers.cloudflare.com/queues/platform/pricing/'],
                ['DO 计费', 'https://developers.cloudflare.com/durable-objects/platform/pricing/'],
              ].map(([label, href]) => <a key={href} href={href} target="_blank" rel="noreferrer" className="underline">{label}</a>)}
            </div>
          </div>
        </div>
        <div className="flex justify-end border-t border-kumo-line px-5 py-3">
          <Dialog.Close render={(props) => <Button {...props} type="button" variant="primary">我知道了</Button>} />
        </div>
      </Dialog>
    </Dialog.Root>
  )
}

function GuideSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="flex flex-col gap-2"><h3 className="text-base font-semibold">{title}</h3>{children}</section>
}
function Th({ children }: { children: ReactNode }) { return <th scope="col" className="px-3 py-2 font-medium">{children}</th> }
function Td({ children }: { children: ReactNode }) { return <td className="px-3 py-2 align-top">{children}</td> }
