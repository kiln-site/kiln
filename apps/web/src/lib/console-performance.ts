import { Effect } from "effect"

import type { BrowserSpan } from "@/lib/browser-telemetry"
import { startBrowserSpan } from "@/lib/browser-telemetry"
import { currentPageOpenId, markPageMilestone } from "@/lib/page-timing"

type ConsoleSpan = BrowserSpan

export interface ConsoleLoadTiming {
  cancel: () => void
  markCache: (cacheHit: boolean) => void
  markFirstRowsPainted: (lineCount: number) => void
  // The console took over a connection opened before it rendered, such as
  // by hovering its link.
  markPrewarmed: () => void
  markReady: (transport: "direct" | "hearth" | null, lineCount: number) => void
  markRetryableFailure: (cause: unknown) => void
  markTransport: (transport: "direct" | "hearth") => void
  parentSpan: () => ConsoleSpan | undefined
}

export function createConsoleLoadTiming(): ConsoleLoadTiming {
  // The page open this console belongs to; a console that is leaving must
  // not report for the page replacing it.
  const pageOpenId = currentPageOpenId()
  let cacheHit = false
  let open = true
  let openSpan: ConsoleSpan | undefined
  let ready = false
  let retryCount = 0
  let rowsPending = true
  let rowsSpan: ConsoleSpan | undefined

  const start = () => {
    if (!open || openSpan) return
    openSpan = startBrowserSpan("Console open", {
      attributes: { "kiln.operation": "ui.console.open" },
    })
    rowsSpan = startBrowserSpan("Console first rows painted", {
      attributes: { "kiln.operation": "ui.console.paint" },
      parent: openSpan,
    })
  }

  const finishOpen = () => {
    if (!open || !ready || rowsPending) return
    open = false
    openSpan?.end()
    markPageMilestone("content", pageOpenId)
  }
  const finishRows = (
    result: "cached" | "empty" | "stream",
    lineCount: number
  ) => {
    if (!rowsPending) return
    start()
    rowsPending = false
    rowsSpan?.setAttribute("kiln.console.cache_hit", cacheHit)
    rowsSpan?.setAttribute("kiln.console.line_count", lineCount)
    rowsSpan?.setAttribute("kiln.console.result", result)
    rowsSpan?.end()
    finishOpen()
  }

  return {
    cancel: () => {
      if (!open) return
      open = false
      if (!openSpan) return
      openSpan.setAttribute("kiln.console.result", "cancelled")
      if (rowsPending) {
        rowsPending = false
        rowsSpan?.setAttribute("kiln.console.result", "cancelled")
        rowsSpan?.end()
      }
      openSpan.end()
    },
    markRetryableFailure: (cause) => {
      if (!open) return
      start()
      retryCount += 1
      openSpan?.setAttribute("kiln.console.retry_count", retryCount)
      openSpan?.setAttribute(
        "kiln.console.last_error",
        cause instanceof Error ? cause.name : "unknown"
      )
    },
    markCache: (nextCacheHit) => {
      start()
      cacheHit ||= nextCacheHit
      openSpan?.setAttribute("kiln.console.cache_hit", cacheHit)
      rowsSpan?.setAttribute("kiln.console.cache_hit", cacheHit)
    },
    markFirstRowsPainted: (lineCount) => {
      finishRows(cacheHit ? "cached" : "stream", lineCount)
    },
    markPrewarmed: () => {
      if (!open) return
      start()
      openSpan?.setAttribute("kiln.console.prewarmed", true)
    },
    markReady: (transport, lineCount) => {
      if (!open) return
      start()
      ready = true
      openSpan?.setAttribute("kiln.console.line_count", lineCount)
      openSpan?.setAttribute("kiln.console.result", "ready")
      if (transport) {
        openSpan?.setAttribute("kiln.console.transport", transport)
      }
      if (lineCount === 0) finishRows("empty", 0)
      finishOpen()
    },
    markTransport: (transport) => {
      if (!open) return
      start()
      openSpan?.setAttribute("kiln.console.transport", transport)
    },
    parentSpan: () => {
      start()
      return open ? openSpan : undefined
    },
  }
}

export function startConsoleTimingSpan(
  timing: ConsoleLoadTiming | undefined,
  name: string,
  op: string
): ConsoleSpan {
  return startBrowserSpan(name, {
    attributes: { "kiln.operation": op },
    parent: timing?.parentSpan(),
  })
}

export function withConsoleTimingSpan<TResult, TError, TRequirements>(
  timing: ConsoleLoadTiming | undefined,
  name: string,
  op: string,
  effect: Effect.Effect<TResult, TError, TRequirements>
): Effect.Effect<TResult, TError, TRequirements> {
  return Effect.suspend(() => {
    const span = startConsoleTimingSpan(timing, name, op)
    return effect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          span.setAttribute("kiln.console.result", "ok")
        })
      ),
      Effect.tapError(() =>
        Effect.sync(() => {
          span.setAttribute("kiln.console.result", "error")
        })
      ),
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          span.setAttribute("kiln.console.result", "cancelled")
        })
      ),
      Effect.ensuring(Effect.sync(() => span.end()))
    )
  })
}
