import * as React from "react"

import { cn } from "@workspace/ui/lib/utils"

export interface IdentityStatusPresentation {
  label: string
  tone: "danger" | "info" | "neutral" | "success" | "warning"
}

export interface IdentityNameProps {
  className?: string
  icon: React.ReactNode
  iconClassName?: string
  meta?: React.ReactNode
  metaClassName?: string
  name: string
  nameAccessory?: React.ReactNode
  nameClassName?: string
  status?: IdentityStatusPresentation
  statusClassName?: string
  textClassName?: string
}

export const IdentityName = React.memo(function IdentityName({
  className,
  icon,
  iconClassName,
  meta,
  metaClassName,
  name,
  nameAccessory,
  nameClassName,
  status,
  statusClassName,
  textClassName,
}: IdentityNameProps) {
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
          <IdentityStatus
            className={statusClassName}
            label={status.label}
            tone={status.tone}
          />
        ) : null}
      </span>
      <span className={cn("min-w-0 flex-1", textClassName)}>
        <span
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-xs font-semibold text-foreground",
            nameClassName
          )}
        >
          <span className="truncate">{name}</span>
          {nameAccessory}
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
      </span>
    </span>
  )
})

const IdentityStatus = React.memo(function IdentityStatus({
  className,
  label,
  tone,
}: IdentityStatusPresentation & { className?: string }) {
  return (
    <>
      <span
        className={cn(
          "absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-2 ring-background",
          statusToneClassName[tone],
          className
        )}
        aria-hidden="true"
      />
      <span className="sr-only">Status: {label}</span>
    </>
  )
})

const statusToneClassName: Record<IdentityStatusPresentation["tone"], string> =
  {
    danger: "bg-destructive",
    info: "bg-sky-400",
    neutral: "bg-muted-foreground/45",
    success: "bg-emerald-400",
    warning: "bg-amber-400",
  }
