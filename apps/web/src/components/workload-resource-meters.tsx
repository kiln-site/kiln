import * as React from "react"
import { Effect, Queue, Stream } from "effect"
import type {
  RelayWorkloadResourceKind,
  RelayWorkloadUsageEvent,
} from "@workspace/contracts"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"

import {
  ResourceMeter,
  ResourceMeterStrip,
  UptimeMeter,
  resourceItem,
  type ResourceId,
} from "@/components/resource-meters"
import {
  relayBrowserAuthorizationChanges,
  shouldWaitForRelayBrowserAuthorization,
} from "@/lib/authenticated-relay-socket"
import { openRelayWorkloadUsageStream } from "@/lib/relay-resource-stream"
import {
  resourceHistoryStore,
  type ResourceHistoryStore,
} from "@/lib/resource-history-store"

// Apps and databases have no disk the Relay measures live.
const WORKLOAD_RESOURCE_IDS: Array<ResourceId> = ["cpu", "memory", "network"]
const ALL_SERVICES = "\u0000all"

/**
 * An App's or database's live usage, as a game server's header shows its
 * own: CPU, memory, and traffic with their recent history, and uptime. An
 * App with several services can show one of them instead of the whole.
 */
export const WorkloadResourceMeters = React.memo(
  function WorkloadResourceMeters({
    id,
    kind,
    relayConnected,
    relayId,
    running,
    services,
    startedAt,
  }: {
    id: string
    kind: RelayWorkloadResourceKind
    relayConnected: boolean
    relayId: string
    running: boolean
    // An App's services; none for a database.
    services: ReadonlyArray<string>
    startedAt: string | null
  }) {
    useWorkloadUsageStream(relayId, kind, id, relayConnected)
    const [chosen, setChosen] = React.useState(ALL_SERVICES)
    const service = services.includes(chosen) ? chosen : null
    const historyStore = React.useMemo(
      () => workloadHistoryStore(relayId, kind, id, service),
      [id, kind, relayId, service]
    )
    const noun = kind === "app" ? "App" : "Database"

    return (
      <div className="flex min-w-0 items-center gap-1.5">
        {services.length > 1 ? (
          <Select
            value={service ?? ALL_SERVICES}
            onValueChange={(value) => setChosen(value)}
          >
            <SelectTrigger
              aria-label="Service usage shown"
              className="hidden h-8 w-32 min-w-0 font-mono text-xs @[46rem]/workspace-header:flex [&_[data-slot=select-value]]:truncate"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_SERVICES}>All services</SelectItem>
              {services.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <ResourceMeterStrip
          columns={3}
          label={`${noun} resource usage`}
          uptime={
            <UptimeMeter
              label={`${noun} uptime`}
              running={running}
              startedAt={startedAt}
            />
          }
        >
          {WORKLOAD_RESOURCE_IDS.map((resourceId) => (
            <WorkloadResourceMeter
              key={resourceId}
              historyStore={historyStore}
              resourceId={resourceId}
              running={running}
            />
          ))}
        </ResourceMeterStrip>
      </div>
    )
  }
)

function WorkloadResourceMeter({
  historyStore,
  resourceId,
  running,
}: {
  historyStore: ResourceHistoryStore
  resourceId: ResourceId
  running: boolean
}) {
  const resources = React.useSyncExternalStore(
    historyStore.subscribe,
    historyStore.getCurrentSnapshot,
    () => null
  )
  const resource = resourceItem(resources, resourceId, {
    unavailable: running ? "Sampling" : "Stopped",
  })
  return <ResourceMeter resource={resource} historyStore={historyStore} />
}

// The resource's own, or one App service's, kept apart from game servers'.
function workloadHistoryStore(
  relayId: string,
  kind: RelayWorkloadResourceKind,
  id: string,
  service: string | null
): ResourceHistoryStore {
  return resourceHistoryStore(
    relayId,
    service === null ? `${kind}:${id}` : `${kind}:${id}/${service}`
  )
}

function recordUsage(
  relayId: string,
  event: RelayWorkloadUsageEvent,
  current: boolean
): void {
  const record = (
    store: ResourceHistoryStore,
    usage: Pick<RelayWorkloadUsageEvent, "history" | "resources">
  ) =>
    store.record(
      usage.history,
      current ? usage.resources : store.getCurrentSnapshot()
    )
  record(workloadHistoryStore(relayId, event.kind, event.id, null), event)
  for (const service of event.services) {
    record(
      workloadHistoryStore(relayId, event.kind, event.id, service.service),
      service
    )
  }
}

// Follows the usage while the Relay is reachable, from the Relay or through
// Hearth, waiting out an authorization change before trying again.
function useWorkloadUsageStream(
  relayId: string,
  kind: RelayWorkloadResourceKind,
  id: string,
  relayConnected: boolean
): void {
  React.useEffect(() => {
    if (!relayConnected) return
    const connection = Effect.runFork(
      Effect.gen(function* () {
        const authorizationChanges = yield* relayBrowserAuthorizationChanges(
          relayId,
          id,
          kind
        )
        let retryDelay = 500
        for (;;) {
          const failed = yield* Effect.suspend(() => {
            let lastSequence = -1
            return openRelayWorkloadUsageStream(relayId, kind, id).pipe(
              Stream.runForEach((event) =>
                Effect.sync(() => {
                  retryDelay = 500
                  // Histories can arrive after newer samples: each is kept,
                  // and only a newer event's samples replace the latest.
                  const current = event.sequence >= lastSequence
                  lastSequence = Math.max(lastSequence, event.sequence)
                  recordUsage(relayId, event, current)
                })
              ),
              Effect.andThen(
                Effect.fail(new Error("Relay usage stream closed"))
              )
            )
          }).pipe(
            Effect.match({
              onFailure: (cause) => cause,
              onSuccess: () => null,
            })
          )
          if (shouldWaitForRelayBrowserAuthorization(failed)) {
            yield* Queue.take(authorizationChanges)
            continue
          }
          if (failed) {
            yield* Effect.sleep(retryDelay)
            retryDelay = Math.min(retryDelay * 2, 5_000)
          }
        }
      }).pipe(Effect.scoped)
    )
    return () => {
      connection.interruptUnsafe()
    }
  }, [id, kind, relayConnected, relayId])
}
