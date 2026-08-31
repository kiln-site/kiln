import * as Sentry from "@sentry/tanstackstart-react"
import { Effect } from "effect"

type ConsoleSpan = ReturnType<typeof Sentry.startInactiveSpan>

export interface ConsoleLoadTiming {
  cancel: () => void
  fail: (cause: unknown) => void
  markCache: (cacheHit: boolean) => void
  markFirstRowsPainted: (lineCount: number) => void
  markReady: (transport: "direct" | "hearth" | null, lineCount: number) => void
  markTransport: (transport: "direct" | "hearth") => void
  parentSpan: () => ConsoleSpan | undefined
}

export function createConsoleLoadTiming(): ConsoleLoadTiming {
  let cacheHit = false
  let open = true
  let openSpan: ConsoleSpan | undefined
  let ready = false
  let rowsPending = true
  let rowsSpan: ConsoleSpan | undefined

  const start = () => {
    if (!open || openSpan) return
    openSpan = Sentry.startInactiveSpan({
      name: "Console open",
      op: "ui.console.open",
      forceTransaction: true,
      attributes: {
        "sentry.source": "component",
      },
    })
    rowsSpan = Sentry.startInactiveSpan({
      name: "Console first rows painted",
      op: "ui.console.paint",
      parentSpan: openSpan,
    })
  }

  const finishOpen = () => {
    if (!open || !ready || rowsPending) return
    open = false
    openSpan?.end()
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
    fail: (cause) => {
      if (!open) return
      start()
      open = false
      openSpan?.setAttribute("kiln.console.result", "unavailable")
      openSpan?.setAttribute(
        "kiln.console.error",
        cause instanceof Error ? cause.name : "unknown"
      )
      if (rowsPending) {
        rowsPending = false
        rowsSpan?.setAttribute("kiln.console.result", "unavailable")
        rowsSpan?.end()
      }
      openSpan?.end()
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
  const parentSpan = timing?.parentSpan()
  return Sentry.startInactiveSpan({
    name,
    op,
    ...(parentSpan ? { parentSpan } : {}),
  })
}

export function withConsoleTimingSpan<TResult>(
  timing: ConsoleLoadTiming | undefined,
  name: string,
  op: string,
  run: () => Promise<TResult>
): Promise<TResult> {
  const span = startConsoleTimingSpan(timing, name, op)
  return Effect.runPromise(
    Effect.tryPromise({ try: run, catch: (cause) => cause }).pipe(
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
      Effect.ensuring(Effect.sync(() => span.end()))
    )
  )
}
