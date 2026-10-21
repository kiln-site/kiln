import * as React from "react"
import { useMatch } from "@tanstack/react-router"
import { appFileRootId } from "@workspace/contracts"

import { appFilesAvailable } from "@/components/app/app-presentation"
import { useAppWorkspace } from "@/components/app/app-workspace-context"
import { ResourceFilesPage } from "@/components/files/resource-files-page"
import type { FileWorkspaceInstance } from "@/lib/relay-selectors"

// An app's folder on the Relay in the same file workspace servers use: a
// Dockerfile's build context and a pasted Compose file's project directory.
// Its containers don't mount it.
export function AppFilesPage() {
  const { app, routeId } = useAppWorkspace()
  const filePath = useMatch({
    from: "/_app/app/$appId/files/$",
    shouldThrow: false,
    select: (match) => match.params._splat,
  })
  const instance = React.useMemo<FileWorkspaceInstance>(
    () => ({
      id: appFileRootId(app.id),
      implementation: "",
      name: app.name,
      observedState: app.observedState,
      relayId: app.relayId,
      shortId: app.shortId,
      version: "",
    }),
    [app.id, app.name, app.observedState, app.relayId, app.shortId]
  )
  const route = React.useMemo(
    () => ({ id: routeId, kind: "app" as const }),
    [routeId]
  )

  return (
    <ResourceFilesPage
      instance={instance}
      route={route}
      filePath={filePath}
      canWrite={app.permissions.includes("app.files.write")}
      connected={appFilesAvailable(app)}
    />
  )
}
