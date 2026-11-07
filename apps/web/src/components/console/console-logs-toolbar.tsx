import * as React from "react"
import { Clock3, Copy, Download, Link as LinkIcon, Share2 } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { showToast } from "@workspace/ui/components/sonner"

import type {
  ConsoleStreamStore,
  ConsoleTimeMode,
  ConsoleUiStore,
} from "@/components/console/console-stores"
import { copyToClipboard } from "@/components/console/console-toolbar-actions"
import { ConsoleTooltip } from "@/components/console/console-tooltip"
import {
  consoleLogFilename,
  downloadTextFile,
  formatConsoleLog,
} from "@/lib/console-export"

const timeModeLabels: Record<ConsoleTimeMode, string> = {
  clock: "Time of day",
  elapsed: "Elapsed",
  off: "Hidden",
}

export const ConsoleTimeMenu = React.memo(function ConsoleTimeMenu({
  uiStore,
}: {
  uiStore: ConsoleUiStore
}) {
  const mode = React.useSyncExternalStore(
    uiStore.subscribe,
    uiStore.getTimeModeSnapshot,
    uiStore.getTimeModeSnapshot
  )
  return (
    <DropdownMenu>
      <ConsoleTooltip content={`Line times: ${timeModeLabels[mode]}`}>
        <DropdownMenuTrigger asChild>
          <Button
            variant={mode === "off" ? "ghost" : "secondary"}
            size="icon"
            className="size-8"
            aria-label="Line times"
          >
            <Clock3 />
          </Button>
        </DropdownMenuTrigger>
      </ConsoleTooltip>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuLabel>Line times</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={mode}
          onValueChange={(value) =>
            uiStore.setTimeMode(value as ConsoleTimeMode)
          }
        >
          {(["clock", "elapsed", "off"] as const).map((value) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {timeModeLabels[value]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

// Everything here runs in the browser, on the lines it already has: nothing
// leaves for a third party.
export const ConsoleShareMenu = React.memo(function ConsoleShareMenu({
  logName,
  shareHref,
  streamStore,
  uiStore,
}: {
  // Names the downloaded file.
  logName: string
  // A link that keeps showing this log; the page's own address otherwise.
  shareHref?: string
  streamStore: ConsoleStreamStore
  uiStore: ConsoleUiStore
}) {
  const hasLines = React.useSyncExternalStore(
    streamStore.subscribe,
    streamStore.getHasLinesSnapshot,
    streamStore.getHasLinesSnapshot
  )
  const logText = () =>
    formatConsoleLog(streamStore.getSnapshot().consoleData?.lines ?? [], {
      redact: uiStore.getRedactSensitiveSnapshot(),
    })

  async function copyLink() {
    await copyToClipboard(
      shareHref
        ? new URL(shareHref, window.location.origin).href
        : window.location.href
    )
    showToast({
      description: "Anyone who opens it needs access to this log.",
      message: "Link copied",
      type: "success",
    })
  }

  async function copyLog() {
    await copyToClipboard(logText())
    showToast({ message: "Log copied", type: "success" })
  }

  return (
    <DropdownMenu>
      <ConsoleTooltip content="Share or download this log">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="type-control-sm h-8 gap-1.5 px-2.5"
            aria-label="Share"
          >
            <Share2 />
            <span className="max-sm:hidden">Share</span>
          </Button>
        </DropdownMenuTrigger>
      </ConsoleTooltip>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuItem onSelect={() => void copyLink()}>
          <LinkIcon />
          Copy link
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!hasLines} onSelect={() => void copyLog()}>
          <Copy />
          Copy log
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!hasLines}
          onSelect={() =>
            downloadTextFile(consoleLogFilename(logName), logText())
          }
        >
          <Download />
          Download .log
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
})
