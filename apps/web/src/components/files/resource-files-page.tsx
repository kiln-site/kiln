import * as React from "react"
import { useSuspenseQuery } from "@tanstack/react-query"

import {
  FileTreeLoadingPanel,
  FileWorkspaceLoadingState,
} from "@/components/file-tree-loading-panel"
import { LazyFileWorkspace } from "@/components/files/lazy-file-workspace"
import { uiPreferencesQueryOptions } from "@/lib/query-options"
import type { FileWorkspaceInstance } from "@/lib/relay-selectors"
import { warmFilePreviewModule } from "@/lib/workspace-module-preloads"

export function ResourceFilesPage({
  instance,
  route,
  filePath,
  canWrite,
  connected,
}: {
  instance: FileWorkspaceInstance
  route: { id: string; kind: "app" | "relay" }
  filePath?: string
  canWrite: boolean
  connected: boolean
}) {
  const { data: preferences } = useSuspenseQuery({
    ...uiPreferencesQueryOptions(),
    select: selectFileTreePreferences,
  })
  React.useLayoutEffect(() => {
    // The router can trim a directory's trailing slash from its splat.
    if (filePath && !window.location.pathname.endsWith("/")) {
      warmFilePreviewModule(filePath)
    }
  }, [filePath])
  return (
    <LazyFileWorkspace
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
      key={`${instance.relayId}:${instance.id}`}
      instance={instance}
      route={route}
      active
      routeFilePath={filePath}
      canShare={false}
      canWrite={canWrite}
      relayConnected={connected}
      openTreeOnEntry
      initialTreeCollapsed={preferences.fileTreeCollapsed}
      initialTreeWidth={preferences.fileTreeWidth}
    />
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
