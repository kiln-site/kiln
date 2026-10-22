import * as React from "react"
import { createFileRoute, useMatch } from "@tanstack/react-router"
import { FileCode2 } from "lucide-react"

import {
  FileTreeLoadingPanel,
  FileWorkspaceLoadingState,
} from "@/components/file-tree-loading-panel"
import { LazyFileWorkspace } from "@/components/files/lazy-file-workspace"
import {
  useFileTreePreferences,
  useInstanceIdentity,
  useInstancePermissions,
  useInstanceRelayConnected,
} from "@/components/instance-workspace-context"
import { pageTitle } from "@/lib/page-title"
import { requireServerDestinationAccess } from "@/lib/route-access"
import { filePageLocation, startFilePageReads } from "@/lib/file-page-reads"
import {
  loadFileWorkspaceModule,
  warmFilePreviewModule,
} from "@/lib/workspace-module-preloads"

export const Route = createFileRoute("/_app/server/$serverId/files")({
  beforeLoad: async ({ context, params }) => {
    await requireServerDestinationAccess(
      context.queryClient,
      context.instance,
      "files",
      params.serverId
    )
  },
  loader: async ({ context, location, params }) => {
    const { instance, queryClient } = context
    if (!instance) return
    // FileWorkspace observes these same query keys and reuses the work.
    startFilePageReads(
      queryClient,
      { instanceId: instance.id, relayId: instance.relayId },
      filePageLocation({ location, params })
    )
    if (typeof window === "undefined") return
    // Loaded with the route, or on hover, the workspace renders without
    // suspending behind its fallback.
    await loadFileWorkspaceModule()
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
    if (filePath && !window.location.pathname.endsWith("/")) {
      warmFilePreviewModule(filePath)
    }
  }, [filePath])

  const fileTreePreferences = useFileTreePreferences()
  const instance = useInstanceIdentity()
  const permissions = useInstancePermissions()
  const relayConnected = useInstanceRelayConnected()

  return (
    <LazyFileWorkspace
      fallback={
        <div className="flex min-h-0 flex-1 bg-card">
          <FileTreeLoadingPanel
            collapsed={false}
            width={fileTreePreferences.width}
          />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex h-14 shrink-0 border-b">
              <div className="flex min-w-0 flex-1 items-center gap-2.5 px-3 md:gap-3">
                <FileCode2 className="size-5 shrink-0 text-primary-ink" />
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
      key={`${instance.relayId}:${instance.id}`}
      instance={instance}
      route={{ id: serverId, kind: "server" }}
      active
      routeFilePath={filePath}
      canShare={permissions.shareLogs}
      canWrite={permissions.filesWrite}
      relayConnected={relayConnected}
      openTreeOnEntry
      initialTreeCollapsed={fileTreePreferences.collapsed}
      initialTreeWidth={fileTreePreferences.width}
    />
  )
}

function normalizeFilePath(path: string) {
  return path.replace(/^\/+/, "")
}

function fileNameFromPath(path: string) {
  const normalized = normalizeFilePath(path)
  return normalized.split("/").filter(Boolean).at(-1) ?? normalized
}
