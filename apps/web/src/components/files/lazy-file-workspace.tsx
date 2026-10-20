import type * as React from "react"

import type { FileWorkspace as FileWorkspaceComponent } from "@/components/files/file-workspace"
import {
  loadFileWorkspaceModule,
  loadedFileWorkspaceModule,
} from "@/lib/workspace-module-preloads"
import { usePreloadedModule } from "@/lib/use-preloaded-module"

/**
 * The file workspace, revealed as soon as its module loads. A local loading
 * state shows it at once, where suspending would hold its reveal for up to
 * 300 ms. Its first reads start with the route (`startFilePageReads`).
 */
export function LazyFileWorkspace({
  fallback,
  ...props
}: React.ComponentProps<typeof FileWorkspaceComponent> & {
  fallback: React.ReactNode
}) {
  const module = usePreloadedModule(
    loadFileWorkspaceModule,
    loadedFileWorkspaceModule
  )
  const Workspace = module?.FileWorkspace
  return Workspace ? <Workspace {...props} /> : fallback
}
