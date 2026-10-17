import * as React from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { useRouterState } from "@tanstack/react-router"

import {
  serverDirectoryQueryOptions,
  serverNavigationQueryOptions,
} from "@/lib/query-options"
import {
  resolveServerNavigation,
  type ServerNavigation,
  type ServerNavigationInput,
} from "@/lib/server-navigation"
import type { SidebarInstance } from "@/lib/relay-selectors"
import { readSelectedInstanceRouteId } from "@/lib/ui-preference-cookies"

/**
 * The game server the sidebar and command menu open. Pages load a small
 * summary instead of the whole directory; once something on the page has
 * loaded the directory, the same answer comes from it without a request.
 */
export function useServerNavigation(
  input: ServerNavigationInput,
  enabled: boolean
): { data: ServerNavigation<SidebarInstance> | undefined; isPending: boolean } {
  const serverId = "serverId" in input ? input.serverId : null
  const selectedRouteId =
    "selectedRouteId" in input ? input.selectedRouteId : null
  const select = React.useMemo(
    () => (instances: Array<SidebarInstance>) =>
      resolveServerNavigation(
        instances,
        serverId === null ? { selectedRouteId } : { serverId }
      ),
    [serverId, selectedRouteId]
  )
  const directory = useQuery({
    ...serverDirectoryQueryOptions(),
    select,
    // Keep a loaded directory current, but never load it just for this.
    enabled: (query) => enabled && query.state.data !== undefined,
  })
  const summary = useQuery({
    ...serverNavigationQueryOptions(input),
    enabled: enabled && directory.data === undefined,
    placeholderData: keepPreviousData,
  })
  return directory.data
    ? { data: directory.data, isPending: false }
    : { data: summary.data, isPending: enabled && summary.isPending }
}

/** Server navigation for the current route and remembered selection. */
export function useSidebarServerNavigation(
  initialSelectedInstanceRouteId: string | null,
  enabled: boolean
) {
  const serverId = useRouterState({
    select: (state) =>
      (state.matches.at(-1)?.params as { serverId?: string } | undefined)
        ?.serverId,
  })
  const selectedRouteId =
    serverId ?? readSelectedInstanceRouteId() ?? initialSelectedInstanceRouteId
  const navigation = useServerNavigation(
    serverId ? { serverId } : { selectedRouteId },
    enabled
  )
  return { ...navigation, selectedRouteId, serverId }
}
