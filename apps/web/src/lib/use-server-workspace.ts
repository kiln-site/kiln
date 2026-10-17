import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useRouterState } from "@tanstack/react-router"

import type { RelayFleetSnapshot } from "@/lib/relay-fleet"
import {
  serverWorkspaceQueryOptions,
  type ServerWorkspace,
  type ServerWorkspaceRelay,
} from "@/lib/server-workspace"

const noServer: RelayFleetSnapshot = { instances: [], nodes: [] }

/** The game server the current route shows, on a game server page. */
export function useRouteServerId(): string | undefined {
  return useRouterState({
    select: (state) => {
      const params = state.matches.at(-1)?.params
      return params &&
        "serverId" in params &&
        typeof params.serverId === "string"
        ? params.serverId
        : undefined
    },
  })
}

/**
 * Selects from the current game server page's own snapshot, which holds its
 * server and node in the fleet's shape. Off a game server page there is
 * nothing to select.
 */
export function useServerSnapshot<TData>(
  select: (snapshot: RelayFleetSnapshot) => TData
) {
  const serverId = useRouteServerId()
  const selectWorkspace = React.useCallback(
    (workspace: ServerWorkspace) =>
      select(workspace.status === "found" ? workspace.snapshot : noServer),
    [select]
  )
  return useQuery({
    ...serverWorkspaceQueryOptions(serverId ?? ""),
    enabled: serverId !== undefined,
    select: selectWorkspace,
  })
}

/** Selects from the current game server page's Relay connection. */
export function useServerRelay<TData>(
  select: (relay: ServerWorkspaceRelay | undefined) => TData
) {
  const serverId = useRouteServerId()
  const selectWorkspace = React.useCallback(
    (workspace: ServerWorkspace) =>
      select(workspace.status === "found" ? workspace.relay : undefined),
    [select]
  )
  return useQuery({
    ...serverWorkspaceQueryOptions(serverId ?? ""),
    enabled: serverId !== undefined,
    select: selectWorkspace,
  })
}

export function selectServerRelayConnected(
  relay: ServerWorkspaceRelay | undefined
): boolean {
  return relay?.status === "connected"
}
