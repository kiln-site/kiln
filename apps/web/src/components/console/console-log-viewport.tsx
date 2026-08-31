import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { RelayConsole, RelayConsoleLine } from "@workspace/contracts"
import { ArrowDown, LoaderCircle, WifiOff } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import {
  ConsoleLogRow,
  type ConsoleDisplayLine,
} from "@/components/console/console-log-row"
import type {
  ConsoleService,
  ConsoleStreamSnapshot,
  ConsoleStreamStore,
  ConsoleUiStore,
} from "@/components/console/console-stores"
import { ConsoleTooltip } from "@/components/console/console-tooltip"
import type { ConsoleLoadTiming } from "@/lib/console-performance"
import { redactSensitiveTextWithRanges } from "@/lib/redaction"

export const ConsoleLogViewportController = React.memo(
  function ConsoleLogViewportController({
    active,
    loadTiming,
    streamStore,
    uiStore,
  }: {
    active: boolean
    loadTiming?: ConsoleLoadTiming
    streamStore: ConsoleStreamStore
    uiStore: ConsoleUiStore
  }) {
    const snapshot = React.useSyncExternalStore(
      streamStore.subscribe,
      streamStore.getSnapshot,
      streamStore.getSnapshot
    )
    const { consoleData } = snapshot
    const filters = React.useSyncExternalStore(
      uiStore.subscribe,
      uiStore.getFilterSnapshot,
      uiStore.getFilterSnapshot
    )
    const filteredLines = React.useMemo(() => {
      const normalizedQuery = filters.query.trim().toLowerCase()
      const filtered: Array<ConsoleDisplayLine> = []
      for (const line of consoleData?.lines ?? []) {
        const redacted = filters.redactSensitive
          ? redactSensitiveTextWithRanges(line.text)
          : null
        const text = redacted?.text ?? line.text
        const source = line as RelayConsoleLine & {
          relayId?: string
          service?: ConsoleService
        }
        const relayMatches =
          filters.relayIds === null ||
          !source.relayId ||
          filters.relayIds.has(source.relayId)
        const service = consoleLineService(source)
        const serviceMatches =
          filters.services === null ||
          service === null ||
          filters.services.has(service)
        if (
          filters.levels.has(line.level) &&
          relayMatches &&
          serviceMatches &&
          (!normalizedQuery || text.toLowerCase().includes(normalizedQuery))
        ) {
          filtered.push(
            !redacted?.redactions.length
              ? line
              : {
                  ...line,
                  text,
                  segments: undefined,
                  sensitiveTextRedactions: redacted.redactions,
                }
          )
        }
      }
      return filtered
    }, [consoleData?.lines, filters])

    React.useLayoutEffect(() => {
      uiStore.setFilteredLines(filteredLines)
    }, [filteredLines, uiStore])

    const firstRowsPaintedRef = React.useRef(false)
    const hasRows = filteredLines.length > 0
    const filteredLineCountRef = React.useRef(filteredLines.length)
    React.useLayoutEffect(() => {
      filteredLineCountRef.current = filteredLines.length
    }, [filteredLines.length])
    React.useLayoutEffect(() => {
      if (firstRowsPaintedRef.current || !active || !hasRows) {
        return
      }
      let secondFrame: number | undefined
      const firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(() => {
          firstRowsPaintedRef.current = true
          loadTiming?.markFirstRowsPainted(filteredLineCountRef.current)
        })
      })
      return () => {
        window.cancelAnimationFrame(firstFrame)
        if (secondFrame !== undefined) window.cancelAnimationFrame(secondFrame)
      }
    }, [active, hasRows, loadTiming])

    return (
      <ConsoleLogViewport
        active={active}
        consoleData={consoleData}
        filteredLines={filteredLines}
        snapshot={snapshot}
        uiStore={uiStore}
      />
    )
  }
)

function consoleLineService(
  line: RelayConsoleLine & { service?: ConsoleService }
): ConsoleService | null {
  if (line.service) return line.service
  if (line.text.startsWith("[tailscale] ")) return "tailscale"
  if (line.text.startsWith("[coredns] ")) return "coredns"
  return null
}

interface ConsoleLogViewportProps {
  active: boolean
  consoleData: RelayConsole | null
  filteredLines: Array<ConsoleDisplayLine>
  snapshot: ConsoleStreamSnapshot
  uiStore: ConsoleUiStore
}

function ConsoleLogViewport({
  active,
  consoleData,
  filteredLines,
  snapshot,
  uiStore,
}: ConsoleLogViewportProps) {
  const { connection, error, loading, transport } = snapshot
  const [autoScroll, setAutoScroll] = React.useState(true)
  const query = React.useSyncExternalStore(
    uiStore.subscribe,
    uiStore.getQuerySnapshot,
    uiStore.getQuerySnapshot
  )
  const showTimestamps = React.useSyncExternalStore(
    uiStore.subscribe,
    uiStore.getShowTimestampsSnapshot,
    uiStore.getShowTimestampsSnapshot
  )
  const wrapLines = React.useSyncExternalStore(
    uiStore.subscribe,
    uiStore.getWrapLinesSnapshot,
    uiStore.getWrapLinesSnapshot
  )
  const parentRef = React.useRef<HTMLDivElement>(null)
  const programmaticScroll = React.useRef(false)
  const rowVirtualizer = useVirtualizer({
    count: filteredLines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 30,
    getItemKey: (index) => filteredLines[index]?.id ?? index,
    overscan: 18,
    anchorTo: "end",
    followOnAppend: true,
  })
  const rowVirtualizerRef = React.useRef(rowVirtualizer)
  React.useLayoutEffect(() => {
    rowVirtualizerRef.current = rowVirtualizer
  }, [rowVirtualizer])
  const measureRow = React.useCallback((element: Element | null) => {
    rowVirtualizerRef.current.measureElement(element)
  }, [])

  React.useLayoutEffect(() => {
    if (active) rowVirtualizer.measure()
  }, [active, rowVirtualizer, wrapLines])

  React.useLayoutEffect(() => {
    if (!active || !autoScroll || filteredLines.length === 0 || loading) return
    programmaticScroll.current = true
    rowVirtualizer.scrollToIndex(filteredLines.length - 1, { align: "end" })
    const frame = window.requestAnimationFrame(() => {
      programmaticScroll.current = false
    })
    return () => window.cancelAnimationFrame(frame)
  }, [active, autoScroll, filteredLines.length, loading, rowVirtualizer])

  function resumeAutoScroll() {
    setAutoScroll(true)
    programmaticScroll.current = true
    if (filteredLines.length > 0) {
      rowVirtualizer.scrollToIndex(filteredLines.length - 1, { align: "end" })
    }
    window.requestAnimationFrame(() => {
      programmaticScroll.current = false
    })
  }

  return (
    <div className="relative min-h-0 flex-1 bg-background">
      <div
        ref={parentRef}
        className={`[container-type:inline-size] absolute inset-0 overscroll-contain font-mono text-[0.6875rem] selection:bg-primary/25 sm:text-xs ${wrapLines ? "overflow-x-hidden overflow-y-auto" : "overflow-auto"}`}
        onScroll={(event) => {
          if (programmaticScroll.current) return
          const viewport = event.currentTarget
          const distanceFromBottom =
            viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
          if (distanceFromBottom <= 8) {
            if (!autoScroll) setAutoScroll(true)
            return
          }
          if (autoScroll && distanceFromBottom > 72) setAutoScroll(false)
        }}
      >
        <div
          className={wrapLines ? "relative w-full" : "relative min-w-max"}
          style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const line = filteredLines.at(virtualRow.index)
            if (!line) return null
            return (
              <ConsoleLogRow
                key={line.id}
                index={virtualRow.index}
                line={line}
                measureElement={measureRow}
                query={query}
                showTimestamps={showTimestamps}
                start={virtualRow.start}
                uiStore={uiStore}
                wrapLines={wrapLines}
              />
            )
          })}
        </div>
      </div>

      {!autoScroll ? (
        <div className="absolute right-4 bottom-4 z-20">
          <ConsoleTooltip content="Jump to the latest output and resume following.">
            <Button
              size="icon-lg"
              className="shadow-xl shadow-black/35"
              aria-label="Jump to latest output"
              onClick={resumeAutoScroll}
            >
              <ArrowDown />
            </Button>
          </ConsoleTooltip>
        </div>
      ) : null}

      <ConsoleConnectionNotice
        connection={connection}
        hasConsoleData={Boolean(consoleData)}
        transport={transport}
      />

      {loading && !consoleData ? (
        <div className="absolute inset-0 grid place-items-center bg-card/70 backdrop-blur-[2px]">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin text-primary" />
            Opening live console stream
          </div>
        </div>
      ) : null}
      {!loading && !consoleData && connection === "unavailable" ? (
        <div className="absolute inset-0 grid place-items-center text-center">
          <div className="max-w-xs">
            <WifiOff className="mx-auto size-5 text-amber-300" />
            <p className="mt-3 text-sm font-semibold">Console unavailable</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {error ?? "The console stream could not be opened."}
            </p>
          </div>
        </div>
      ) : null}
      {!loading && consoleData && filteredLines.length === 0 ? (
        <div className="absolute inset-0 grid place-items-center text-center">
          <div>
            <p className="text-sm font-semibold">No matching output</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Adjust the search or log-level filters.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  )
}

const ConsoleConnectionNotice = React.memo(function ConsoleConnectionNotice({
  connection,
  hasConsoleData,
  transport,
}: {
  connection: ConsoleStreamSnapshot["connection"]
  hasConsoleData: boolean
  transport: ConsoleStreamSnapshot["transport"]
}) {
  if (!hasConsoleData) return null
  if (connection === "opening") return <DelayedConsoleOpeningNotice />
  if (connection === "live" && transport !== "hearth") return null

  const message =
    connection === "reconnecting"
      ? "RECONNECTING · OUTPUT MAY BE DELAYED"
      : connection === "live"
        ? "CONNECTED THROUGH HEARTH · DIRECT RELAY UNAVAILABLE"
        : "LIVE OUTPUT PAUSED"

  return <ConsoleConnectionNoticeContent message={message} />
})

function DelayedConsoleOpeningNotice() {
  const [visible, setVisible] = React.useState(false)
  React.useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 500)
    return () => window.clearTimeout(timer)
  }, [])
  return visible ? (
    <ConsoleConnectionNoticeContent
      loading
      message="CONNECTING TO LIVE OUTPUT…"
    />
  ) : null
}

function ConsoleConnectionNoticeContent({
  loading = false,
  message,
}: {
  loading?: boolean
  message: string
}) {
  return (
    <div className="pointer-events-none absolute top-3 left-1/2 z-20 -translate-x-1/2">
      <div className="type-meta flex items-center gap-1.5 border border-amber-400/20 bg-stone-950/90 px-2.5 py-1.5 font-mono text-amber-200 shadow-lg shadow-black/35 backdrop-blur-sm">
        {loading ? (
          <LoaderCircle className="size-3 animate-spin" />
        ) : (
          <WifiOff className="size-3" />
        )}
        {message}
      </div>
    </div>
  )
}
