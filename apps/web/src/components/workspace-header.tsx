import * as React from "react"
import { Effect } from "effect"
import { Check, Copy } from "lucide-react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import { ToolbarSidebarTrigger } from "@/components/global-page-toolbar"

// Shared header for instance workspaces (servers, databases, and later
// kinds). Each kind supplies its own identity line, center, and actions.
export function WorkspaceHeader({
  actions,
  center,
  identity,
}: {
  actions?: React.ReactNode
  center?: React.ReactNode
  identity: React.ReactNode
}) {
  return (
    <header className="shrink-0 border-b bg-background/90 backdrop-blur-xl">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 px-3 py-3 sm:px-5 lg:min-h-20 lg:py-2 xl:grid-cols-[minmax(0,1fr)_36rem_auto] xl:gap-x-3">
        <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-4">
          <ToolbarSidebarTrigger />
          <span className="h-8 w-px shrink-0 bg-border/80" aria-hidden="true" />
          {identity}
        </div>
        {center}
        {actions}
      </div>
    </header>
  )
}

export function WorkspaceIdentity({
  children,
  error,
  name,
  title,
}: {
  // The meta line under the name; separate items with WorkspaceMetaSeparator.
  children?: React.ReactNode
  error?: string | null
  name: string
  title: React.ReactNode
}) {
  return (
    <div className="@container min-w-0 flex-1">
      <h1
        className="flex min-w-0 items-baseline gap-1.5 font-heading tracking-[-0.03em]"
        title={name}
      >
        <span className="min-w-0 truncate text-lg font-semibold text-foreground sm:text-xl">
          {name}
        </span>
        <span className="shrink-0 text-border">/</span>
        <span className="shrink-0 text-sm font-medium text-muted-foreground sm:text-base">
          {title}
        </span>
      </h1>
      <div className="type-meta mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-muted-foreground">
        {children}
      </div>
      {error ? (
        <p className="type-meta mt-0.5 truncate text-destructive">{error}</p>
      ) : null}
    </div>
  )
}

export function WorkspaceMetaSeparator() {
  return <span className="text-border">/</span>
}

export function WorkspaceIdCopyButton({
  id,
  label,
  shortId,
}: {
  id: string
  // Lowercase noun, for example "server ID".
  label: string
  shortId: string
}) {
  const { copied, copy } = useCopyFeedback(id)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={`shrink-0 font-mono transition-colors ${copied ? "text-emerald-400" : "hover:text-foreground"}`}
          aria-label={`Copy full ${label} ${id}`}
          onClick={() => void copy()}
        >
          {shortId}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {copied ? `Full ${label} copied` : `Copy full ${label}`}
      </TooltipContent>
    </Tooltip>
  )
}

export function WorkspaceCopyValueButton({
  label,
  value,
}: {
  // Lowercase noun, for example "server address".
  label: string
  value: string
}) {
  const { copied, copy } = useCopyFeedback(value)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={`flex min-w-0 flex-1 items-center gap-1 truncate font-mono transition-colors ${copied ? "text-emerald-400" : "text-primary/75 hover:text-primary"}`}
          aria-label={`Copy ${label} ${value}`}
          onClick={() => void copy()}
        >
          <span className="truncate">{value}</span>
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

function useCopyFeedback(value: string) {
  const [copied, setCopied] = React.useState(false)
  const resetTimer = React.useRef<number | null>(null)
  React.useEffect(
    () => () => {
      if (resetTimer.current) window.clearTimeout(resetTimer.current)
    },
    []
  )

  async function copy() {
    await copyToClipboard(value)
    setCopied(true)
    if (resetTimer.current) window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setCopied(false), 1_800)
  }

  return { copied, copy }
}

async function copyToClipboard(value: string) {
  await Effect.runPromise(
    Effect.tryPromise({
      try: () => navigator.clipboard.writeText(value),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          const textarea = document.createElement("textarea")
          textarea.value = value
          textarea.style.position = "fixed"
          textarea.style.opacity = "0"
          document.body.append(textarea)
          textarea.select()
          document.execCommand("copy")
          textarea.remove()
        })
      )
    )
  )
}
