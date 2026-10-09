import * as React from "react"
import { useSuspenseQuery } from "@tanstack/react-query"
import { useMatch } from "@tanstack/react-router"
import { appFileRootId } from "@workspace/contracts"

import { appRelayAvailable } from "@/components/app/app-presentation"
import { useAppWorkspace } from "@/components/app/app-workspace-context"
import {
  FileTreeLoadingPanel,
  FileWorkspaceLoadingState,
} from "@/components/file-tree-loading-panel"
import { uiPreferencesQueryOptions } from "@/lib/query-options"
import type { FileWorkspaceInstance } from "@/lib/relay-selectors"
import { warmSyntaxCodeEditorModule } from "@/lib/syntax-editor-module-preload"
import { loadFileWorkspaceModule } from "@/lib/workspace-module-preloads"

const FileWorkspace = React.lazy(async () => {
  const module = await loadFileWorkspaceModule()
  return { default: module.FileWorkspace }
})

// An app's data directory in the same file workspace servers use. It is
// mounted into the app's containers, at its data mount or `${KILN_DATA}`.
export function AppFilesPage() {
  const { app, routeId } = useAppWorkspace()
  const filePath = useMatch({
    from: "/_app/app/$appId/files/$",
    shouldThrow: false,
    select: (match) => match.params._splat,
  })
  const { data: preferences } = useSuspenseQuery({
    ...uiPreferencesQueryOptions(),
    select: selectFileTreePreferences,
  })

  React.useLayoutEffect(() => {
    if (filePath) warmSyntaxCodeEditorModule()
  }, [filePath])

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
    <React.Suspense
      fallback={
        <div className="flex min-h-0 flex-1 bg-card">
          <FileTreeLoadingPanel
            collapsed={false}
            width={preferences.fileTreeWidth}
          />
          <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
            <FileWorkspaceLoadingState
              title="Opening file workspace"
              description="Preparing the file browser and editor."
            />
          </div>
        </div>
      }
    >
      <FileWorkspace
        key={`${app.relayId}:${app.id}`}
        instance={instance}
        route={route}
        active
        routeFilePath={filePath}
        canShare={false}
        canWrite={app.permissions.includes("app.files.write")}
        relayConnected={appRelayAvailable(app)}
        openTreeOnEntry
        initialTreeCollapsed={preferences.fileTreeCollapsed}
        initialTreeWidth={preferences.fileTreeWidth}
      />
    </React.Suspense>
  )
}

function selectFileTreePreferences(preferences: {
  fileTreeCollapsed: boolean
  fileTreeWidth: number | null
}) {
  return {
    fileTreeCollapsed: preferences.fileTreeCollapsed,
    fileTreeWidth: preferences.fileTreeWidth,
  }
}
