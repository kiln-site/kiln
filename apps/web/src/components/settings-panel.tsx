import * as React from "react"

import { cn } from "@workspace/ui/lib/utils"

export function SettingsPage({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "mx-auto grid w-full max-w-[90rem] gap-4 px-3 pt-4 pb-10 sm:px-5 sm:pt-5",
        className
      )}
    >
      {children}
    </div>
  )
}

export function SettingsPanel({
  action,
  children,
  className,
  description,
  icon,
  title,
}: {
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
  description?: React.ReactNode
  icon: React.ReactNode
  title: string
}) {
  const headingId = React.useId()
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card/45",
        className
      )}
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b bg-background/25 px-4 py-3">
        <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-primary/20 bg-primary/8 text-primary [&_svg]:size-4">
            {icon}
          </span>
          <div className="min-w-0">
            <h2 id={headingId} className="type-card-title">
              {title}
            </h2>
            {description ? (
              <p className="type-meta mt-0.5 text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
        </div>
        {action ? (
          <div className="flex shrink-0 items-center gap-2">{action}</div>
        ) : null}
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  )
}

/**
 * A label and description beside a control. The control wraps underneath the
 * label only when the panel is too narrow to fit both on one line.
 */
export function SettingsRow({
  children,
  description,
  label,
  labelFor,
}: {
  children: React.ReactNode
  description?: React.ReactNode
  label: React.ReactNode
  labelFor?: string
}) {
  const Label = labelFor ? "label" : "p"
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b px-4 py-4 last:border-b-0">
      <div className="min-w-0 flex-1 basis-56">
        <Label
          className="block text-sm font-medium text-foreground"
          {...(labelFor ? { htmlFor: labelFor } : {})}
        >
          {label}
        </Label>
        {description ? (
          <p className="type-meta mt-1 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">
        {children}
      </div>
    </div>
  )
}

export function SettingsEmptyState({
  children,
  icon,
}: {
  children: React.ReactNode
  icon?: React.ReactNode
}) {
  return (
    <div className="grid flex-1 place-items-center px-4 py-8 text-center">
      <div className="grid justify-items-center gap-2 text-xs text-muted-foreground">
        {icon ? (
          <span className="grid size-9 place-items-center rounded-lg border border-dashed bg-background/50 [&_svg]:size-4">
            {icon}
          </span>
        ) : null}
        {children}
      </div>
    </div>
  )
}
