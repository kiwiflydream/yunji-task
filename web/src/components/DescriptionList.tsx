import type { ReactNode } from 'react'

export function DescriptionList({ items }: { items: [label: string, value: ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2.5 text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-kumo-subtle">{label}</dt>
          <dd className="min-w-0 break-words text-kumo-default">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
