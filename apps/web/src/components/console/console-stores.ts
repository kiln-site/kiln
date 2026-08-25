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

export const consoleServices = ["tailscale", "coredns"] as const
export type ConsoleService = (typeof consoleServices)[number]

export interface ConsoleFilterSnapshot {
  levels: Set<RelayConsoleLevel>
  query: string
  redactSensitive: boolean
  relayIds: Set<string> | null
  services: Set<ConsoleService> | null
}

export interface ConsoleUiStore {
  clearSelection: () => void
  getFilterSnapshot: () => ConsoleFilterSnapshot
  getLevelsSnapshot: () => Set<RelayConsoleLevel>
  getLineSelectedSnapshot: (lineId: string) => boolean
  getQuerySnapshot: () => string
  getRedactSensitiveSnapshot: () => boolean
  getRelayIdsSnapshot: () => Set<string> | null
  getServicesSnapshot: () => Set<ConsoleService> | null
  getSelectedSnapshot: () => Set<string>
  getSelectedText: () => string
  getShowTimestampsSnapshot: () => boolean
  getWrapLinesSnapshot: () => boolean
  setFilteredLines: (lines: Array<RelayConsoleLine>) => void
  setQuery: (query: string) => void
  subscribe: (listener: () => void) => () => void
  toggleLevel: (level: RelayConsoleLevel | "all") => void
  toggleRelay: (relayId: string, availableIds: Array<string>) => void
  toggleService: (service: ConsoleService | "all") => void
  toggleLine: (line: RelayConsoleLine, index: number, shift: boolean) => void
  toggleRedactSensitive: () => void
  toggleShowTimestamps: () => void
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
  getHasLinesSnapshot: () => boolean
  getSnapshot: () => ConsoleStreamSnapshot
  setSnapshot: (snapshot: ConsoleStreamSnapshot) => void
  subscribe: (listener: () => void) => () => void
}

export interface ConsoleAggregateStreamStore extends ConsoleStreamStore {
  removeSource: (sourceId: string) => void
  setSourceSnapshot: (
    sourceId: string,
    relay: { id: string; name: string },
    snapshot: ConsoleStreamSnapshot
  ) => void
}

export function createConsoleStreamStore(): ConsoleStreamStore {
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

export function createConsoleUiStore(): ConsoleUiStore {
  let query = ""
  let levels = new Set(consoleLevels)
  let redactSensitive = true
  let relayIds: Set<string> | null = null
  let services: Set<ConsoleService> | null = null
  let showTimestamps = false
  let wrapLines = true
  let selected = new Set<string>()
  let filteredLines: Array<RelayConsoleLine> = []
  let lastSelected: number | null = null
  let filterSnapshot: ConsoleFilterSnapshot = {
    levels,
    query,
    redactSensitive,
    relayIds,
    services,
  }
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const updateFilterSnapshot = () => {
    filterSnapshot = { levels, query, redactSensitive, relayIds, services }
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
    getRelayIdsSnapshot: () => relayIds,
    getServicesSnapshot: () => services,
    getSelectedSnapshot: () => selected,
    getSelectedText: () => {
      const lines: Array<string> = []
      for (const line of filteredLines) {
        if (selected.has(line.id)) lines.push(line.text)
      }
      return lines.join("\n")
    },
    getShowTimestampsSnapshot: () => showTimestamps,
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
    toggleRelay: (relayId, availableIds) => {
      if (relayId === "all") {
        relayIds = null
      } else if (relayIds === null) {
        relayIds = new Set([relayId])
      } else {
        const next = new Set(relayIds)
        if (next.has(relayId)) next.delete(relayId)
        else next.add(relayId)
        relayIds =
          next.size === 0 || next.size === new Set(availableIds).size
            ? null
            : next
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
    toggleShowTimestamps: () => {
      showTimestamps = !showTimestamps
      notify()
    },
    toggleWrapLines: () => {
      wrapLines = !wrapLines
      notify()
    },
    toggleService: (service) => {
      if (service === "all") {
        services = null
      } else if (services === null) {
        services = new Set([service])
      } else {
        const next = new Set(services)
        if (next.has(service)) next.delete(service)
        else next.add(service)
        services =
          next.size === 0 || next.size === consoleServices.length ? null : next
      }
      updateFilterSnapshot()
    },
  }
}

export function createConsoleAggregateStreamStore(
  instanceId: string
): ConsoleAggregateStreamStore {
  const sources = new Map<
    string,
    {
      relay: { id: string; name: string }
      snapshot: ConsoleStreamSnapshot
    }
  >()
  const store = createConsoleStreamStore()

  const update = () => {
    const values = [...sources.values()]
    const snapshots = values.map(({ snapshot }) => snapshot)
    const lines = values
      .flatMap(({ relay, snapshot }) =>
        (snapshot.consoleData?.lines ?? []).map((line) => ({
          ...line,
          id: `${relay.id}:${line.id}`,
          relayId: relay.id,
          relayName: relay.name,
        }))
      )
      .sort((left, right) =>
        (left.timestamp ?? "").localeCompare(right.timestamp ?? "")
      )
      .slice(-5_008)
    const connection = snapshots.some(
      (snapshot) => snapshot.connection === "live"
    )
      ? "live"
      : snapshots.some((snapshot) => snapshot.connection === "reconnecting")
        ? "reconnecting"
        : snapshots.some((snapshot) => snapshot.connection === "opening")
          ? "opening"
          : "unavailable"
    const transports = new Set(
      snapshots.flatMap((snapshot) =>
        snapshot.transport ? [snapshot.transport] : []
      )
    )
    const transportSnapshot = snapshots.find((snapshot) => snapshot.transport)
    store.setSnapshot({
      connection,
      consoleData:
        values.length === 0
          ? null
          : {
              instanceId,
              lifecycle: [],
              lines,
              truncated: snapshots.some(
                (snapshot) => snapshot.consoleData?.truncated
              ),
            },
      error:
        connection === "unavailable"
          ? (snapshots.find((snapshot) => snapshot.error)?.error ??
            "No Tailscale nodes are available.")
          : null,
      loading:
        values.length === 0 ||
        (lines.length === 0 && snapshots.some((snapshot) => snapshot.loading)),
      transport:
        transports.size === 1 ? (transportSnapshot?.transport ?? null) : null,
      transportMessage:
        transports.size === 1
          ? (transportSnapshot?.transportMessage ?? null)
          : null,
    })
  }

  return {
    ...store,
    removeSource: (sourceId) => {
      if (!sources.delete(sourceId)) return
      update()
    },
    setSourceSnapshot: (sourceId, relay, snapshot) => {
      const current = sources.get(sourceId)
      if (
        current?.relay.id === relay.id &&
        current.relay.name === relay.name &&
        current.snapshot === snapshot
      ) {
        return
      }
      sources.set(sourceId, { relay, snapshot })
      update()
    },
  }
}
