import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useMatch } from "@tanstack/react-router"

import { ResourceFilesPage } from "@/components/files/resource-files-page"
import {
  HostFilesLimitation,
  RelayHostFilesAccess,
} from "@/components/relay/relay-host-access"
import { useRelayLiveStatus } from "@/components/relay/relay-presentation"
import { useRelayWorkspace } from "@/components/relay/relay-workspace-context"
import { canAccessRelayPermission } from "@/lib/navigation-destinations"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"
import type { FileWorkspaceInstance } from "@/lib/relay-selectors"
import { warmFileWorkspaceModule } from "@/lib/workspace-module-preloads"

export function RelayFilesPage() {
  React.useEffect(warmFileWorkspaceModule, [])
  const { relay, routeId } = useRelayWorkspace()
  const { connected } = useRelayLiveStatus(relay)
  const filePath = useMatch({
    from: "/_app/relay/$relayId/files/$",
    shouldThrow: false,
    select: (match) => match.params._splat,
  })
  const { data: canWrite = false } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: (capabilities) =>
      canAccessRelayPermission(capabilities, relay.id, "relay.files.write"),
  })
  const instance = React.useMemo<FileWorkspaceInstance>(
    () => ({
      id: relay.id,
      name: relay.name,
      relayId: relay.id,
      shortId: relay.id.slice(0, 8),
      implementation: "",
      version: "",
      observedState: "running",
    }),
    [relay.id, relay.name]
  )
  const route = React.useMemo(
    () => ({ kind: "relay" as const, id: routeId }),
    [routeId]
  )
  return (
    <RelayHostFilesAccess>
      {(limitation) => (
        <div className="flex min-h-0 flex-1 flex-col">
          {limitation ? <HostFilesLimitation limitation={limitation} /> : null}
          <ResourceFilesPage
            instance={instance}
            route={route}
            filePath={filePath}
            canWrite={canWrite && limitation !== "read-only"}
            connected={connected}
          />
        </div>
      )}
    </RelayHostFilesAccess>
  )
}
