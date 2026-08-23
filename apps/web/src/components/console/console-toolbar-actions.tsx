import * as React from "react"
import { Effect } from "effect"
import {
  Check,
  Clock3,
  Copy,
  EyeOff,
  LoaderCircle,
  Share2,
  TriangleAlert,
  WrapText,
  X,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@workspace/ui/components/popover"

import type {
  ConsoleStreamStore,
  ConsoleUiStore,
} from "@/components/console/console-stores"
import { ConsoleTooltip } from "@/components/console/console-tooltip"
import { useInstanceRelayConnected } from "@/components/instance-workspace-context"
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"
import { uploadConsoleLogToMclogs } from "@/server/relay"

export function ConsoleShareButton({
  canShare,
  instance,
  streamStore,
  uiStore,
}: {
  canShare: boolean
  instance: InstanceWorkspaceInstance
  streamStore: ConsoleStreamStore
  uiStore: ConsoleUiStore
}) {
  const relayConnected = useInstanceRelayConnected()
  const [state, setState] = React.useState<
    "idle" | "uploading" | "copied" | "error"
  >("idle")
  const resetTimer = React.useRef<number | null>(null)
  const hasLines = React.useSyncExternalStore(
    streamStore.subscribe,
    streamStore.getHasLinesSnapshot,
    streamStore.getHasLinesSnapshot
  )
  React.useEffect(
    () => () => {
      if (resetTimer.current) window.clearTimeout(resetTimer.current)
    },
    []
  )
  if (!canShare || !relayConnected) return null

  async function handleShare() {
    setState("uploading")
    await Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          const result = await uploadConsoleLogToMclogs({
            data: {
              instanceId: instance.id,
              relayId: instance.relayId,
              implementation: instance.implementation,
              version: instance.version,
              redactSensitive: uiStore.getRedactSensitiveSnapshot(),
            },
          })
          await copyToClipboard(result.url)
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.match({
          onFailure: () => setState("error"),
          onSuccess: () => setState("copied"),
        })
      )
    )
    if (resetTimer.current) window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setState("idle"), 2800)
  }

  return (
    <ConsoleTooltip content={shareTooltip(state)}>
      <Button
        variant={
          state === "copied"
            ? "secondary"
            : state === "error"
              ? "destructive"
              : "ghost"
        }
        size="sm"
        className="h-8 gap-1.5 px-2.5 text-[0.6875rem]"
        disabled={state === "uploading" || !hasLines}
        onClick={handleShare}
      >
        {state === "uploading" ? (
          <LoaderCircle className="animate-spin" />
        ) : state === "copied" ? (
          <Check />
        ) : state === "error" ? (
          <TriangleAlert />
        ) : (
          <Share2 />
        )}
        {shareLabel(state)}
      </Button>
    </ConsoleTooltip>
  )
}

export function ConsoleSelectionControl({
  active,
  uiStore,
}: {
  active: boolean
  uiStore: ConsoleUiStore
}) {
  const selected = React.useSyncExternalStore(
    uiStore.subscribe,
    uiStore.getSelectedSnapshot,
    uiStore.getSelectedSnapshot
  )
  const [copiedSelection, setCopiedSelection] =
    React.useState<Set<string> | null>(null)
  const resetTimer = React.useRef<number | null>(null)
  const selectedCount = selected.size
  const copied = copiedSelection === selected

  React.useEffect(() => {
    if (!active || selectedCount === 0) return
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") uiStore.clearSelection()
    }
    window.addEventListener("keydown", handleEscape, { capture: true })
    return () => window.removeEventListener("keydown", handleEscape, true)
  }, [active, selectedCount, uiStore])

  React.useEffect(
    () => () => {
      if (resetTimer.current) window.clearTimeout(resetTimer.current)
    },
    []
  )

  async function handleCopy() {
    await copyToClipboard(uiStore.getSelectedText())
    setCopiedSelection(selected)
    if (resetTimer.current) window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setCopiedSelection(null), 1800)
  }

  return (
    <Popover open={selectedCount > 0}>
      <PopoverAnchor asChild>
        <span className="inline-flex">
          <ConsoleTooltip
            content={copied ? "Selected Lines Copied" : "Copy Selected Lines"}
          >
            <Button
              variant={copied ? "secondary" : "ghost"}
              size="icon"
              className="size-8"
              aria-label={
                selectedCount > 0
                  ? `Copy ${selectedCount} Selected ${selectedCount === 1 ? "Line" : "Lines"}`
                  : "Copy Selected Lines"
              }
              disabled={selectedCount === 0}
              onClick={handleCopy}
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          </ConsoleTooltip>
        </span>
      </PopoverAnchor>
      <PopoverContent
        align="center"
        side="bottom"
        sideOffset={7}
        className="flex w-auto min-w-36 items-center gap-2 px-2.5 py-2"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={uiStore.clearSelection}
      >
        <span
          className="font-mono text-[0.625rem] whitespace-nowrap text-muted-foreground"
          aria-live="polite"
        >
          {copied
            ? `${selectedCount} ${selectedCount === 1 ? "line" : "lines"} copied`
            : `${selectedCount} ${selectedCount === 1 ? "line" : "lines"} selected`}
        </span>
        <ConsoleTooltip content="Clear Selection">
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Clear selected console lines"
            onClick={uiStore.clearSelection}
          >
            <X className="size-3.5" />
          </Button>
        </ConsoleTooltip>
      </PopoverContent>
    </Popover>
  )
}

export function ConsoleRedactButton({ uiStore }: { uiStore: ConsoleUiStore }) {
  const redactSensitive = React.useSyncExternalStore(
    uiStore.subscribe,
    uiStore.getRedactSensitiveSnapshot,
    uiStore.getRedactSensitiveSnapshot
  )
  return (
    <ConsoleTooltip content={redactSensitive ? "Show IPs" : "Censor IPs"}>
      <Button
        variant={redactSensitive ? "secondary" : "ghost"}
        size="icon"
        className="size-8"
        aria-label={redactSensitive ? "Show IPs" : "Censor IPs"}
        aria-pressed={redactSensitive}
        onClick={uiStore.toggleRedactSensitive}
      >
        <EyeOff />
      </Button>
    </ConsoleTooltip>
  )
}

export function ConsoleWrapButton({ uiStore }: { uiStore: ConsoleUiStore }) {
  const wrapLines = React.useSyncExternalStore(
    uiStore.subscribe,
    uiStore.getWrapLinesSnapshot,
    uiStore.getWrapLinesSnapshot
  )
  return (
    <ConsoleTooltip
      content={wrapLines ? "Disable Line Wrap" : "Enable Line Wrap"}
    >
      <Button
        variant={wrapLines ? "secondary" : "ghost"}
        size="icon"
        className="size-8"
        aria-label={wrapLines ? "Disable Line Wrap" : "Enable Line Wrap"}
        aria-pressed={wrapLines}
        onClick={uiStore.toggleWrapLines}
      >
        <WrapText />
      </Button>
    </ConsoleTooltip>
  )
}

export function ConsoleTimestampButton({
  uiStore,
}: {
  uiStore: ConsoleUiStore
}) {
  const showTimestamps = React.useSyncExternalStore(
    uiStore.subscribe,
    uiStore.getShowTimestampsSnapshot,
    uiStore.getShowTimestampsSnapshot
  )
  return (
    <ConsoleTooltip
      content={showTimestamps ? "Hide Timestamps" : "Show Timestamps"}
    >
      <Button
        variant={showTimestamps ? "secondary" : "ghost"}
        size="icon"
        className="size-8"
        aria-label={showTimestamps ? "Hide timestamps" : "Show timestamps"}
        onClick={uiStore.toggleShowTimestamps}
      >
        <Clock3 />
      </Button>
    </ConsoleTooltip>
  )
}

function shareTooltip(
  state: "idle" | "uploading" | "copied" | "error"
): string {
  if (state === "uploading") return "Uploading to mclo.gs"
  if (state === "copied") return "Link Copied"
  if (state === "error") return "Retry mclo.gs Upload"
  return "Upload to mclo.gs"
}

function shareLabel(state: "idle" | "uploading" | "copied" | "error"): string {
  if (state === "uploading") return "Uploading"
  if (state === "copied") return "Link copied"
  if (state === "error") return "Try again"
  return "mclo.gs"
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
