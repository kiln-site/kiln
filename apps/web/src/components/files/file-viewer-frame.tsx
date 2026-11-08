import type * as React from "react"
import { HardDriveDownload } from "lucide-react"

import { FileWorkspaceLoadingState } from "@/components/file-tree-loading-panel"
import { EditorDownloadButton } from "@/components/files/file-editor-toolbar-actions"
import {
  fileEditorHeaderClassName,
  fileEditorHeaderContentClassName,
  FileToolbarIdentity,
  FileTreeRevealButton,
} from "@/components/files/file-viewer-toolbar"
import type { FileWorkspaceInstance } from "@/lib/relay-selectors"

/**
 * What every viewer that reads a file its own way shows around it: the
 * file's toolbar, with its own controls and a download, and a status line.
 */
export function FileViewerFrame({
  children,
  controls,
  displayPath,
  instance,
  onTreeExpand,
  status,
  statusDetail,
  treeCollapsed,
}: {
  children: React.ReactNode
  /** The viewer's own toolbar controls, such as zoom. */
  controls?: React.ReactNode
  displayPath: string
  instance: FileWorkspaceInstance
  onTreeExpand: () => void
  status?: React.ReactNode
  statusDetail?: React.ReactNode
  treeCollapsed: boolean
}) {
  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-card">
      <div className={fileEditorHeaderClassName} data-file-toolbar>
        {treeCollapsed ? <FileTreeRevealButton onClick={onTreeExpand} /> : null}
        <div className={fileEditorHeaderContentClassName}>
          <FileToolbarIdentity path={displayPath} />
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {controls}
            <EditorDownloadButton
              instance={instance}
              loading={false}
              path={displayPath}
            />
          </div>
        </div>
      </div>
      <div className="relative flex min-h-[360px] min-w-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
      <div className="type-meta flex h-7 shrink-0 items-center justify-between gap-3 border-t bg-muted/10 px-3 font-mono text-muted-foreground">
        <span className="truncate">{status}</span>
        <span className="shrink-0">{statusDetail}</span>
      </div>
    </section>
  )
}

/** A viewer's body while its file is read. */
export function FileViewerLoading() {
  return (
    <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
      <FileWorkspaceLoadingState
        title="Reading from Relay"
        description="Fetching the file to show it here."
      />
    </div>
  )
}

/** A viewer's body when it can't show its file, which can still be downloaded. */
export function FileViewerUnavailable({ message }: { message: string }) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
      <div className="max-w-xs">
        <div className="mx-auto mb-4 grid size-11 place-items-center rounded-xl border bg-muted/20 text-muted-foreground">
          <HardDriveDownload className="size-5" />
        </div>
        <p className="text-sm font-semibold">Preview unavailable</p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {message}
        </p>
      </div>
    </div>
  )
}
