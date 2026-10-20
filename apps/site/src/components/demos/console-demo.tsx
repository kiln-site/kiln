import * as React from "react"
import type { RelayConsoleLine } from "@workspace/contracts"
import { CornerDownLeft, Search, X } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { TooltipProvider } from "@workspace/ui/components/tooltip"

import { ConsoleLogViewportController } from "@/components/console/console-log-viewport"
import {
  createConsoleStreamStore,
  createConsoleUiStore,
  type ConsoleUiStore,
} from "@/components/console/console-stores"

import { createServerLog } from "~/components/demos/server-log"

const historyChunk = 50_000
const streamInterval = 700

interface ConsoleStats {
  lines: number
  loadedIn: number | null
  matches: number
  searchedIn: number | null
}

// The demo's numbers live outside React state so updating them repaints only
// the status bar, never Hearth's viewport.
function createStatsStore() {
  let stats: ConsoleStats = {
    lines: 0,
    loadedIn: null,
    matches: 0,
    searchedIn: null,
  }
  const listeners = new Set<() => void>()
  return {
    get: () => stats,
    set(next: Partial<ConsoleStats>) {
      stats = { ...stats, ...next }
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

type StatsStore = ReturnType<typeof createStatsStore>

const historySizes = [100_000, 1_000_000] as const
type HistorySize = (typeof historySizes)[number]

export default function ConsoleDemo() {
  const [lineCount, setLineCount] = React.useState<HistorySize>(100_000)
  return (
    <ConsoleSession
      key={lineCount}
      lineCount={lineCount}
      onLineCountChange={setLineCount}
    />
  )
}

// Hearth filters the whole history again for each batch of output, which
// stays instant for a busy day of logs. Holding a million lines, the demo
// stops streaming so searching and scrolling show what it does at that size.
function ConsoleSession({
  lineCount,
  onLineCountChange,
}: {
  lineCount: HistorySize
  onLineCountChange: (lineCount: HistorySize) => void
}) {
  const streaming = lineCount === historySizes[0]
  const [log] = React.useState(() => createServerLog())
  const [statsStore] = React.useState(createStatsStore)
  const [streamStore] = React.useState(createConsoleStreamStore)
  const searchStartedAt = React.useRef<number | null>(null)
  const [uiStore] = React.useState<ConsoleUiStore>(() => {
    const store = createConsoleUiStore()
    return {
      ...store,
      setFilteredLines(lines) {
        store.setFilteredLines(lines)
        const startedAt = searchStartedAt.current
        searchStartedAt.current = null
        statsStore.set({
          matches: lines.length,
          ...(startedAt === null
            ? {}
            : { searchedIn: performance.now() - startedAt }),
        })
      },
    }
  })
  const linesRef = React.useRef<Array<RelayConsoleLine>>([])
  const frameRef = React.useRef<HTMLDivElement>(null)

  const publish = React.useCallback(
    (lines: Array<RelayConsoleLine>) => {
      linesRef.current = lines
      statsStore.set({ lines: lines.length })
      streamStore.setSnapshot({
        connection: "live",
        consoleData: {
          instanceId: "survival-smp",
          lifecycle: [],
          lines,
          truncated: false,
        },
        error: null,
        loading: false,
        transport: null,
        transportMessage: null,
      })
    },
    [statsStore, streamStore]
  )

  const append = React.useCallback(
    (added: Array<RelayConsoleLine>) => {
      publish(linesRef.current.concat(added))
    },
    [publish]
  )

  // Writes the history in chunks so the page stays responsive meanwhile.
  React.useEffect(() => {
    let cancelled = false
    const startedAt = performance.now()
    const lines: Array<RelayConsoleLine> = []
    function writeChunk() {
      if (cancelled) return
      log.fill(lines, Math.min(historyChunk, lineCount - lines.length))
      statsStore.set({ lines: lines.length })
      if (lines.length < lineCount) {
        window.setTimeout(writeChunk, 0)
        return
      }
      publish(lines)
      window.requestAnimationFrame(() => {
        if (!cancelled)
          statsStore.set({ loadedIn: performance.now() - startedAt })
      })
    }
    writeChunk()
    return () => {
      cancelled = true
    }
  }, [lineCount, log, publish, statsStore])

  // New output arrives while the console is on screen.
  React.useEffect(() => {
    const frame = frameRef.current
    if (!frame || !streaming) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    let timer: number | undefined
    function tick() {
      if (linesRef.current.length >= lineCount && !document.hidden) {
        const added = [log.next()]
        if (Math.random() < 0.35) added.push(log.next())
        append(added)
      }
      timer = window.setTimeout(tick, streamInterval)
    }
    const observer = new IntersectionObserver(([entry]) => {
      window.clearTimeout(timer)
      if (entry?.isIntersecting) timer = window.setTimeout(tick, streamInterval)
    })
    observer.observe(frame)
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [append, lineCount, log, streaming])

  return (
    <TooltipProvider delayDuration={250}>
      <div
        ref={frameRef}
        className="flex h-full min-h-0 flex-col border border-border bg-card shadow-2xl shadow-black/40"
      >
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-2.5 sm:px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              aria-hidden="true"
              className="size-2 shrink-0 bg-emerald-400 shadow-[0_0_0_3px] shadow-emerald-400/15"
            />
            <span className="truncate text-sm font-medium">survival-smp</span>
            <span className="type-meta hidden text-muted-foreground sm:inline">
              Paper 1.21.4 on home-lab
            </span>
          </div>
          <ConsoleSearch
            searchStartedAt={searchStartedAt}
            statsStore={statsStore}
            uiStore={uiStore}
          />
        </div>
        <ConsoleLogViewportController
          active
          streamStore={streamStore}
          uiStore={uiStore}
        />
        <ConsoleCommand log={log} onOutput={append} />
        <ConsoleStatus
          lineCount={lineCount}
          onLineCountChange={onLineCountChange}
          statsStore={statsStore}
        />
      </div>
    </TooltipProvider>
  )
}

function ConsoleSearch({
  searchStartedAt,
  statsStore,
  uiStore,
}: {
  searchStartedAt: React.RefObject<number | null>
  statsStore: StatsStore
  uiStore: ConsoleUiStore
}) {
  const query = React.useSyncExternalStore(
    uiStore.subscribe,
    uiStore.getQuerySnapshot,
    uiStore.getQuerySnapshot
  )
  const lines = React.useSyncExternalStore(
    statsStore.subscribe,
    () => statsStore.get().lines,
    () => 0
  )

  function search(next: string) {
    searchStartedAt.current = performance.now()
    uiStore.setQuery(next)
  }

  return (
    <div className="relative w-full sm:ml-auto sm:w-72">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={query}
        onChange={(event) => search(event.target.value)}
        placeholder={`Search ${lines.toLocaleString("en-US")} lines`}
        aria-label="Search console output"
        className="h-9 border-border/80 bg-background pr-8 pl-8 text-base shadow-none sm:text-xs"
      />
      {query ? (
        <button
          type="button"
          aria-label="Clear search"
          className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center text-muted-foreground hover:text-foreground"
          onClick={() => search("")}
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}

function ConsoleCommand({
  log,
  onOutput,
}: {
  log: ReturnType<typeof createServerLog>
  onOutput: (lines: Array<RelayConsoleLine>) => void
}) {
  const [command, setCommand] = React.useState("")

  function send(event: React.FormEvent) {
    event.preventDefault()
    const input = command.trim().replace(/^\//, "")
    if (!input) return
    setCommand("")
    onOutput(respond(input).map(([level, text]) => log.line(level, text)))
  }

  return (
    <form
      onSubmit={send}
      className="flex shrink-0 items-center gap-2 border-t px-3 py-2.5 sm:px-4"
    >
      <Input
        value={command}
        onChange={(event) => setCommand(event.target.value)}
        placeholder="Send a server command, like list or say hi"
        aria-label="Server command"
        autoComplete="off"
        spellCheck={false}
        className="h-10 border-border/80 bg-card font-mono text-base shadow-none sm:text-xs"
      />
      <Button
        type="submit"
        size="sm"
        className="h-10 gap-1.5 px-4 text-xs"
        disabled={!command.trim()}
      >
        <CornerDownLeft />
        Send
      </Button>
    </form>
  )
}

type Output = Array<["info" | "warn", string]>

const onlinePlayers = [
  "mossy_mae",
  "redstone_ryan",
  "cobblequeen",
  "pixelpaws",
  "glowberry",
  "tnt_tom",
  "oak_and_ash",
  "nether_nik",
]

function respond(input: string): Output {
  const [name = "", ...rest] = input.split(/\s+/)
  const argument = rest.join(" ")
  switch (name.toLowerCase()) {
    case "list":
      return [
        [
          "info",
          `There are ${onlinePlayers.length} of a max of 40 players online: ${onlinePlayers.join(", ")}`,
        ],
      ]
    case "say":
      return argument
        ? [["info", `[Server] ${argument}`]]
        : [["warn", "Usage: /say <message>"]]
    case "tps":
      return [["info", "TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0"]]
    case "time":
      return [["info", `Set the time to ${rest[1] === "night" ? 13000 : 1000}`]]
    case "weather":
      return [["info", `Set the weather to ${rest[0] ?? "clear"}`]]
    case "help":
      return [
        ["info", "Try list, say <message>, tps, time set day, or weather rain"],
      ]
    default:
      return [
        [
          "warn",
          `Unknown or incomplete command: ${name}. Type "help" for help.`,
        ],
      ]
  }
}

function ConsoleStatus({
  lineCount,
  onLineCountChange,
  statsStore,
}: {
  lineCount: HistorySize
  onLineCountChange: (lineCount: HistorySize) => void
  statsStore: StatsStore
}) {
  const stats = React.useSyncExternalStore(
    statsStore.subscribe,
    statsStore.get,
    statsStore.get
  )
  const loading = stats.lines < lineCount || stats.loadedIn === null

  return (
    <div className="type-meta flex h-10 shrink-0 items-center gap-4 border-t bg-background pr-1.5 pl-3 whitespace-nowrap text-muted-foreground tabular-nums sm:pl-4">
      <p
        aria-live="polite"
        className="flex min-w-0 items-center gap-4 overflow-hidden"
      >
        {loading ? (
          <span>Writing {stats.lines.toLocaleString("en-US")} lines…</span>
        ) : (
          <>
            <span>
              <span className="text-foreground">
                {stats.lines.toLocaleString("en-US")}
              </span>{" "}
              lines
            </span>
            {stats.searchedIn === null ? (
              <span className="hidden sm:inline">
                Ready in {formatMs(stats.loadedIn ?? 0)}
              </span>
            ) : (
              <span>
                {stats.matches.toLocaleString("en-US")} matches in{" "}
                <span className="text-primary">
                  {formatMs(stats.searchedIn)}
                </span>
              </span>
            )}
          </>
        )}
      </p>
      <div
        role="group"
        aria-label="Lines of history"
        className="ml-auto hidden shrink-0 border border-border sm:flex"
      >
        {historySizes.map((size) => (
          <button
            key={size}
            type="button"
            aria-pressed={size === lineCount}
            className="h-7 px-2.5 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 aria-pressed:bg-accent aria-pressed:text-foreground"
            onClick={() => onLineCountChange(size)}
          >
            {size === 1_000_000 ? "1M lines" : "100K lines"}
          </button>
        ))}
      </div>
    </div>
  )
}

function formatMs(ms: number) {
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`
}
