import type * as React from "react"
import type { RelayFileEntry } from "@workspace/contracts"

import { FilePageContent } from "@/components/files/file-page-content"
import { fileViewerModule } from "@/lib/file-viewer-modules"
import type { FileContentViewerKind } from "@/lib/file-viewers"
import type { FileWorkspaceInstance } from "@/lib/relay-selectors"
import { usePreloadedModule } from "@/lib/use-preloaded-module"

/** What every viewer that reads a file its own way is given. */
export interface FileContentViewerProps {
  readonly canShare: boolean
  readonly canWrite: boolean
  readonly displayPath: string
  /** The file as last listed: its size and when it last changed. */
  readonly entry: RelayFileEntry
  readonly instance: FileWorkspaceInstance
  /** Shows the file in the text editor instead, as when it isn't what its name says. */
  readonly onShowAsText: () => void
  readonly onTreeExpand: () => void
  readonly treeCollapsed: boolean
}

/** A file shown by the viewer for `kind`, once that viewer has loaded. */
export function FileContentViewer({
  fallback,
  kind,
  ...props
}: FileContentViewerProps & {
  fallback: React.ReactNode
  kind: FileContentViewerKind
}) {
  const viewer = fileViewerModule(kind)
  const Viewer = usePreloadedModule(viewer.load, viewer.loaded)
  if (!Viewer) return fallback
  return (
    <>
      <Viewer {...props} />
      {/* The viewer is on screen; what it shows may load after. */}
      <FilePageContent path={props.displayPath} view={kind} />
    </>
  )
}
