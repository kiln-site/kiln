import type {
  RelayConsoleLine,
  RelayInstanceResources,
  RelayObservedState,
} from "@workspace/contracts"

import { consoleStateLine } from "@/components/console/console-lifecycle"
import type { ServerAction } from "@/lib/instance-power-state"
import { resourceHistoryStore } from "@/lib/resource-history-store"

import { createRandom } from "~/components/demos/server-log"

export const demoServer = {
  id: "survival-smp",
  relayId: "home-lab",
  name: "survival-smp",
  implementation: "Paper",
  version: "1.21.4",
  shortId: "7c41e2a9",
  address: "play.kiln.site",
} as const

export interface DemoServerState {
  // The power action in flight, which Hearth shows on the power button.
  action: ServerAction | null
  observedState: RelayObservedState
  startedAt: string | null
}

const sampleInterval = 2_000
const gib = 1024 ** 3

type ConsoleWrite = (lines: Array<RelayConsoleLine>) => void
type LineFactory = (
  level: RelayConsoleLine["level"],
  text: string
) => RelayConsoleLine

// A game server that only lives in the browser. It answers power actions the
// way a Relay does, reports resources for Hearth's own meters, and writes what
// it does to the console. Each window on the page runs its own, by `key`.
export function createDemoServer(key: string) {
  const random = createRandom(11)
  const history = resourceHistoryStore(
    demoServer.relayId,
    `${demoServer.id}:${key}`
  )
  let state: DemoServerState = {
    action: null,
    observedState: "running",
    startedAt: new Date(Date.now() - (3 * 24 + 4) * 3_600_000).toISOString(),
  }
  const listeners = new Set<() => void>()
  const writers = new Set<ConsoleWrite>()
  // The console's line factory. Power actions play out in the console, so
  // they wait for one to attach.
  let line: LineFactory | null = null
  let received = 48 * gib
  let sent = 71 * gib

  function set(next: Partial<DemoServerState>) {
    state = { ...state, ...next }
    for (const listener of listeners) listener()
  }

  function sample(at: number): RelayInstanceResources {
    const receivedPerSecond = 40_000 + random() * 90_000
    const sentPerSecond = 90_000 + random() * 140_000
    received += receivedPerSecond * (sampleInterval / 1_000)
    sent += sentPerSecond * (sampleInterval / 1_000)
    const memoryUsed = (2.55 + random() * 0.35) * gib
    return {
      sampledAt: new Date(at).toISOString(),
      cpu: { capacityPercent: 400, percent: 38 + random() * 34 },
      memory: {
        percent: (memoryUsed / (4 * gib)) * 100,
        totalBytes: 4 * gib,
        usedBytes: memoryUsed,
      },
      storage: {
        nodePercent: 41,
        nodeTotalBytes: 512 * gib,
        nodeUsedBytes: 210 * gib,
        percent: 15.6,
        totalBytes: 20 * gib,
        usedBytes: 3.12 * gib,
      },
      network: {
        receivedBytes: received,
        receivedBytesPerSecond: receivedPerSecond,
        sentBytes: sent,
        sentBytesPerSecond: sentPerSecond,
      },
    }
  }

  // A few minutes of history, so the meters' charts have a line at once.
  const now = Date.now()
  const past: Array<RelayInstanceResources> = []
  for (let at = now - 5 * 60_000; at < now; at += sampleInterval) {
    past.push(sample(at))
  }
  history.record(past, sample(now))

  function write(lines: Array<RelayConsoleLine>) {
    for (const writer of writers) writer(lines)
  }

  function say(level: RelayConsoleLine["level"], text: string) {
    if (line) write([line(level, text)])
  }

  function transition(observedState: RelayObservedState) {
    set({ observedState })
    write([consoleStateLine(observedState, new Date().toISOString())])
  }

  function wait(ms: number) {
    return new Promise((resolve) => window.setTimeout(resolve, ms))
  }

  async function stop() {
    transition("stopping")
    for (const text of shutdownLines) {
      await wait(140 + random() * 220)
      say("info", text)
    }
    history.record([], null)
    set({ startedAt: null })
    transition("stopped")
  }

  async function start() {
    transition("starting")
    const startedAt = performance.now()
    for (const text of startupLines) {
      await wait(90 + random() * 200)
      say("info", text)
    }
    const seconds = ((performance.now() - startedAt) / 1_000).toFixed(3)
    say("info", `Done (${seconds}s)! For help, type "help"`)
    set({ startedAt: new Date().toISOString() })
    transition("running")
  }

  return {
    history,
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    // The console's own line factory, so power output reads like the log.
    attachConsole(factory: LineFactory, writer: ConsoleWrite): () => void {
      line = factory
      writers.add(writer)
      return () => writers.delete(writer)
    },
    async power(action: ServerAction) {
      if (state.action || !line) return
      set({ action })
      if (action === "kill") {
        say("warn", "Killed by Kiln")
        history.record([], null)
        set({ startedAt: null })
        transition("stopped")
      } else {
        if (action !== "start") await stop()
        if (action !== "stop") await start()
      }
      set({ action: null })
    },
    // Samples resources while the server runs and its window is on screen.
    sampleWhileVisible(element: Element) {
      let timer: number | undefined
      function tick() {
        if (state.observedState === "running" && !document.hidden) {
          history.record([], sample(Date.now()))
        }
        timer = window.setTimeout(tick, sampleInterval)
      }
      const observer = new IntersectionObserver(([entry]) => {
        window.clearTimeout(timer)
        if (entry?.isIntersecting) tick()
      })
      observer.observe(element)
      return () => {
        observer.disconnect()
        window.clearTimeout(timer)
      }
    },
  }
}

export type DemoServer = ReturnType<typeof createDemoServer>

const shutdownLines = [
  "Stopping the server",
  "Stopping server",
  "[LuckPerms] Disabling LuckPerms v5.4.145",
  "Saving players",
  "Saving worlds",
  "Saving chunks for level 'ServerLevel[world]'/minecraft:overworld",
  "Saving chunks for level 'ServerLevel[world_nether]'/minecraft:the_nether",
  "Saving chunks for level 'ServerLevel[world_the_end]'/minecraft:the_end",
  "ThreadedAnvilChunkStorage: All dimensions are saved",
  "Flushing Chunk IO",
  "Closing Thread Pool",
]

const startupLines = [
  "Starting minecraft server version 1.21.4",
  "Loading properties",
  "This server is running Paper version 1.21.4-232-main (Implementing API version 1.21.4-R0.1-SNAPSHOT)",
  "Server Ping Player Sample Count: 12",
  "Using 4 threads for Netty based IO",
  "Default game type: SURVIVAL",
  "Generating keypair",
  "Starting Minecraft server on *:25565",
  "Using epoll channel type",
  "[LuckPerms] Loading server plugin LuckPerms v5.4.145",
  'Preparing level "world"',
  "Preparing start region for dimension minecraft:overworld",
  "Time elapsed: 412 ms",
  "Preparing start region for dimension minecraft:the_nether",
  "Time elapsed: 96 ms",
  "Preparing start region for dimension minecraft:the_end",
  "Time elapsed: 71 ms",
  "[LuckPerms] Enabling LuckPerms v5.4.145",
  "Running delayed init tasks",
]
