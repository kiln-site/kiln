import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"

import {
  useInstanceIdentity,
  useInstancePermissions,
  useInstanceRelayConnected,
} from "@/components/instance-workspace-context"
import { ServerInfoPage } from "@/components/server/server-info-page"
import { pageTitle } from "@/lib/page-title"
import { useServerSnapshot } from "@/lib/use-server-workspace"
import { selectInstanceSettings } from "@/lib/relay-selectors"
import { requireServerDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/server/$serverId/info")({
  beforeLoad: async ({ context, params }) => {
    await requireServerDestinationAccess(
      context.queryClient,
      context.instance,
      "info",
      params.serverId
    )
  },
  component: InfoRoute,
  head: () => ({ meta: [{ title: pageTitle("Info") }] }),
})

function InfoRoute() {
  const navigate = Route.useNavigate()
  const workspaceInstance = useInstanceIdentity()
  const permissions = useInstancePermissions()
  const relayConnected = useInstanceRelayConnected()
  const selectInfo = React.useMemo(
    () =>
      selectInstanceSettings(workspaceInstance.id, workspaceInstance.relayId),
    [workspaceInstance.id, workspaceInstance.relayId]
  )
  const { data } = useServerSnapshot(selectInfo)
  const returnToServers = React.useCallback(
    () => navigate({ to: "/infra/servers" }),
    [navigate]
  )
  if (!data) return null
  return (
    <ServerInfoPage
      key={`${data.instance.relayId}:${data.instance.id}`}
      instance={data.instance}
      node={data.node}
      permissions={permissions}
      relayConnected={relayConnected}
      onDeleted={returnToServers}
    />
  )
}
