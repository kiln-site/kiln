import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import type { ConsoleStreamStore } from "@/components/console/console-stores"
import { useRelayConsoleStream } from "@/components/console/use-relay-console-stream"
import { useInstanceRelayConnected } from "@/components/instance-workspace-context"
import { relayConnectionQueryOptions } from "@/lib/query-options"
import {
  selectInstanceConsoleRuntime,
  selectRelayBrowserOrigin,
  selectRelayConsoleTransport,
} from "@/lib/relay-selectors"
import type { ConsoleLoadTiming } from "@/lib/console-performance"
import type { ServerWorkspaceRelay } from "@/lib/server-workspace"
import { useServerRelay, useServerSnapshot } from "@/lib/use-server-workspace"

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
