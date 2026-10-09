import * as React from "react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

// One clock for every mounted RelativeTime. It ticks only while something
// shows a relative time, and each tick re-renders just those labels.
const clockListeners = new Set<() => void>()
let clockSnapshot = Date.now()
let clockTimer: ReturnType<typeof setInterval> | null = null

function subscribeClock(listener: () => void) {
  if (clockListeners.size === 0) clockSnapshot = Date.now()
  clockListeners.add(listener)
  clockTimer ??= setInterval(() => {
    clockSnapshot = Date.now()
    for (const notify of clockListeners) notify()
  }, 30_000)
  return () => {
    clockListeners.delete(listener)
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer)
      clockTimer = null
    }
  }
}

function getClockSnapshot() {
  return clockSnapshot
}

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
})
const fullDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "full",
  timeStyle: "long",
})

const units = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
] as const

/** "just now", "5 minutes ago", "yesterday", "2 months ago". */
function formatRelativeTime(timestamp: number, now: number): string {
  const elapsed = Math.max(0, now - timestamp)
  for (const [unit, size] of units) {
    if (elapsed >= size) {
      return relativeFormatter.format(-Math.floor(elapsed / size), unit)
    }
  }
  return "just now"
}

/** A relative time that keeps itself current, with the full date on hover. */
export const RelativeTime = React.memo(function RelativeTime({
  className,
  timestamp,
}: {
  className?: string
  timestamp: number
}) {
  const now = React.useSyncExternalStore(
    subscribeClock,
    getClockSnapshot,
    getClockSnapshot
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          className={cn("truncate", className)}
          dateTime={new Date(timestamp).toISOString()}
          suppressHydrationWarning
        >
          {formatRelativeTime(timestamp, now)}
        </time>
      </TooltipTrigger>
      <TooltipContent side="top">
        <span suppressHydrationWarning>
          {fullDateFormatter.format(timestamp)}
        </span>
      </TooltipContent>
    </Tooltip>
  )
})
