import type { RelayInstanceResources } from "@workspace/contracts"

export interface ResourceHistoryPoint {
  timestamp: number
  cpu: number | null
  memory: number | null
  storage: number | null
  storageNode: number | null
  network: number | null
  networkReceived: number | null
  networkSent: number | null
}

export interface ResourceHistoryStore {
  getCurrentSnapshot: () => RelayInstanceResources | null
  getLatestSampleSequence: () => number
  getSnapshot: () => Array<ResourceHistoryPoint>
  record: (
    history: ReadonlyArray<RelayInstanceResources>,
    current: RelayInstanceResources | null
  ) => void
  subscribe: (listener: () => void) => () => void
}

const stores = new Map<string, ResourceHistoryStore>()
export const RESOURCE_HISTORY_WINDOW_MS = 6 * 60_000

export function resourceHistoryStore(
  relayId: string,
  instanceId: string
): ResourceHistoryStore {
  const key = `${relayId}:${instanceId}`
  const existing = stores.get(key)
  if (existing) return existing

  let points: Array<ResourceHistoryPoint> = []
  let currentSnapshot: RelayInstanceResources | null = null
  let latestSampleSequence = 0
  let latestSampleTimestamp: number | null = null
  const listeners = new Set<() => void>()
  const store: ResourceHistoryStore = {
    getCurrentSnapshot: () => currentSnapshot,
    getLatestSampleSequence: () => latestSampleSequence,
    getSnapshot: () => points,
    record: (history, current) => {
      const currentChanged =
        current?.sampledAt !== currentSnapshot?.sampledAt ||
        (current === null) !== (currentSnapshot === null)
      if (currentChanged) currentSnapshot = current
      const byTimestamp = new Map(
        points.map((point) => [point.timestamp, point])
      )
      for (const resources of current ? [...history, current] : history) {
        const point = historyPoint(resources)
        if (point) byTimestamp.set(point.timestamp, point)
      }
      const cutoff = Date.now() - RESOURCE_HISTORY_WINDOW_MS
      const next = [...byTimestamp.values()]
        .filter((point) => point.timestamp >= cutoff)
        .sort((left, right) => left.timestamp - right.timestamp)
      if (
        next.length === points.length &&
        next.at(-1)?.timestamp === points.at(-1)?.timestamp
      ) {
        if (!currentChanged) return
      }
      const nextLatestSampleTimestamp = next.at(-1)?.timestamp ?? null
      if (nextLatestSampleTimestamp === null) {
        latestSampleSequence = 0
      } else if (
        latestSampleTimestamp !== null &&
        nextLatestSampleTimestamp !== latestSampleTimestamp
      ) {
        latestSampleSequence += 1
      }
      latestSampleTimestamp = nextLatestSampleTimestamp
      points = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  stores.set(key, store)
  return store
}

function historyPoint(
  resources: RelayInstanceResources
): ResourceHistoryPoint | null {
  const timestamp = Date.parse(resources.sampledAt)
  if (!Number.isFinite(timestamp)) return null
  return {
    timestamp,
    cpu: resources.cpu.percent,
    memory: resources.memory.percent,
    storage:
      resources.storage.totalBytes > 0 ? resources.storage.percent : null,
    storageNode: resources.storage.nodePercent,
    network: resources.network
      ? resources.network.receivedBytesPerSecond +
        resources.network.sentBytesPerSecond
      : null,
    networkReceived: resources.network?.receivedBytesPerSecond ?? null,
    networkSent: resources.network?.sentBytesPerSecond ?? null,
  }
}
