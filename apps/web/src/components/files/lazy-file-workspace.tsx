import * as React from "react"

import type { FileWorkspace as FileWorkspaceComponent } from "@/components/files/file-workspace"
import {
  loadFileWorkspaceModule,
  loadedFileWorkspaceModule,
} from "@/lib/workspace-module-preloads"

const SuspendingFileWorkspace = React.lazy(async () => {
  const module = await loadFileWorkspaceModule()
  return { default: module.FileWorkspace }
})

/**
 * The file workspace, loaded on demand. Once its module has loaded it renders
 * at once: a lazy component suspends on its first render even then, and React
 * holds content revealed after a fallback for up to 300 ms.
 */
export function LazyFileWorkspace(
  props: React.ComponentProps<typeof FileWorkspaceComponent>
) {
  // Chosen once per mount: changing the component type would remount it.
  const [Workspace] = React.useState(
    () => loadedFileWorkspaceModule()?.FileWorkspace ?? SuspendingFileWorkspace
  )
  return <Workspace {...props} />
}
