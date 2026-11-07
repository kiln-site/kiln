import * as React from "react"
import type { RelayConsoleLevel, RelayConsoleLine } from "@workspace/contracts"

import { isConsoleStateLine } from "@/components/console/console-lifecycle"
import type {
  ConsoleTimeMode,
  ConsoleUiStore,
} from "@/components/console/console-stores"
import {
  highlightConsoleText,
  type ConsoleSegment,
  type ConsoleTone,
} from "@/lib/console-highlight"
import type { SensitiveTextRedactionRange } from "@/lib/redaction"

const consoleTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
})
const consoleDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
})

export type ConsoleDisplayLine = RelayConsoleLine & {
  sensitiveTextRedactions?: Array<SensitiveTextRedactionRange>
}

// A game server's console, or the denser, colored rows of a logs page.
export type ConsoleAppearance = "console" | "logs"

export const consoleRowHeights: Record<ConsoleAppearance, number> = {
  console: 30,
  logs: 22,
}

const toneClasses: Record<ConsoleTone, string> = {
  cached: "text-sky-300 light:text-sky-700",
  debug: "text-muted-foreground",
  done: "text-emerald-300 light:text-emerald-700",
  error: "font-semibold text-red-300 light:text-red-700",
  hash: "text-violet-300/80 light:text-violet-700",
  info: "font-semibold text-sky-300 light:text-sky-700",
  instruction: "font-semibold text-fuchsia-300 light:text-fuchsia-700",
  key: "text-violet-300 light:text-violet-700",
  measure: "text-cyan-300 light:text-cyan-700",
  method: "font-semibold text-fuchsia-300 light:text-fuchsia-700",
  muted: "text-muted-foreground/75",
  step: "text-cyan-300 light:text-cyan-700",
  string: "text-emerald-300/90 light:text-emerald-700",
  warn: "font-semibold text-amber-300 light:text-amber-700",
}

export const ConsoleLogRow = React.memo(function ConsoleLogRow({
  appearance,
  elapsedFrom,
  index,
  line,
  measureElement,
  query,
  start,
  timeMode,
  uiStore,
  wrapLines,
}: {
  appearance: ConsoleAppearance
  // When the output began, for `elapsed` time.
  elapsedFrom: number | null
  index: number
  line: ConsoleDisplayLine
  measureElement: (element: Element | null) => void
  query: string
  start: number
  timeMode: ConsoleTimeMode
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
  const logs = appearance === "logs"
  const step = logs && line.origin === "kiln"
  // Rows are virtualized, so only the lines on screen are ever colored.
  const segments = React.useMemo<ReadonlyArray<ConsoleSegment> | null>(
    () =>
      line.segments?.length
        ? line.segments
        : logs && !step
          ? highlightConsoleText(line.text)
          : null,
    [line.segments, line.text, logs, step]
  )
  const showTime = timeMode !== "off"
  const time = showTime ? (
    <ConsoleTimestamp
      elapsedFrom={elapsedFrom}
      large={logs}
      mode={timeMode}
      timestamp={line.timestamp}
    />
  ) : null

  function toggle(shift: boolean) {
    uiStore.toggleLine(line, index, shift)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      ref={measureElement}
      data-index={index}
      className={`absolute top-0 left-0 flex border-l-2 transition-colors ${logs ? "min-h-[22px]" : "min-h-[30px]"} ${stateLine ? "border-transparent pr-0 text-center" : "pr-5 text-left"} ${wrapLines ? `w-full items-start whitespace-pre-wrap ${logs ? "py-0.5" : "py-1.5"}` : `min-w-full items-center whitespace-nowrap ${logs ? "h-[22px]" : "h-[30px]"}`} ${lineTone(line.level, selected, stateLine)}`}
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
          {time}
          <span
            className={`${showTime ? "w-[calc(100cqw-4.5rem)]" : "w-[100cqw]"} flex shrink-0 items-center leading-[18px] ${lineTextTone(line.level)}`}
          >
            <span className="mx-auto flex w-[min(76%,44rem)] items-center gap-3 before:min-w-0 before:flex-1 before:border-t before:border-stone-500/20 after:min-w-0 after:flex-1 after:border-t after:border-stone-500/20">
              <span className="shrink-0">
                {renderConsoleText(line, segments, query)}
              </span>
            </span>
          </span>
        </>
      ) : (
        <>
          {time}
          <span
            className={`min-w-0 flex-1 ${showTime ? "" : "ml-3"} leading-[18px] ${wrapLines ? "break-words" : ""} ${step && line.level === "info" ? "font-medium text-primary-ink" : lineTextTone(line.level)}`}
          >
            {renderConsoleText(line, segments, query)}
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
    return "border-red-400/65 bg-red-500/7 light:bg-red-500/14 hover:bg-red-500/12 light:hover:bg-red-500/24"
  if (level === "warn")
    return "border-amber-400/45 bg-amber-400/5 light:bg-amber-400/10 hover:bg-amber-400/10 light:hover:bg-amber-400/20"
  return "border-transparent hover:bg-white/[0.025]"
}

function lineTextTone(level: RelayConsoleLevel): string {
  if (level === "error") return "text-red-200 light:text-red-800"
  if (level === "warn") return "text-amber-100 light:text-amber-800"
  if (level === "debug" || level === "trace") return "text-muted-foreground"
  return "text-foreground/88"
}

function ConsoleTimestamp({
  elapsedFrom,
  large,
  mode,
  timestamp,
}: {
  elapsedFrom: number | null
  large: boolean
  mode: ConsoleTimeMode
  timestamp: string | null
}) {
  const formattedTimestamp = React.useSyncExternalStore(
    subscribeToBrowserLocale,
    () =>
      mode === "elapsed"
        ? formatElapsedTimestamp(timestamp, elapsedFrom)
        : formatTimestamp(timestamp),
    () => "--:--:--"
  )

  return (
    <span
      title={
        timestamp
          ? consoleDateTimeFormatter.format(new Date(timestamp))
          : undefined
      }
      className={`mr-2 ml-3 w-[3.25rem] shrink-0 text-left leading-[18px] text-muted-foreground/65 tabular-nums light:text-muted-foreground/82 ${large ? "text-[0.625rem]" : "text-[0.5625rem]"}`}
    >
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

// +0:42, +12:03, +1:02:03
function formatElapsedTimestamp(
  timestamp: string | null,
  from: number | null
): string {
  if (!timestamp || from === null) return "--:--"
  const seconds = Math.max(
    0,
    Math.floor((Date.parse(timestamp) - from) / 1_000)
  )
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor(seconds / 60) % 60
  const rest = String(seconds % 60).padStart(2, "0")
  return hours > 0
    ? `+${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `+${minutes}:${rest}`
}

function renderConsoleText(
  line: Pick<ConsoleDisplayLine, "sensitiveTextRedactions" | "text">,
  segments: ReadonlyArray<ConsoleSegment> | null,
  query: string
): React.ReactNode {
  // Matched against the whole line, so a match can span styled segments.
  const matches = queryMatches(line.text, query)
  if (!segments?.length) {
    return renderConsoleTextPart(
      line.text,
      matches,
      0,
      line.sensitiveTextRedactions
    )
  }
  let offset = 0
  return segments.map((segment) => {
    const start = offset
    offset += segment.text.length
    return (
      <span
        key={`${start}-${segment.text}`}
        className={segment.tone ? toneClasses[segment.tone] : undefined}
        style={consoleSegmentStyle(segment)}
      >
        {renderConsoleTextPart(
          segment.text,
          matches,
          start,
          segmentRedactions(line.sensitiveTextRedactions, start, offset)
        )}
      </span>
    )
  })
}

// The redactions that fall in the part of a line from `start` to `end`,
// relative to that part.
function segmentRedactions(
  redactions: ReadonlyArray<SensitiveTextRedactionRange> | undefined,
  start: number,
  end: number
): Array<SensitiveTextRedactionRange> {
  return (redactions ?? []).flatMap(({ from, to }) =>
    from < end && to > start
      ? [{ from: Math.max(from, start) - start, to: Math.min(to, end) - start }]
      : []
  )
}

// Where the query appears in the line, as [from, to) ranges.
type TextMatches = ReadonlyArray<readonly [from: number, to: number]>

function queryMatches(text: string, query: string): TextMatches {
  const normalized = query.trim()
  if (!normalized) return []
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  return Array.from(
    text.matchAll(new RegExp(escaped, "giu")),
    (match) => [match.index, match.index + match[0].length] as const
  )
}

function consoleSegmentStyle(segment: ConsoleSegment): React.CSSProperties {
  return {
    color: segment.color,
    fontStyle: segment.italic ? "italic" : undefined,
    fontWeight: segment.bold ? 700 : undefined,
    textDecoration: segment.underline ? "underline" : undefined,
    textUnderlineOffset: segment.underline ? "2px" : undefined,
  }
}

// `offset` is where `text` starts in its line, which `matches` refer to.
function renderConsoleTextPart(
  text: string,
  matches: TextMatches,
  offset: number,
  redactions: ReadonlyArray<SensitiveTextRedactionRange> = []
): React.ReactNode {
  if (redactions.length === 0) {
    return renderConsoleSegment(text, matches, offset)
  }

  let cursor = 0
  const rendered: Array<React.ReactNode> = []
  for (const redaction of redactions) {
    if (redaction.from > cursor) {
      rendered.push(
        <React.Fragment key={`text-${cursor}`}>
          {renderConsoleSegment(
            text.slice(cursor, redaction.from),
            matches,
            offset + cursor
          )}
        </React.Fragment>
      )
    }
    rendered.push(
      <span
        key={`redacted-${redaction.from}`}
        tabIndex={0}
        title="IP address redacted"
        aria-label="IP address redacted"
        className="cursor-help text-muted-foreground/75 transition-colors hover:text-foreground/85 focus-visible:ring-1 focus-visible:ring-ring/40 focus-visible:outline-none light:text-muted-foreground/88"
      >
        {text.slice(redaction.from, redaction.to)}
      </span>
    )
    cursor = redaction.to
  }
  if (cursor < text.length) {
    rendered.push(
      <React.Fragment key={`text-${cursor}`}>
        {renderConsoleSegment(text.slice(cursor), matches, offset + cursor)}
      </React.Fragment>
    )
  }
  return rendered
}

function renderConsoleSegment(
  text: string,
  matches: TextMatches,
  offset: number
): React.ReactNode {
  const urlPattern =
    /(https?:\/\/[^\s<>"']*?[^\s<>"'.,;:!?)}\]])(?=[.,;:!?)}\]]*(?:\s|$))/gu
  let cursor = 0
  return text.split(urlPattern).map((part) => {
    const start = cursor
    cursor += part.length
    if (/^https?:\/\//u.test(part)) {
      return (
        <a
          key={`url-${start}`}
          href={part}
          target="_blank"
          rel="noreferrer"
          className="text-sky-400 underline decoration-sky-400/30 underline-offset-2 hover:text-sky-300 light:text-sky-700 light:decoration-sky-700/30 light:hover:text-sky-700"
          onClick={(event) => event.stopPropagation()}
        >
          {part}
        </a>
      )
    }
    return (
      <React.Fragment key={`text-${start}`}>
        {highlightText(part, matches, offset + start)}
      </React.Fragment>
    )
  })
}

// Highlights the parts of `text`, which starts at `offset` in its line, that
// fall in a match.
function highlightText(
  text: string,
  matches: TextMatches,
  offset: number
): React.ReactNode {
  const end = offset + text.length
  const rendered: Array<React.ReactNode> = []
  let cursor = 0
  for (const [matchFrom, matchTo] of matches) {
    const from = Math.max(matchFrom, offset) - offset
    const to = Math.min(matchTo, end) - offset
    if (to <= from) continue
    if (from > cursor) {
      rendered.push(
        <React.Fragment key={`text-${cursor}`}>
          {text.slice(cursor, from)}
        </React.Fragment>
      )
    }
    rendered.push(
      <mark
        key={`match-${from}`}
        className="rounded-sm bg-amber-300 px-0.5 text-stone-950"
      >
        {text.slice(from, to)}
      </mark>
    )
    cursor = to
  }
  if (rendered.length === 0) return text
  if (cursor < text.length) {
    rendered.push(
      <React.Fragment key={`text-${cursor}`}>
        {text.slice(cursor)}
      </React.Fragment>
    )
  }
  return rendered
}
