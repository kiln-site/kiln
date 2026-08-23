import * as React from "react"
import { createFileRoute, useMatch } from "@tanstack/react-router"
import { FileCode2 } from "lucide-react"

import {
  FileTreeLoadingPanel,
  FileWorkspaceLoadingState,
} from "@/components/file-tree-loading-panel"
import {
  useFileTreePreferences,
  useInstanceIdentity,
  useInstancePermissions,
  useInstanceRelayConnected,
} from "@/components/instance-workspace-context"
import { pageTitle } from "@/lib/page-title"
import {
  relayConnectionQueryOptions,
  relayFileActivityQueryOptions,
  relayRootDirectoryQueryOptions,
  relaySnapshotQueryOptions,
} from "@/lib/query-options"
import { findRelayInstance } from "@/lib/relay-selectors"
import { warmSyntaxCodeEditorModule } from "@/lib/syntax-editor-module-preload"
import { loadFileWorkspaceModule } from "@/lib/workspace-module-preloads"

const FileWorkspace = React.lazy(async () => {
  const module = await loadFileWorkspaceModule()
  return { default: module.FileWorkspace }
})

export const Route = createFileRoute("/_app/server/$serverId/files")({
  loader: async ({ context, params }) => {
    if (params.serverId === "unavailable") return

    const connection = await context.queryClient.ensureQueryData(
      relayConnectionQueryOptions(context.queryClient)
    )
    const snapshot =
      connection.status === "connected"
        ? connection.snapshot
        : await context.queryClient.ensureQueryData(relaySnapshotQueryOptions())
    const instance = findRelayInstance(snapshot.instances, params.serverId)
    if (!instance) return

    // Start data work with the route chunk without holding the transition open.
    // FileWorkspace observes these same query keys and reuses the in-flight work.
    void Promise.all([
      context.queryClient.prefetchQuery(
        relayRootDirectoryQueryOptions(instance.relayId, instance.id)
      ),
      context.queryClient.prefetchQuery(
        relayFileActivityQueryOptions(instance.relayId, instance.id)
      ),
    ])
  },
  head: () => ({ meta: [{ title: pageTitle("Files") }] }),
  component: FilesRoute,
  pendingMinMs: 0,
})

function FilesRoute() {
  const { serverId } = Route.useParams()
  const filePath = useMatch({
    from: "/_app/server/$serverId/files/$",
    shouldThrow: false,
    select: (match) => match.params._splat,
  })

  React.useLayoutEffect(() => {
    if (filePath) warmSyntaxCodeEditorModule()
  }, [filePath])

  const fileTreePreferences = useFileTreePreferences()
  const instance = useInstanceIdentity()
  const permissions = useInstancePermissions()
  const relayConnected = useInstanceRelayConnected()

  return (
    <React.Suspense
      fallback={
        <div className="flex min-h-0 flex-1 bg-card">
          <FileTreeLoadingPanel
            collapsed={false}
            width={fileTreePreferences.width}
          />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex h-14 shrink-0 border-b">
              <div className="flex min-w-0 flex-1 items-center gap-2.5 px-3 md:gap-3">
                <FileCode2 className="size-5 shrink-0 text-primary" />
                {filePath ? (
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">
                      {fileNameFromPath(filePath)}
                    </p>
                    <p className="type-code truncate text-muted-foreground">
                      /data/{normalizeFilePath(filePath)}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <div className="h-3 w-24 animate-pulse bg-muted/35" />
                    <div className="h-2.5 w-40 animate-pulse bg-muted/25" />
                  </div>
                )}
              </div>
            </div>
            <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
              <FileWorkspaceLoadingState
                title="Opening file workspace"
                description="Preparing the file browser and editor."
              />
            </div>
          </div>
        </div>
      }
    >
      <FileWorkspace
        key={`${instance.relayId}:${instance.id}`}
        instance={instance}
        serverId={serverId}
        active
        routeFilePath={filePath}
        canShare={permissions.shareLogs}
        canWrite={permissions.filesWrite}
        relayConnected={relayConnected}
        openTreeOnEntry
        initialTreeCollapsed={fileTreePreferences.collapsed}
        initialTreeWidth={fileTreePreferences.width}
      />
    </React.Suspense>
  )
}

function normalizeFilePath(path: string) {
  return path.replace(/^\/+/, "")
}

function fileNameFromPath(path: string) {
  const normalized = normalizeFilePath(path)
  return normalized.split("/").filter(Boolean).at(-1) ?? normalized
}
