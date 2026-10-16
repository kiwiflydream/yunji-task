import { Breadcrumbs, Text } from '@cloudflare/kumo'
import { Fragment, type ReactNode } from 'react'

export interface Crumb {
  label: string
  href?: string
}

export function PageHeader(props: {
  crumbs?: Crumb[]
  title: ReactNode
  badge?: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-col gap-3">
      {props.crumbs && (
        <Breadcrumbs>
          {props.crumbs.map((c, i) => (
            <Fragment key={i}>
              {i > 0 && <Breadcrumbs.Separator />}
              {c.href ? <Breadcrumbs.Link href={c.href}>{c.label}</Breadcrumbs.Link> : <Breadcrumbs.Current>{c.label}</Breadcrumbs.Current>}
            </Fragment>
          ))}
        </Breadcrumbs>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <Text variant="heading" size="lg" as="h1" truncate>
              {props.title}
            </Text>
            {props.badge}
          </div>
          {props.description && <Text variant="secondary">{props.description}</Text>}
        </div>
        {props.actions && <div className="flex flex-wrap items-center gap-2">{props.actions}</div>}
      </div>
    </div>
  )
}
