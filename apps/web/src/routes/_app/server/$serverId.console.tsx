import { createFileRoute } from "@tanstack/react-router"

import { ConsoleWorkspace } from "@/components/console/console-workspace"
import {
  useInstanceIdentity,
  useInstancePermissions,
} from "@/components/instance-workspace-context"
import { forkPromise } from "@/effect/promise"
import { canAccessInstancePermission } from "@/lib/navigation-destinations"
import { pageTitle } from "@/lib/page-title"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"
import { prewarmRelayConsole } from "@/lib/relay-console-stream"
import { ensureServerWorkspace } from "@/lib/server-workspace"
import { requireServerDestinationAccess } from "@/lib/route-access"

export const Route = createFileRoute("/_app/server/$serverId/console")({
  beforeLoad: async ({ context, params }) => {
    await requireServerDestinationAccess(
      context.queryClient,
      context.instance,
      "console",
      params.serverId
    )
  },
  loader: ({ context, params, preload }) => {
    // Hovering a console link starts its connection; a navigation opens the
    // console itself at once, so it does not prewarm a second one.
    const { instance, queryClient } = context
    if (!preload || typeof window === "undefined" || !instance) return
    forkPromise(async () => {
      const workspace = await ensureServerWorkspace(
        queryClient,
        params.serverId
      )
      const [server] =
        workspace.status === "found" ? workspace.snapshot.instances : []
      const capabilities = queryClient.getQueryData(
        accessCapabilitiesQueryOptions().queryKey
      )
      if (
        workspace.status !== "found" ||
        !server ||
        !capabilities ||
        workspace.relay.status !== "connected" ||
        workspace.relay.consoleTransport === "hearth" ||
        !workspace.relay.browserOrigin ||
        // An aggregate console streams each deployment on its own.
        server.implementation.toLowerCase() === "tailscale"
      ) {
        return
      }
      prewarmRelayConsole({
        browserOrigin: workspace.relay.browserOrigin,
        instanceId: server.id,
        relayId: server.relayId,
        write: canAccessInstancePermission(
          capabilities,
          { id: server.id, relayId: server.relayId },
          "instance.console.write"
        ),
      })
    })
  },
  component: ConsoleRoute,
  head: () => ({ meta: [{ title: pageTitle("Console") }] }),
  pendingMinMs: 0,
})

function ConsoleRoute() {
  const instance = useInstanceIdentity()
  const permissions = useInstancePermissions()
  return (
    <ConsoleWorkspace
      key={instance.id}
      instance={instance}
      active
      canShare={permissions.shareLogs}
      canWrite={permissions.consoleWrite}
    />
  )
}
