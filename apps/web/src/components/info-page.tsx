import * as React from "react"
import { Check, Copy, Info } from "lucide-react"

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import { useCopyFeedback } from "@/components/workspace-header"

// Building blocks for Info pages: sections of facts in the main column and a
// rail on the right that sums up what the resource is. Rarely needed values
// sit behind popovers.

export function InfoPage({
  children,
  rail,
}: {
  children: React.ReactNode
  rail: React.ReactNode
}) {
  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-card">
      <div className="grid min-h-full lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="flex min-w-0 flex-col gap-4 px-5 py-6 sm:px-7">
          {children}
        </div>
        <aside className="min-w-0 border-t bg-background/30 px-5 py-6 sm:px-6 lg:border-t-0 lg:border-l [&_dt]:w-24">
          {rail}
        </aside>
      </div>
    </section>
  )
}

// A titled group of facts, with its actions in the header.
export function InfoSection({
  action,
  children,
  status,
  title,
}: {
  action?: React.ReactNode
  children: React.ReactNode
  // Beside the title, such as a status indicator.
  status?: React.ReactNode
  title: string
}) {
  return (
    <section className="min-w-0 border bg-background/45">
      <header className="flex min-h-12 items-center gap-3 border-b px-4 py-2">
        <h3 className="min-w-0 truncate text-sm font-semibold">{title}</h3>
        {status}
        {action ? (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {action}
          </div>
        ) : null}
      </header>
      <dl className="px-4">{children}</dl>
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
    <div className="flex min-h-10 items-center gap-3 border-b border-border/60 py-1.5 text-[0.8125rem] last:border-b-0">
      <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
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
  // What the icon explains, for screen readers: "About this proxy mode".
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

export function InfoDetailsContent({
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
  mono = true,
  value,
}: {
  // Lowercase noun, for example "Relay address".
  label: string
  // Identifiers and addresses are monospaced; names aren't.
  mono?: boolean
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
            "flex min-w-0 items-center gap-1.5 transition-colors",
            mono && "font-mono text-xs",
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

export function InfoRailGroup({
  children,
  title,
}: {
  children: React.ReactNode
  title: string
}) {
  return (
    <section className="mt-6 first:mt-0">
      <h3 className="type-technical-label mb-1 text-muted-foreground/80">
        {title}
      </h3>
      {children}
    </section>
  )
}

export function InfoRailCard({
  children,
  icon,
  summary,
  title,
}: {
  children: React.ReactNode
  icon: React.ReactNode
  // Shown above the facts, such as usage bars.
  summary?: React.ReactNode
  title: string
}) {
  return (
    <section className="mt-6 border bg-background/45 first:mt-0">
      <h3 className="flex items-center gap-2 border-b px-3 py-2.5 text-[0.8125rem] font-semibold [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
        {icon}
        {title}
      </h3>
      {summary ? (
        <div className="border-b border-border/60 px-3">{summary}</div>
      ) : null}
      <dl className="px-3">{children}</dl>
    </section>
  )
}
