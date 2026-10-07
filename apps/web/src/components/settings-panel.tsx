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
    <div className="mx-auto w-full max-w-[90rem] px-3 pt-4 pb-10 sm:px-5 sm:pt-5">
      <div className={cn("grid max-w-5xl gap-4", className)}>{children}</div>
    </div>
  )
}

export function SettingsPanel({
  action,
  children,
  className,
  icon,
  title,
}: {
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
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
      <header className="flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-primary [&_svg]:size-4">
          {icon}
          <h2 id={headingId} className="text-sm font-semibold text-foreground">
            {title}
          </h2>
        </div>
        {action}
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  )
}

/** A label beside its control; the control wraps below on narrow panels. */
export function SettingsRow({
  children,
  label,
}: {
  children: React.ReactNode
  label: string
}) {
  return (
    <div className="flex min-h-14 flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b px-4 py-3 last:border-b-0">
      <p className="min-w-0 flex-1 basis-32 text-sm font-medium">{label}</p>
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
