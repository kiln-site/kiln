import * as React from "react"
import {
  Check,
  Copy,
  Globe2,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

// Building blocks shared by the Info pages of every instance kind.

export function InfoCard({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-xl border bg-background/45",
        className
      )}
    >
      {children}
    </div>
  )
}

export function InfoCardHeader({
  action,
  icon,
  title,
}: {
  action?: React.ReactNode
  icon: React.ReactNode
  title: string
}) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2.5">
      <div className="flex items-center gap-2 text-primary [&_svg]:size-4">
        {icon}
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      {action}
    </div>
  )
}

export function CopyMetaRow({
  action,
  copyable = true,
  display,
  icon: Icon = Globe2,
  label,
  value,
}: {
  action?: React.ReactNode
  copyable?: boolean
  // Shown in place of the value, which is still what gets copied.
  display?: string
  icon?: LucideIcon
  label: string
  value: string
}) {
  const [copied, setCopied] = React.useState(false)
  const resetTimer = React.useRef<number | null>(null)

  React.useEffect(
    () => () => {
      if (resetTimer.current) window.clearTimeout(resetTimer.current)
    },
    []
  )

  async function copyValue() {
    if (!copyable) return
    await navigator.clipboard.writeText(value)
    setCopied(true)
    if (resetTimer.current) window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="flex min-h-16 items-center gap-3 border-b px-4 py-3 last:border-b-0">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="type-technical-label block text-muted-foreground">
          {label}
        </span>
        <span
          className={`mt-0.5 block truncate font-mono text-xs ${copyable ? "text-foreground" : "text-muted-foreground"}`}
          title={display ?? value}
        >
          {display ?? value}
        </span>
      </span>
      {action}
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        disabled={!copyable}
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={() => void copyValue()}
      >
        {copied ? <Check className="text-emerald-400" /> : <Copy />}
      </Button>
    </div>
  )
}

export function DangerZone({
  action,
  className,
  detail,
  title,
}: {
  action: React.ReactNode
  className?: string
  detail?: string
  // Left out when the actions say what they do.
  title?: string
}) {
  return (
    <div
      className={cn(
        "mt-4 flex flex-col gap-3 rounded-xl border border-destructive/25 bg-destructive/4 px-4 py-3.5 sm:flex-row sm:items-center",
        className
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-destructive/20 bg-destructive/10 text-destructive">
          <TriangleAlert className="size-4" />
        </span>
        <div className="min-w-0">
          {title ? (
            <>
              <p className="type-technical-label text-destructive">
                Danger zone
              </p>
              <h3 className="mt-1 text-sm font-semibold">{title}</h3>
            </>
          ) : (
            <h3 className="type-technical-label text-sm whitespace-nowrap text-foreground">
              Danger zone
            </h3>
          )}
          {detail ? (
            <p className="type-meta mt-1 font-mono break-all text-muted-foreground">
              {detail}
            </p>
          ) : null}
        </div>
      </div>
      {action}
    </div>
  )
}

export function MetaRow({
  action,
  className,
  icon: Icon,
  label,
  value,
  mono = false,
  wrap = false,
}: {
  action?: React.ReactNode
  className?: string
  icon: LucideIcon
  label: string
  value: React.ReactNode
  mono?: boolean
  wrap?: boolean
}) {
  return (
    <div
      className={cn(
        "flex min-h-14 items-center gap-3 border-b px-4 py-3 last:border-b-0",
        className
      )}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="type-technical-label block text-muted-foreground">
          {label}
        </span>
        <span
          className={`mt-0.5 block text-xs ${mono ? "font-mono" : "font-medium"} ${wrap ? "break-all" : "truncate"}`}
          title={typeof value === "string" ? value : undefined}
        >
          {value}
        </span>
      </span>
      {action}
    </div>
  )
}
