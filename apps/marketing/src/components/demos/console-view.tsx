import * as React from "react"
import type { RelayConsoleLine } from "@workspace/contracts"
import {
  Check,
  CornerDownLeft,
  LoaderCircle,
  Share2,
  TriangleAlert,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"

import {
  ConsoleLevelMenu,
  ConsoleSearchControl,
  consoleToolbarClassName,
} from "@/components/console/console-filters"
import { ConsoleLogViewportController } from "@/components/console/console-log-viewport"
import {
  createConsoleStreamStore,
  createConsoleUiStore,
  type ConsoleUiStore,
} from "@/components/console/console-stores"
import { ConsoleTooltip } from "@/components/console/console-tooltip"
import {
  ConsoleRedactButton,
  ConsoleSelectionControl,
  ConsoleTimestampButton,
  ConsoleWrapButton,
} from "@/components/console/console-toolbar-actions"
import {
  mclogsShareLabel,
  mclogsShareTooltip,
} from "@/components/use-mclogs-share-action"

import { useDemoShare } from "~/components/demos/demo-share"
import { demoServer, type DemoServer } from "~/components/demos/demo-server"
import { historyLines, type StatsStore } from "~/components/demos/console-stats"
import { createServerLog } from "~/components/demos/server-log"

const historyChunk = 25_000
const streamInterval = 700
// How long the console streams with nobody touching it.
const idleLimit = 2 * 60_000

// Hearth's console page, reading a simulated server's output: a long history,
// new lines while it runs, and replies to a few commands.
export default function ConsoleView({
  running,
  server,
  statsStore,
}: {
  running: boolean
  server: DemoServer
  statsStore: StatsStore
}) {
  const [log] = React.useState(() => createServerLog({ historyLines }))
  const [streamStore] = React.useState(createConsoleStreamStore)
  const searchStartedAt = React.useRef<number | null>(null)
  const [uiStore] = React.useState<ConsoleUiStore>(() => {
    const store = createConsoleUiStore()
    return {
      ...store,
      setQuery(query) {
        searchStartedAt.current = performance.now()
        store.setQuery(query)
      },
      setFilteredLines(lines) {
        store.setFilteredLines(lines)
        const startedAt = searchStartedAt.current
        searchStartedAt.current = null
        if (!store.getQuerySnapshot()) {
          statsStore.set({ searchedIn: null })
        } else if (startedAt !== null) {
          statsStore.set({
            matches: lines.length,
            searchedIn: performance.now() - startedAt,
          })
        } else {
          statsStore.set({ matches: lines.length })
        }
      },
    }
  })
  const linesRef = React.useRef<Array<RelayConsoleLine>>([])
  const sectionRef = React.useRef<HTMLElement>(null)
  const runningRef = React.useRef(running)
  runningRef.current = running

  const publish = React.useCallback(
    (lines: Array<RelayConsoleLine>) => {
      linesRef.current = lines
      statsStore.set({ lines: lines.length })
      streamStore.setSnapshot({
        connection: "live",
        consoleData: {
          instanceId: demoServer.id,
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

  React.useEffect(
    () => server.attachConsole(log.line, append),
    [append, log, server]
  )

  // Writes the history in chunks so the page stays responsive meanwhile.
  React.useEffect(() => {
    let cancelled = false
    const startedAt = performance.now()
    const lines: Array<RelayConsoleLine> = []
    function writeChunk() {
      if (cancelled) return
      log.fill(lines, Math.min(historyChunk, historyLines - lines.length))
      statsStore.set({ lines: lines.length })
      if (lines.length < historyLines) {
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
  }, [log, publish, statsStore])

  // New output arrives while the server runs and the console is on screen,
  // until nobody has touched it for a while. Every line stays, so each one
  // costs a little more to show; a page left open stops adding them. Any
  // interaction, scrolling back to it, or starting the server resumes it.
  const wakeRef = React.useRef<() => void>(undefined)
  React.useEffect(() => {
    const section = sectionRef.current
    if (!section) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    let timer: number | undefined
    let visible = false
    let lastActive = performance.now()
    function schedule() {
      window.clearTimeout(timer)
      timer = window.setTimeout(tick, streamInterval)
    }
    function tick() {
      timer = undefined
      if (performance.now() - lastActive > idleLimit) return
      if (
        runningRef.current &&
        linesRef.current.length >= historyLines &&
        !document.hidden
      ) {
        const added = [log.next()]
        if (Math.random() < 0.35) added.push(log.next())
        append(added)
      }
      schedule()
    }
    function wake() {
      lastActive = performance.now()
      if (visible && timer === undefined) schedule()
    }
    wakeRef.current = wake
    const activity = ["pointerdown", "pointermove", "keydown", "wheel"]
    for (const type of activity) {
      section.addEventListener(type, wake, { passive: true })
    }
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false
      window.clearTimeout(timer)
      timer = undefined
      if (visible) wake()
    })
    observer.observe(section)
    return () => {
      observer.disconnect()
      for (const type of activity) section.removeEventListener(type, wake)
      window.clearTimeout(timer)
      wakeRef.current = undefined
    }
  }, [append, log])

  React.useEffect(() => {
    wakeRef.current?.()
  }, [running])

  return (
    <section
      ref={sectionRef}
      aria-label="Console"
      className="flex min-h-0 flex-1 flex-col bg-card"
    >
      <div className={consoleToolbarClassName}>
        <ConsoleSearchControl uiStore={uiStore} />
        <ConsoleLevelMenu uiStore={uiStore} />
        <div className="ml-auto flex items-center gap-1.5">
          <ShareButton />
          <ConsoleSelectionControl active uiStore={uiStore} />
          <ConsoleRedactButton uiStore={uiStore} />
          <ConsoleWrapButton uiStore={uiStore} />
          <ConsoleTimestampButton uiStore={uiStore} />
        </div>
      </div>
      <ConsoleLogViewportController
        active
        streamStore={streamStore}
        uiStore={uiStore}
      />
      <ConsoleCommand log={log} onOutput={append} running={running} />
    </section>
  )
}

function ConsoleCommand({
  log,
  onOutput,
  running,
}: {
  log: ReturnType<typeof createServerLog>
  onOutput: (lines: Array<RelayConsoleLine>) => void
  running: boolean
}) {
  const [command, setCommand] = React.useState("")

  function send(event: React.FormEvent) {
    event.preventDefault()
    const input = command.trim().replace(/^\//, "")
    if (!input || !running) return
    setCommand("")
    onOutput(respond(input).map(([level, text]) => log.line(level, text)))
  }

  return (
    <div className="shrink-0 border-t bg-background/80 px-3 py-3 sm:px-4">
      <form className="flex items-center gap-2" onSubmit={send}>
        <span className="hidden font-mono text-xs font-semibold text-primary sm:inline">
          &gt;
        </span>
        <Input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder={
            running ? "Send a server command, like list" : "Server is stopped"
          }
          aria-label="Server command"
          autoComplete="off"
          spellCheck={false}
          disabled={!running}
          className="h-10 min-w-0 flex-1 border-border/80 bg-card font-mono text-base shadow-none sm:text-xs"
        />
        <Button
          type="submit"
          size="sm"
          className="h-10 gap-1.5 px-4 text-xs"
          disabled={!running || !command.trim()}
        >
          <CornerDownLeft />
          Send
        </Button>
      </form>
    </div>
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

// Hearth's mclo.gs button. It shares the demo link, not the log.
function ShareButton() {
  const { share, state } = useDemoShare()
  return (
    <ConsoleTooltip content={mclogsShareTooltip(state)}>
      <Button
        variant={
          state === "copied"
            ? "secondary"
            : state === "error"
              ? "destructive"
              : "ghost"
        }
        size="sm"
        className="type-control-sm h-8 gap-1.5 px-2.5"
        disabled={state === "uploading"}
        onClick={share}
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
        {mclogsShareLabel(state)}
      </Button>
    </ConsoleTooltip>
  )
}
