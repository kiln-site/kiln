import type {
  RelayConsole,
  RelayConsoleLevel,
  RelayConsoleLine,
} from "@workspace/contracts"
import type { RelayConsoleTransport } from "@/lib/relay-console-stream"

export const consoleLevels: Array<RelayConsoleLevel> = [
  "info",
  "warn",
  "error",
  "debug",
  "trace",
]

// What the gutter beside each line shows: nothing, the time of day, or the
// time since the output began.
export type ConsoleTimeMode = "clock" | "elapsed" | "off"

export interface ConsoleFilterSnapshot {
  levels: Set<RelayConsoleLevel>
  query: string
  redactSensitive: boolean
}

export interface ConsoleUiStore {
  clearSelection: () => void
  getFilterSnapshot: () => ConsoleFilterSnapshot
  getLevelsSnapshot: () => Set<RelayConsoleLevel>
  getLineSelectedSnapshot: (lineId: string) => boolean
  getQuerySnapshot: () => string
  getRedactSensitiveSnapshot: () => boolean
  getSelectedSnapshot: () => Set<string>
  getSelectedText: () => string
  getTimeModeSnapshot: () => ConsoleTimeMode
  getWrapLinesSnapshot: () => boolean
  setFilteredLines: (lines: Array<RelayConsoleLine>) => void
  setQuery: (query: string) => void
  setTimeMode: (mode: ConsoleTimeMode) => void
  subscribe: (listener: () => void) => () => void
  toggleLevel: (level: RelayConsoleLevel | "all") => void
  toggleLine: (line: RelayConsoleLine, index: number, shift: boolean) => void
  toggleRedactSensitive: () => void
  toggleWrapLines: () => void
}

export interface ConsoleStreamSnapshot {
  connection: "live" | "opening" | "reconnecting" | "unavailable"
  consoleData: RelayConsole | null
  error: string | null
  loading: boolean
  transport: RelayConsoleTransport | null
  transportMessage: string | null
}

export interface ConsoleStreamStore {
  getRetrySnapshot: () => number
  retry: () => void
  subscribeRetry: (listener: () => void) => () => void
  getHasLinesSnapshot: () => boolean
  getSnapshot: () => ConsoleStreamSnapshot
  setSnapshot: (snapshot: ConsoleStreamSnapshot) => void
  subscribe: (listener: () => void) => () => void
}

export function createConsoleStreamStore(): ConsoleStreamStore {
  let retryVersion = 0
  const retryListeners = new Set<() => void>()
  let snapshot: ConsoleStreamSnapshot = {
    connection: "opening",
    consoleData: null,
    error: null,
    loading: true,
    transport: null,
    transportMessage: null,
  }
  const listeners = new Set<() => void>()
  return {
    getRetrySnapshot: () => retryVersion,
    retry: () => {
      retryVersion += 1
      for (const listener of retryListeners) listener()
    },
    subscribeRetry: (listener) => {
      retryListeners.add(listener)
      return () => retryListeners.delete(listener)
    },
    getHasLinesSnapshot: () => Boolean(snapshot.consoleData?.lines.length),
    getSnapshot: () => snapshot,
    setSnapshot: (nextSnapshot) => {
      if (
        snapshot.consoleData === nextSnapshot.consoleData &&
        snapshot.connection === nextSnapshot.connection &&
        snapshot.error === nextSnapshot.error &&
        snapshot.loading === nextSnapshot.loading &&
        snapshot.transport === nextSnapshot.transport &&
        snapshot.transportMessage === nextSnapshot.transportMessage
      ) {
        return
      }
      snapshot = nextSnapshot
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function createConsoleUiStore({
  timeMode: initialTimeMode = "off",
}: { timeMode?: ConsoleTimeMode } = {}): ConsoleUiStore {
  let query = ""
  let levels = new Set(consoleLevels)
  let redactSensitive = true
  let timeMode = initialTimeMode
  let wrapLines = true
  let selected = new Set<string>()
  let filteredLines: Array<RelayConsoleLine> = []
  let lastSelected: number | null = null
  let filterSnapshot: ConsoleFilterSnapshot = {
    levels,
    query,
    redactSensitive,
  }
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const updateFilterSnapshot = () => {
    filterSnapshot = { levels, query, redactSensitive }
    notify()
  }

  return {
    clearSelection: () => {
      if (selected.size === 0) return
      selected = new Set()
      lastSelected = null
      notify()
    },
    getFilterSnapshot: () => filterSnapshot,
    getLevelsSnapshot: () => levels,
    getLineSelectedSnapshot: (lineId) => selected.has(lineId),
    getQuerySnapshot: () => query,
    getRedactSensitiveSnapshot: () => redactSensitive,
    getSelectedSnapshot: () => selected,
    getSelectedText: () => {
      const lines: Array<string> = []
      for (const line of filteredLines) {
        if (selected.has(line.id)) lines.push(line.text)
      }
      return lines.join("\n")
    },
    getTimeModeSnapshot: () => timeMode,
    getWrapLinesSnapshot: () => wrapLines,
    setFilteredLines: (lines) => {
      filteredLines = lines
      lastSelected = null
    },
    setQuery: (nextQuery) => {
      if (query === nextQuery) return
      query = nextQuery
      updateFilterSnapshot()
    },
    setTimeMode: (mode) => {
      if (timeMode === mode) return
      timeMode = mode
      notify()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    toggleLevel: (level) => {
      if (level === "all") {
        levels = new Set(consoleLevels)
      } else if (levels.size === consoleLevels.length) {
        levels = new Set([level])
      } else {
        const next = new Set(levels)
        if (next.has(level) && next.size === 1) {
          levels = new Set(consoleLevels)
        } else {
          if (next.has(level)) next.delete(level)
          else next.add(level)
          levels = next
        }
      }
      updateFilterSnapshot()
    },
    toggleLine: (line, index, shift) => {
      const next = new Set(selected)
      if (shift && lastSelected !== null) {
        const start = Math.min(lastSelected, index)
        const end = Math.max(lastSelected, index)
        for (let cursor = start; cursor <= end; cursor++) {
          const selectedLine = filteredLines.at(cursor)
          if (selectedLine) next.add(selectedLine.id)
        }
      } else if (next.has(line.id)) next.delete(line.id)
      else next.add(line.id)
      selected = next
      lastSelected = index
      notify()
    },
    toggleRedactSensitive: () => {
      redactSensitive = !redactSensitive
      updateFilterSnapshot()
    },
    toggleWrapLines: () => {
      wrapLines = !wrapLines
      notify()
    },
  }
}

