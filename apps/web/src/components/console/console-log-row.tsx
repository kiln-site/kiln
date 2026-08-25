import * as React from "react"
import type {
  RelayConsoleLevel,
  RelayConsoleLine,
  RelayConsoleSegment,
} from "@workspace/contracts"

import { isConsoleStateLine } from "@/components/console/console-lifecycle"
import type { ConsoleUiStore } from "@/components/console/console-stores"
import type { SensitiveTextRedactionRange } from "@/lib/redaction"

const consoleTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
})
export type ConsoleDisplayLine = RelayConsoleLine & {
  sensitiveTextRedactions?: Array<SensitiveTextRedactionRange>
}

export const ConsoleLogRow = React.memo(function ConsoleLogRow({
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
      className={`absolute top-0 left-0 flex min-h-[30px] border-l-2 transition-colors ${stateLine ? "border-transparent pr-0 text-center" : "pr-5 text-left"} ${wrapLines ? "w-full items-start py-1.5 whitespace-pre-wrap" : "h-[30px] min-w-full items-center whitespace-nowrap"} ${lineTone(line.level, selected, stateLine)}`}
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
      {stateLine ? (
        <>
          {showTimestamps ? (
            <ConsoleTimestamp timestamp={line.timestamp} />
          ) : null}
          <span
            className={`${showTimestamps ? "w-[calc(100cqw-4.5rem)]" : "w-[100cqw]"} flex shrink-0 items-center leading-[18px] ${lineTextTone(line.level)}`}
          >
            <span className="mx-auto flex w-[min(76%,44rem)] items-center gap-3 before:min-w-0 before:flex-1 before:border-t before:border-stone-500/20 after:min-w-0 after:flex-1 after:border-t after:border-stone-500/20">
              <span className="shrink-0">{renderConsoleText(line, query)}</span>
            </span>
          </span>
        </>
      ) : (
        <>
          {showTimestamps ? (
            <ConsoleTimestamp timestamp={line.timestamp} />
          ) : null}
          <span
            className={`min-w-0 flex-1 ${showTimestamps ? "" : "ml-3"} leading-[18px] ${wrapLines ? "break-words" : ""} ${lineTextTone(line.level)}`}
          >
            {renderConsoleText(line, query)}
          </span>
        </>
      )}
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
    <span className="mr-2 ml-3 w-[3.25rem] shrink-0 text-left text-[0.5625rem] leading-[18px] text-muted-foreground/65 tabular-nums">
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
