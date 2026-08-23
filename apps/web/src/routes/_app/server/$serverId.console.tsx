import { createFileRoute } from "@tanstack/react-router"

import { ConsoleWorkspace } from "@/components/console/console-workspace"
import {
  useInstanceIdentity,
  useInstancePermissions,
} from "@/components/instance-workspace-context"
import { pageTitle } from "@/lib/page-title"

export const Route = createFileRoute("/_app/server/$serverId/console")({
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
