import type { ReactNode } from "react"

import { cn } from "@workspace/ui/lib/utils"

export interface InstanceNameStatus {
  className: string
  label: string
}

export function InstanceName({
  className,
  icon,
  iconClassName,
  meta,
  metaClassName,
  name,
  nameClassName,
  status,
}: {
  className?: string
  icon: ReactNode
  iconClassName?: string
  meta?: ReactNode
  metaClassName?: string
  name: ReactNode
  nameClassName?: string
  status?: InstanceNameStatus
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <span
        className={cn(
          "relative grid size-8 shrink-0 place-items-center rounded-md border border-border/70 bg-background/35 text-muted-foreground",
          iconClassName
        )}
      >
        {icon}
        {status ? (
          <span
            className={cn(
              "absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-2 ring-background",
              status.className
            )}
            aria-hidden="true"
          />
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-xs font-semibold text-foreground",
            nameClassName
          )}
        >
          {name}
        </span>
        {meta ? (
          <span
            className={cn(
              "type-meta block truncate text-muted-foreground",
              metaClassName
            )}
          >
            {meta}
          </span>
        ) : null}
        {status ? (
          <span className="sr-only">Status: {status.label}</span>
        ) : null}
      </span>
    </span>
  )
}
