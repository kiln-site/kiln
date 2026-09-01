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
  relaySnapshotQueryOptions,
  tailscaleStacksQueryOptions,
} from "@/lib/query-options"
import {
  selectInstanceRelayConnected,
  selectInstanceRuntime,
  selectRelayBrowserOrigin,
  selectRelayConsoleTransport,
} from "@/lib/relay-selectors"
import type { ConsoleLoadTiming } from "@/lib/console-performance"
import type { TailscaleStackOverview } from "@/server/tailscale"

const emptyTailscaleStacks: Array<TailscaleStackOverview> = []

export function ConsoleStreamController({
  instanceId,
  loadTiming,
  relayId,
  streamStore,
}: {
  instanceId: string
  loadTiming?: ConsoleLoadTiming
  relayId: string
  streamStore: ConsoleStreamStore
}) {
  const relayConnected = useInstanceRelayConnected()
  const browserOrigin = useRelayBrowserOrigin(relayId)
  const consoleTransport = useRelayConsoleTransport(relayId)
  const selectRuntime = React.useMemo(
    () => selectInstanceRuntime(instanceId, relayId),
    [instanceId, relayId]
  )
  const { data: runtime } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: selectRuntime,
  })
  const snapshot = useRelayConsoleStream(
    relayId,
    instanceId,
    relayConnected,
    browserOrigin,
    consoleTransport,
    runtime,
    loadTiming
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
  const selectRuntime = React.useMemo(
    () => selectInstanceRuntime(instanceId, relayId),
    [instanceId, relayId]
  )
  const selectConnected = React.useMemo(
    () => selectInstanceRelayConnected(instanceId, relayId),
    [instanceId, relayId]
  )
  const { data: runtime } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: selectRuntime,
  })
  const { data: relayConnected = false } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: selectConnected,
  })
  const browserOrigin = useRelayBrowserOrigin(relayId)
  const consoleTransport = useRelayConsoleTransport(relayId)
  const snapshot = useRelayConsoleStream(
    relayId,
    instanceId,
    relayConnected,
    browserOrigin,
    consoleTransport,
    runtime
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

function useRelayBrowserOrigin(relayId: string): string | null {
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

function useRelayConsoleTransport(relayId: string): "direct" | "hearth" | null {
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
