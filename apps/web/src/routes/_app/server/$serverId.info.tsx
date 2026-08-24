import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"

import {
  useInstanceIdentity,
  useInstancePermissions,
  useInstanceRelayConnected,
} from "@/components/instance-workspace-context"
import { SettingsWorkspace } from "@/components/settings-workspace"
import { isDevelopmentBypassIdentity } from "@/lib/development-bypass"
import { pageTitle } from "@/lib/page-title"
import { relaySnapshotQueryOptions } from "@/lib/query-options"
import { selectInstanceSettings } from "@/lib/relay-selectors"

export const Route = createFileRoute("/_app/server/$serverId/info")({
  component: InfoRoute,
  head: () => ({ meta: [{ title: pageTitle("Info") }] }),
})

function InfoRoute() {
  const navigate = Route.useNavigate()
  const { user } = Route.useRouteContext()
  const workspaceInstance = useInstanceIdentity()
  const permissions = useInstancePermissions()
  const relayConnected = useInstanceRelayConnected()
  const selectInfo = React.useMemo(
    () =>
      selectInstanceSettings(workspaceInstance.id, workspaceInstance.relayId),
    [workspaceInstance.id, workspaceInstance.relayId]
  )
  const { data } = useQuery({
    ...relaySnapshotQueryOptions(),
    select: selectInfo,
  })
  const returnToServers = React.useCallback(
    () => navigate({ to: "/infra/servers" }),
    [navigate]
  )
  if (!data) return null
  return (
    <SettingsWorkspace
      key={`${data.instance.relayId}:${data.instance.id}`}
      instance={data.instance}
      node={data.node}
      canDelete={permissions.deleteServer}
      canRename={permissions.settings}
      canShare={permissions.shareLogs}
      passwordRequired={!isDevelopmentBypassIdentity(user)}
      relayConnected={relayConnected}
      onDeleted={returnToServers}
    />
  )
}
