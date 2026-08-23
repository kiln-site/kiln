import type { ReactNode } from "react"

import { cn } from "@workspace/ui/lib/utils"

export function WorkspaceSummaryCard({
  action,
  children,
  className,
  icon,
  iconClassName,
  title,
  titleAccessory,
}: {
  action?: ReactNode
  children?: ReactNode
  className?: string
  icon: ReactNode
  iconClassName?: string
  title: ReactNode
  titleAccessory?: ReactNode
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-border/75 bg-card/45 p-4 sm:flex-row sm:items-center",
        className
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-lg border border-border/80 bg-background/70 text-muted-foreground",
            iconClassName
          )}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="type-card-title truncate">{title}</p>
            {titleAccessory}
          </div>
          {children}
        </div>
      </div>
      {action}
    </section>
  )
}
