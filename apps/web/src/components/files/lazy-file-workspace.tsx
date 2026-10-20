import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"

import type { FileWorkspace as FileWorkspaceComponent } from "@/components/files/file-workspace"
import {
  relayFileActivityQueryOptions,
  relayFileEntryQueryOptions,
  relayRootDirectoryQueryOptions,
} from "@/lib/query-options"
import {
  loadFileWorkspaceModule,
  loadedFileWorkspaceModule,
} from "@/lib/workspace-module-preloads"
import { usePreloadedModule } from "@/lib/use-preloaded-module"

/**
 * Load code and data together. A local loading state reveals the workspace
 * immediately; suspending after the host-access check would hold its reveal
 * for up to 300 ms and delay every query inside it.
 */
export function LazyFileWorkspace({
  fallback,
  ...props
}: React.ComponentProps<typeof FileWorkspaceComponent> & {
  fallback: React.ReactNode
}) {
  const queryClient = useQueryClient()
  const module = usePreloadedModule(
    loadFileWorkspaceModule,
    loadedFileWorkspaceModule
  )

  const { id, relayId } = props.instance
  const path = props.routeFilePath?.replace(/^\/+/, "") ?? ""
  React.useEffect(() => {
    void queryClient.prefetchInfiniteQuery(
      relayRootDirectoryQueryOptions(relayId, id)
    )
    if (!path) {
      void queryClient.prefetchQuery(relayFileActivityQueryOptions(relayId, id))
    } else if (props.relayConnected) {
      void queryClient.prefetchQuery(
        relayFileEntryQueryOptions(relayId, id, path)
      )
    }
  }, [id, path, props.relayConnected, queryClient, relayId])

  const Workspace = module?.FileWorkspace
  return Workspace ? <Workspace {...props} /> : fallback
}
