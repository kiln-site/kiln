import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Effect } from "effect"

import { useRelayLiveStatus } from "@/components/relay/relay-presentation"
import {
  ResourceMeter,
  UptimeMeter,
  resourceItem,
  type ResourceId,
} from "@/components/resource-meters"
import { relayResourcesQueryOptions } from "@/lib/query-options"
import type { RelayDirectoryEntry } from "@/lib/relay-route"
import {
  resourceHistoryStore,
  type ResourceHistoryStore,
} from "@/lib/resource-history-store"
import { getRelayResourceHistory } from "@/server/relay-host"

const RELAY_RESOURCE_IDS: Array<ResourceId> = ["cpu", "memory", "storage"]

// The Relay's own usage in its workspace header, like a server's: its
// container's CPU and memory, the disk Kiln uses on the node, and uptime.
export const RelayResourceMeters = React.memo(function RelayResourceMeters({
  relay,
}: {
  relay: RelayDirectoryEntry
}) {
  const historyStore = React.useMemo(
    () => resourceHistoryStore(relay.id, "relay"),
    [relay.id]
  )
  const { connected, relayStatus } = useRelayLiveStatus(relay)
  const unavailable = connected
    ? "Sampling"
    : relayStatus === "paused"
      ? "Paused"
      : "Offline"
  const { data: supported = true } = useQuery({
    ...relayResourcesQueryOptions(relay.id),
    enabled: connected,
    select: (reading) => reading.supported,
  })
  if (!supported) return null

  return (
    <div
      className="hidden min-w-0 md:col-span-2 md:block xl:col-span-1 xl:col-start-2 xl:row-start-1"
      aria-label="Relay resource usage"
    >
      {connected ? (
        <RelayResourceSampler historyStore={historyStore} relayId={relay.id} />
      ) : null}
      <div className="grid h-14 min-w-0 grid-cols-[repeat(3,minmax(0,1fr))_5.5rem] divide-x divide-border/60 border border-border/80 bg-card/40 px-1.5 py-2 xl:grid-cols-[repeat(3,minmax(0,1fr))_5.75rem]">
        {RELAY_RESOURCE_IDS.map((resourceId) => (
          <RelayResourceMeter
            key={resourceId}
            connected={connected}
            historyStore={historyStore}
            resourceId={resourceId}
            unavailable={unavailable}
          />
        ))}
        <RelayUptimeMeter connected={connected} relayId={relay.id} />
      </div>
    </div>
  )
})

// Fills the history once, then records each polled sample. Renders nothing,
// so polling doesn't re-render the meters around it.
function RelayResourceSampler({
  historyStore,
  relayId,
}: {
  historyStore: ResourceHistoryStore
  relayId: string
}) {
  const { data: resources } = useQuery({
    ...relayResourcesQueryOptions(relayId),
    select: (reading) => reading.resources,
  })

  React.useEffect(() => {
    const fiber = Effect.runFork(
      Effect.tryPromise(() =>
        getRelayResourceHistory({ data: { relayId } })
      ).pipe(
        Effect.tap((history) =>
          Effect.sync(() =>
            historyStore.record(history, historyStore.getCurrentSnapshot())
          )
        ),
        // The meters still fill from live samples.
        Effect.ignore
      )
    )
    return () => {
      fiber.interruptUnsafe()
    }
  }, [historyStore, relayId])

  React.useEffect(() => {
    if (resources) historyStore.record([], resources)
  }, [historyStore, resources])

  return null
}

function RelayResourceMeter({
  connected,
  historyStore,
  resourceId,
  unavailable,
}: {
  connected: boolean
  historyStore: ResourceHistoryStore
  resourceId: ResourceId
  unavailable: string
}) {
  const resources = React.useSyncExternalStore(
    historyStore.subscribe,
    historyStore.getCurrentSnapshot,
    () => null
  )
  const resource = resourceItem(connected ? resources : null, resourceId, {
    storageScope: "kiln",
    unavailable,
  })

  return <ResourceMeter resource={resource} historyStore={historyStore} />
}

function RelayUptimeMeter({
  connected,
  relayId,
}: {
  connected: boolean
  relayId: string
}) {
  const { data: startedAt = null } = useQuery({
    ...relayResourcesQueryOptions(relayId),
    enabled: connected,
    select: (reading) => reading.startedAt,
  })

  return (
    <UptimeMeter
      label="Relay uptime"
      running={connected}
      startedAt={startedAt}
    />
  )
}
