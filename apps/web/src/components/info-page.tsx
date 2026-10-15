import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Check, Copy, Info, Users } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { Progress } from "@workspace/ui/components/progress"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import { useCopyFeedback } from "@/components/workspace-header"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"

// Building blocks for Info pages: live tiles up top, short fact lists with the
// rarely needed values behind popovers, and a footer for ownership and access.

export function InfoPage({ children }: { children: React.ReactNode }) {
  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-card">
      <div className="mx-auto max-w-5xl px-5 py-6 sm:px-8 sm:py-8">
        {children}
      </div>
    </section>
  )
}

// Tiles that share their borders, such as usage meters or linked counts. Each
// tile paints its own background over the border color.
export function InfoTiles({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn("grid gap-px overflow-hidden border bg-border", className)}
    >
      {children}
    </div>
  )
}

export function InfoMeter({
  accessory,
  detail,
  label,
  percent,
  value,
}: {
  accessory?: React.ReactNode
  detail?: React.ReactNode
  label: string
  // Null while there is no reading; the bar stays empty.
  percent: number | null
  value: React.ReactNode
}) {
  return (
    <div className="min-w-0 bg-card px-4 pt-3.5 pb-4">
      <div className="flex h-5 items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">{label}</span>
        {accessory}
      </div>
      <p className="mt-1.5 truncate text-xl font-semibold tracking-tight tabular-nums">
        {value}
        {detail ? (
          <span className="ml-1.5 text-sm font-normal tracking-normal text-muted-foreground">
            {detail}
          </span>
        ) : null}
      </p>
      <Progress
        aria-label={label}
        className="mt-3 [&_[data-slot=progress-indicator]]:bg-primary/75"
        value={percent === null ? 0 : Math.min(100, Math.max(0, percent))}
      />
    </div>
  )
}

export function InfoFactList({
  children,
  title,
}: {
  children: React.ReactNode
  title: string
}) {
  return (
    <section className="min-w-0">
      <h3 className="border-b pb-2 text-sm font-semibold">{title}</h3>
      <dl>{children}</dl>
    </section>
  )
}

export function InfoFact({
  children,
  label,
}: {
  children: React.ReactNode
  label: string
}) {
  return (
    <div className="flex min-h-10 items-center gap-3 border-b border-border/60 py-2 text-[0.8125rem] last:border-b-0">
      <dt className="w-32 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-1 items-center justify-end gap-1.5 text-right">
        {children}
      </dd>
    </div>
  )
}

// A fact value that opens the details behind it.
export function InfoDetails({
  children,
  title,
  trigger,
}: {
  children: React.ReactNode
  title: string
  trigger: React.ReactNode
}) {
  return (
    <Popover>
      <PopoverTrigger className="min-w-0 truncate border-b border-dashed border-muted-foreground/45 transition-colors outline-none hover:border-primary focus-visible:border-primary data-[state=open]:border-primary">
        {trigger}
      </PopoverTrigger>
      <InfoDetailsContent title={title}>{children}</InfoDetailsContent>
    </Popover>
  )
}

// An info icon that opens an explanation, for labels rather than values.
export function InfoHint({
  children,
  label,
  title,
}: {
  children: React.ReactNode
  // What the icon explains, for screen readers: "About CPU load".
  label: string
  title: string
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        className="grid size-5 shrink-0 place-items-center text-muted-foreground/70 transition-colors outline-none hover:text-primary focus-visible:text-primary data-[state=open]:text-primary"
      >
        <Info className="size-3.5" />
      </PopoverTrigger>
      <InfoDetailsContent title={title}>{children}</InfoDetailsContent>
    </Popover>
  )
}

function InfoDetailsContent({
  children,
  title,
}: {
  children: React.ReactNode
  title: string
}) {
  return (
    <PopoverContent align="end" sideOffset={8} className="w-80 text-xs">
      <p className="font-semibold text-foreground">{title}</p>
      <div className="mt-2 flex flex-col gap-2 leading-relaxed text-muted-foreground">
        {children}
      </div>
    </PopoverContent>
  )
}

export function InfoDetailRow({
  label,
  value,
}: {
  label: string
  value: React.ReactNode
}) {
  return (
    <div className="flex justify-between gap-4">
      <span className="shrink-0">{label}</span>
      <span className="min-w-0 text-right font-mono break-all text-foreground">
        {value}
      </span>
    </div>
  )
}

export function InfoCopyValue({
  label,
  value,
}: {
  // Lowercase noun, for example "Relay address".
  label: string
  value: string
}) {
  const { copied, copy } = useCopyFeedback(value)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Copy ${label} ${value}`}
          className={cn(
            "flex min-w-0 items-center gap-1.5 font-mono text-xs transition-colors",
            copied ? "text-emerald-400" : "hover:text-primary"
          )}
          onClick={() => void copy()}
        >
          <span className="truncate" title={value}>
            {value}
          </span>
          {copied ? (
            <Check className="size-3 shrink-0" />
          ) : (
            <Copy className="size-3 shrink-0 opacity-55" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {copied
          ? `${label.charAt(0).toUpperCase()}${label.slice(1)} copied`
          : `Copy ${label}`}
      </TooltipContent>
    </Tooltip>
  )
}

export function InfoFooter({
  actions,
  children,
}: {
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <footer className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3 border-t pt-4 text-xs text-muted-foreground">
      {children}
      {actions ? (
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </footer>
  )
}

export function InfoFooterItem({
  children,
  label,
}: {
  children: React.ReactNode
  label: string
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {label}
      <span className="flex min-w-0 items-center font-medium text-foreground">
        {children}
      </span>
    </span>
  )
}

export function InfoManageAccessButton({
  relayId,
  resourceId,
  resourceType,
}: {
  relayId: string
  resourceId: string
  resourceType: "database" | "instance" | "relay"
}) {
  const { data: canManageAccess = false } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: selectCanManageAccess,
  })
  if (!canManageAccess) return null
  return (
    <Button asChild size="sm" variant="ghost">
      <Link
        to="/access"
        search={{ tab: "users", relayId, resourceType, resourceId }}
      >
        <Users />
        Manage access
      </Link>
    </Button>
  )
}

function selectCanManageAccess(capabilities: { canManageAccess: boolean }) {
  return capabilities.canManageAccess
}
