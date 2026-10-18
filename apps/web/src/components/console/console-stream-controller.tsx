import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import type {
  ConsoleAggregateStreamStore,
  ConsoleStreamStore,
} from "@/components/console/console-stores"
import { useRelayConsoleStream } from "@/components/console/use-relay-console-stream"
import { useInstanceRelayConnected } from "@/components/instance-workspace-context"
import {
  relayConnectionQueryOptions,
  tailscaleStacksQueryOptions,
} from "@/lib/query-options"
import {
  selectInstanceConsoleRuntime,
  selectRelayBrowserOrigin,
  selectRelayConsoleTransport,
} from "@/lib/relay-selectors"
import type { ConsoleLoadTiming } from "@/lib/console-performance"
import type { ServerWorkspaceRelay } from "@/lib/server-workspace"
import {
  selectServerRelayConnected,
  useServerRelay,
  useServerSnapshot,
} from "@/lib/use-server-workspace"
import { relayInstanceRouteId } from "@/lib/relay-fleet"
import type { TailscaleStackOverview } from "@/server/tailscale"

const emptyTailscaleStacks: Array<TailscaleStackOverview> = []

function selectBrowserOrigin(relay: ServerWorkspaceRelay | undefined) {
  return relay?.browserOrigin ?? null
}

function selectConsoleTransport(relay: ServerWorkspaceRelay | undefined) {
  return relay?.consoleTransport ?? null
}

export function ConsoleStreamController({
  instanceId,
  canWrite,
  loadTiming,
  relayId,
  streamStore,
}: {
  instanceId: string
  canWrite: boolean
  loadTiming?: ConsoleLoadTiming
  relayId: string
  streamStore: ConsoleStreamStore
}) {
  const relayConnected = useInstanceRelayConnected()
  const retryVersion = React.useSyncExternalStore(
    streamStore.subscribeRetry,
    streamStore.getRetrySnapshot,
    streamStore.getRetrySnapshot
  )
  const { data: browserOrigin = null } = useServerRelay(selectBrowserOrigin)
  const { data: consoleTransport = null } = useServerRelay(
    selectConsoleTransport
  )
  const selectRuntime = React.useMemo(
    () => selectInstanceConsoleRuntime(instanceId, relayId),
    [instanceId, relayId]
  )
  const { data: runtime } = useServerSnapshot(selectRuntime)
  const snapshot = useRelayConsoleStream(
    relayId,
    { id: instanceId, kind: "instance" },
    relayConnected,
    browserOrigin,
    consoleTransport,
    runtime,
    loadTiming,
    canWrite,
    retryVersion
  )
  const effectiveSnapshot = React.useMemo(
    () =>
      relayConnected
        ? snapshot
        : {
            ...snapshot,
            connection: "unavailable" as const,
            error: "Hearth cannot reach this Relay right now.",
            loading: false,
          },
    [relayConnected, snapshot]
  )
  React.useLayoutEffect(
    () => streamStore.setSnapshot(effectiveSnapshot),
    [effectiveSnapshot, streamStore]
  )
  return null
}

export function TailscaleConsoleStreamController({
  instanceId,
  streamStore,
}: {
  instanceId: string
  streamStore: ConsoleAggregateStreamStore
}) {
  const { data } = useQuery({
    ...tailscaleStacksQueryOptions(),
    notifyOnChangeProps: ["data"],
  })
  const stacks = data?.stacks ?? emptyTailscaleStacks
  const stack = stacks.find((candidate) => candidate.id === instanceId)

  return stack?.deployments.map((deployment) => (
    <TailscaleConsoleStreamSource
      key={deployment.relayId}
      instanceId={instanceId}
      relayId={deployment.relayId}
      relayName={deployment.relayName}
      streamStore={streamStore}
    />
  ))
}

function TailscaleConsoleStreamSource({
  instanceId,
  relayId,
  relayName,
  streamStore,
}: {
  instanceId: string
  relayId: string
  relayName: string
  streamStore: ConsoleAggregateStreamStore
}) {
  const retryVersion = React.useSyncExternalStore(
    streamStore.subscribeRetry,
    streamStore.getRetrySnapshot,
    streamStore.getRetrySnapshot
  )
  // Each deployment is its own server on its Relay; read that one alone, by
  // its exact Relay-qualified ID.
  const serverId = relayInstanceRouteId(relayId, instanceId)
  const selectRuntime = React.useMemo(
    () => selectInstanceConsoleRuntime(instanceId, relayId),
    [instanceId, relayId]
  )
  const { data: runtime } = useServerSnapshot(selectRuntime, serverId)
  const { data: relayConnected = false } = useServerRelay(
    selectServerRelayConnected,
    serverId
  )
  const { data: browserOrigin = null } = useServerRelay(
    selectBrowserOrigin,
    serverId
  )
  const { data: consoleTransport = null } = useServerRelay(
    selectConsoleTransport,
    serverId
  )
  const snapshot = useRelayConsoleStream(
    relayId,
    { id: instanceId, kind: "instance" },
    relayConnected,
    browserOrigin,
    consoleTransport,
    runtime,
    undefined,
    false,
    retryVersion
  )
  const effectiveSnapshot = React.useMemo(
    () =>
      relayConnected
        ? snapshot
        : {
            ...snapshot,
            connection: "unavailable" as const,
            error: "Hearth cannot reach this Relay right now.",
            loading: false,
          },
    [relayConnected, snapshot]
  )

  React.useLayoutEffect(() => {
    streamStore.setSourceSnapshot(
      relayId,
      { id: relayId, name: relayName },
      effectiveSnapshot
    )
  }, [effectiveSnapshot, relayId, relayName, streamStore])
  React.useEffect(
    () => () => streamStore.removeSource(relayId),
    [relayId, streamStore]
  )
  return null
}

export function useRelayBrowserOrigin(relayId: string): string | null {
  const queryClient = useQueryClient()
  const selectBrowserOrigin = React.useMemo(
    () => selectRelayBrowserOrigin(relayId),
    [relayId]
  )
  const { data = null } = useQuery({
    ...relayConnectionQueryOptions(queryClient),
    select: selectBrowserOrigin,
  })
  return data
}

export function useRelayConsoleTransport(
  relayId: string
): "direct" | "hearth" | null {
  const queryClient = useQueryClient()
  const selectConsoleTransport = React.useMemo(
    () => selectRelayConsoleTransport(relayId),
    [relayId]
  )
  const { data = null } = useQuery({
    ...relayConnectionQueryOptions(queryClient),
    select: selectConsoleTransport,
  })
  return data
}
