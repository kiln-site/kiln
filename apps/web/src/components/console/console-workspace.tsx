import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  type RelayConsole,
  type RelayConsoleLevel,
  type RelayConsoleLine,
  type RelayConsoleSegment,
} from "@workspace/contracts"
import { ArrowDown, LoaderCircle, WifiOff } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import {
  createConsoleAggregateStreamStore,
  createConsoleStreamStore,
  createConsoleUiStore,
} from "@/components/console/console-stores"
import {
  ConsoleStreamController,
  TailscaleConsoleStreamController,
} from "@/components/console/console-stream-controller"
import { ConsoleCommandBar } from "@/components/console/console-command-bar"
import { ConsoleTooltip } from "@/components/console/console-tooltip"
import { ConsoleToolbar } from "@/components/console/console-toolbar"
import type {
  ConsoleAggregateStreamStore,
  ConsoleService,
  ConsoleStreamSnapshot,
  ConsoleStreamStore,
  ConsoleUiStore,
} from "@/components/console/console-stores"
import { isConsoleStateLine } from "@/components/console/console-lifecycle"
import {
  redactSensitiveTextWithRanges,
  type SensitiveTextRedactionRange,
} from "@/lib/redaction"
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"

const consoleTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
})
type ConsoleDisplayLine = RelayConsoleLine & {
  sensitiveTextRedactions?: Array<SensitiveTextRedactionRange>
}

export function ConsoleWorkspace({
  instance,
  active,
  canShare,
  canWrite,
}: {
  instance: InstanceWorkspaceInstance
  active: boolean
  canShare: boolean
  canWrite: boolean
}) {
  return (
    <ConsoleWorkspaceSession
      key={`${instance.relayId}:${instance.id}`}
      instance={instance}
      active={active}
      canShare={canShare}
      canWrite={canWrite}
    />
  )
}

function ConsoleWorkspaceSession({
  instance,
  active,
  canShare,
  canWrite,
}: {
  instance: InstanceWorkspaceInstance
  active: boolean
  canShare: boolean
  canWrite: boolean
}) {
  const tailscale = instance.implementation.toLowerCase() === "tailscale"
  const [uiStore] = React.useState(createConsoleUiStore)
  const [streamStore] = React.useState<ConsoleStreamStore>(() =>
    tailscale
      ? createConsoleAggregateStreamStore(instance.id)
      : createConsoleStreamStore()
  )

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-card">
      {tailscale ? (
        <TailscaleConsoleStreamController
          instanceId={instance.id}
          streamStore={streamStore as ConsoleAggregateStreamStore}
        />
      ) : (
        <ConsoleStreamController
          instanceId={instance.id}
          relayId={instance.relayId}
          streamStore={streamStore}
        />
      )}
      <ConsoleToolbar
        active={active}
        canShare={canShare && !tailscale}
        instance={instance}
        streamStore={streamStore}
        uiStore={uiStore}
      />
      <ConsoleLogViewportController
        active={active}
        streamStore={streamStore}
        uiStore={uiStore}
      />

      <ConsoleCommandBar
        active={active}
        canWrite={
          canWrite && instance.implementation.toLowerCase() !== "tailscale"
        }
        instance={instance}
      />
    </section>
  )
}

const ConsoleLogViewportController = React.memo(
  function ConsoleLogViewportController({
    active,
    streamStore,
    uiStore,
  }: {
    active: boolean
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
      <div className="flex items-center gap-1.5 border border-amber-400/20 bg-stone-950/90 px-2.5 py-1.5 font-mono text-[0.5625rem] text-amber-200 shadow-lg shadow-black/35 backdrop-blur-sm">
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

const ConsoleLogRow = React.memo(function ConsoleLogRow({
  index,
  line,
  measureElement,
  query,
  showTimestamps,
  start,
  uiStore,
  wrapLines,
}: {
  index: number
  line: ConsoleDisplayLine
  measureElement: (element: Element | null) => void
  query: string
  showTimestamps: boolean
  start: number
  uiStore: ConsoleUiStore
  wrapLines: boolean
}) {
  const getSelectedSnapshot = React.useCallback(
    () => uiStore.getLineSelectedSnapshot(line.id),
    [line.id, uiStore]
  )
  const selected = React.useSyncExternalStore(
    uiStore.subscribe,
    getSelectedSnapshot,
    getSelectedSnapshot
  )
  const stateLine = isConsoleStateLine(line)

  function toggle(shift: boolean) {
    uiStore.toggleLine(line, index, shift)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      ref={measureElement}
      data-index={index}
      className={`absolute top-0 left-0 flex min-h-[30px] transition-colors ${stateLine ? "border-l-0 pr-0 text-center" : "border-l-2 pr-5 text-left"} ${wrapLines ? "w-full items-start py-1.5 whitespace-pre-wrap" : "h-[30px] min-w-full items-center whitespace-nowrap"} ${lineTone(line.level, selected, stateLine)}`}
      style={{
        top: start,
        width: wrapLines ? "100%" : "max(100%, max-content)",
      }}
      onClick={(event) => toggle(event.shiftKey)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          toggle(event.shiftKey)
        }
      }}
    >
      {showTimestamps && !stateLine ? (
        <ConsoleTimestamp timestamp={line.timestamp} />
      ) : null}
      <span
        className={`${stateLine ? "sticky left-0 w-[100cqw] shrink-0 px-3 text-center" : `min-w-0 flex-1 ${showTimestamps ? "" : "ml-3"}`} leading-[18px] ${wrapLines ? "break-words" : ""} ${lineTextTone(line.level)}`}
      >
        {stateLine ? (
          <span className="mx-auto flex w-[min(76%,44rem)] items-center gap-3 before:min-w-0 before:flex-1 before:border-t before:border-stone-500/20 after:min-w-0 after:flex-1 after:border-t after:border-stone-500/20">
            <span className="shrink-0">{renderConsoleText(line, query)}</span>
          </span>
        ) : (
          renderConsoleText(line, query)
        )}
      </span>
    </div>
  )
})

function lineTone(
  level: RelayConsoleLevel,
  selected: boolean,
  stateLine = false
): string {
  if (selected) return "border-primary bg-primary/10"
  if (stateLine) return "bg-transparent hover:bg-transparent"
  if (level === "error")
    return "border-red-400/65 bg-red-500/7 hover:bg-red-500/12"
  if (level === "warn")
    return "border-amber-400/45 bg-amber-400/5 hover:bg-amber-400/10"
  return "border-transparent hover:bg-white/[0.025]"
}

function lineTextTone(level: RelayConsoleLevel): string {
  if (level === "error") return "text-red-200"
  if (level === "warn") return "text-amber-100"
  if (level === "debug" || level === "trace") return "text-muted-foreground"
  return "text-foreground/88"
}

function ConsoleTimestamp({ timestamp }: { timestamp: string | null }) {
  const formattedTimestamp = React.useSyncExternalStore(
    subscribeToBrowserLocale,
    () => formatTimestamp(timestamp),
    () => "--:--:--"
  )

  return (
    <span className="mr-2 ml-3 w-[3.25rem] shrink-0 text-[0.5625rem] text-muted-foreground/65 tabular-nums">
      {formattedTimestamp}
    </span>
  )
}

function subscribeToBrowserLocale(): () => void {
  // Locale has no browser change event; this store only defers formatting until hydration.
  return () => undefined
}

function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) return "--:--:--"
  return consoleTimestampFormatter.format(new Date(timestamp))
}

function renderConsoleText(
  line: Pick<
    ConsoleDisplayLine,
    "segments" | "sensitiveTextRedactions" | "text"
  >,
  query: string
): React.ReactNode {
  if (!line.segments?.length) {
    return renderConsoleTextPart(line.text, query, line.sensitiveTextRedactions)
  }
  let offset = 0
  return line.segments.map((segment) => {
    const start = offset
    offset += segment.text.length
    return (
      <span
        key={`${start}-${segment.text}`}
        style={consoleSegmentStyle(segment)}
      >
        {renderConsoleTextPart(segment.text, query)}
      </span>
    )
  })
}

function consoleSegmentStyle(
  segment: RelayConsoleSegment
): React.CSSProperties {
  return {
    color: segment.color,
    fontStyle: segment.italic ? "italic" : undefined,
    fontWeight: segment.bold ? 700 : undefined,
    textDecoration: segment.underline ? "underline" : undefined,
    textUnderlineOffset: segment.underline ? "2px" : undefined,
  }
}

function renderConsoleTextPart(
  text: string,
  query: string,
  redactions: ReadonlyArray<SensitiveTextRedactionRange> = []
): React.ReactNode {
  if (redactions.length === 0) return renderConsoleSegment(text, query)

  let cursor = 0
  const rendered: Array<React.ReactNode> = []
  for (const redaction of redactions) {
    if (redaction.from > cursor) {
      rendered.push(
        <React.Fragment key={`text-${cursor}`}>
          {renderConsoleSegment(text.slice(cursor, redaction.from), query)}
        </React.Fragment>
      )
    }
    rendered.push(
      <span
        key={`redacted-${redaction.from}`}
        tabIndex={0}
        title="IP address redacted"
        aria-label="IP address redacted"
        className="cursor-help text-muted-foreground/75 transition-colors hover:text-foreground/85 focus-visible:ring-1 focus-visible:ring-ring/40 focus-visible:outline-none"
      >
        {text.slice(redaction.from, redaction.to)}
      </span>
    )
    cursor = redaction.to
  }
  if (cursor < text.length) {
    rendered.push(
      <React.Fragment key={`text-${cursor}`}>
        {renderConsoleSegment(text.slice(cursor), query)}
      </React.Fragment>
    )
  }
  return rendered
}

function renderConsoleSegment(text: string, query: string): React.ReactNode {
  const urlPattern =
    /(https?:\/\/[^\s<>"']*?[^\s<>"'.,;:!?)}\]])(?=[.,;:!?)}\]]*(?:\s|$))/gu
  let offset = 0
  return text.split(urlPattern).map((part) => {
    const start = offset
    offset += part.length
    if (/^https?:\/\//u.test(part)) {
      return (
        <a
          key={`url-${start}`}
          href={part}
          target="_blank"
          rel="noreferrer"
          className="text-sky-400 underline decoration-sky-400/30 underline-offset-2 hover:text-sky-300"
          onClick={(event) => event.stopPropagation()}
        >
          {part}
        </a>
      )
    }
    return (
      <React.Fragment key={`text-${start}`}>
        {highlightText(part, query)}
      </React.Fragment>
    )
  })
}

function highlightText(text: string, query: string): React.ReactNode {
  const normalized = query.trim()
  if (!normalized) return text
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  const parts = text.split(new RegExp(`(${escaped})`, "giu"))
  let offset = 0
  return parts.map((part) => {
    const start = offset
    offset += part.length
    return part.toLowerCase() === normalized.toLowerCase() ? (
      <mark
        key={`match-${start}`}
        className="rounded-sm bg-amber-300 px-0.5 text-stone-950"
      >
        {part}
      </mark>
    ) : (
      <React.Fragment key={`text-${start}`}>{part}</React.Fragment>
    )
  })
}
