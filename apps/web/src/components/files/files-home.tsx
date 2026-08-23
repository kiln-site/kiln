import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import type { RelayFileActivityEntry } from "@workspace/contracts"
import { Clock3, FileCode2, LoaderCircle, Pin } from "lucide-react"

import { RootDirectoryList } from "@/components/files/file-directory-view"
import type { FileActionsController } from "@/components/files/file-tree-utils"
import {
  FileDropOverlay,
  type UploadFiles,
  useFileDropTarget,
} from "@/components/files/file-upload"
import type { ProgressiveFileIndex } from "@/components/files/progressive-file-index"
import { shortRelativeFileTime } from "@/components/files/file-time"
import {
  fileEditorHeaderClassName,
  fileEditorHeaderContentClassName,
  FileTreeRevealButton,
} from "@/components/files/file-viewer-toolbar"
import { relayFileActivityQueryOptions } from "@/lib/query-options"
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"

const recentFileDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
})
const olderFileDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
})

function formatName(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path
}

function queryErrorMessage(error: Error | null, fallback: string) {
  if (!error) return null
  return error.message || fallback
}

function fileActivityKind(entry: RelayFileActivityEntry): "Edited" | "Viewed" {
  if (
    entry.lastEditedAt &&
    new Date(entry.lastEditedAt).getTime() >=
      new Date(entry.lastViewedAt).getTime()
  ) {
    return "Edited"
  }
  return "Viewed"
}

function fileActivityTime(entry: RelayFileActivityEntry): string {
  const latest = entry.lastEditedAt
    ? Math.max(
        new Date(entry.lastViewedAt).getTime(),
        new Date(entry.lastEditedAt).getTime()
      )
    : new Date(entry.lastViewedAt).getTime()
  const relative = shortRelativeFileTime(latest)
  if (relative) return relative
  const activityDate = new Date(latest)
  const currentDate = new Date()
  return (
    activityDate.getFullYear() === currentDate.getFullYear()
      ? recentFileDateFormatter
      : olderFileDateFormatter
  ).format(activityDate)
}

function FileActivityRow({
  entry,
  onOpen,
}: {
  entry: RelayFileActivityEntry
  onOpen: (path: string) => void
}) {
  const kind = fileActivityKind(entry)
  return (
    <button
      type="button"
      className="group grid w-full grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 border-t border-border/55 px-2 py-3 text-left transition-colors first:border-t-0 hover:bg-accent/35 focus-visible:bg-accent/45 focus-visible:outline-none sm:px-3"
      onClick={() => onOpen(entry.path)}
    >
      <span className="grid size-8 place-items-center border border-border/70 bg-muted/20 text-muted-foreground transition-colors group-hover:border-primary/25 group-hover:text-primary">
        <FileCode2 className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">
          {formatName(entry.path)}
        </span>
        <span className="type-code mt-0.5 block truncate text-muted-foreground">
          /data/{entry.path}
        </span>
      </span>
      <span className="type-meta flex shrink-0 items-center gap-2 pl-2 text-muted-foreground">
        <span>
          {kind}{" "}
          <time
            dateTime={
              kind === "Edited"
                ? (entry.lastEditedAt ?? entry.lastViewedAt)
                : entry.lastViewedAt
            }
            suppressHydrationWarning
          >
            {fileActivityTime(entry)}
          </time>
        </span>
        {entry.pinned ? (
          <Pin
            className="size-3.5 fill-primary/15 text-primary"
            aria-label="Pinned"
          />
        ) : null}
      </span>
    </button>
  )
}

export function FilesHome({
  instance,
  fileIndex,
  fileTreeLoading,
  fileTreeError,
  treeCollapsed,
  onTreeExpand,
  onOpen,
  canWrite,
  onUploadFiles,
  actions,
}: {
  instance: InstanceWorkspaceInstance
  fileIndex: ProgressiveFileIndex
  fileTreeLoading: boolean
  fileTreeError: string | null
  treeCollapsed: boolean
  onTreeExpand: () => void
  onOpen: (path: string) => void
  canWrite: boolean
  onUploadFiles: UploadFiles
  actions: FileActionsController
}) {
  const sectionRef = React.useRef<HTMLElement>(null)
  const dropTarget = useFileDropTarget({
    directory: "",
    enabled: canWrite,
    onUploadFiles,
    ref: sectionRef,
  })
  const activityQuery = useQuery(
    relayFileActivityQueryOptions(instance.relayId, instance.id)
  )
  const activity = activityQuery.data?.files ?? []
  const loading = fileTreeLoading || activityQuery.isFetching
  const error =
    fileTreeError ??
    queryErrorMessage(activityQuery.error, "Could not load recent files")
  const pinned = activity.filter((entry) => entry.pinned)
  const recent = activity.filter((entry) => !entry.pinned).slice(0, 3)

  return (
    <section
      ref={sectionRef}
      className="group/drop relative flex min-h-[360px] min-w-0 flex-1 flex-col bg-card"
      {...dropTarget}
    >
      <FileDropOverlay directory="" />
      <div className={fileEditorHeaderClassName}>
        {treeCollapsed ? <FileTreeRevealButton onClick={onTreeExpand} /> : null}
        <div className={fileEditorHeaderContentClassName}>
          <div className="flex min-w-0 flex-1 items-center gap-2.5 md:gap-3">
            <Clock3 className="size-5 shrink-0 text-primary" />
            <p className="truncate text-sm font-semibold">Files</p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto w-full max-w-5xl">
          {loading ? (
            <div className="grid min-h-44 place-items-center border border-border/70 bg-muted/5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin text-primary" />
                Loading file activity
              </div>
            </div>
          ) : null}

          {!loading && error ? (
            <div className="border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
              {error}
            </div>
          ) : null}

          {!loading && !error && pinned.length > 0 ? (
            <div className="mb-7">
              <div className="mb-2 flex items-center gap-2 px-1">
                <Pin className="size-3.5 text-primary" />
                <h2 className="type-technical-label text-muted-foreground">
                  Pinned
                </h2>
              </div>
              <div className="border border-border/75 bg-muted/5">
                {pinned.map((entry) => (
                  <FileActivityRow
                    key={entry.path}
                    entry={entry}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {!loading && !error && recent.length > 0 ? (
            <div>
              <div className="mb-2 flex items-center gap-2 px-1">
                <Clock3 className="size-3.5 text-primary" />
                <h2 className="type-technical-label text-muted-foreground">
                  Recent
                </h2>
              </div>
              <div className="border border-border/75 bg-muted/5">
                {recent.map((entry) => (
                  <FileActivityRow
                    key={entry.path}
                    entry={entry}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            </div>
          ) : null}

          <RootDirectoryList
            actions={actions}
            enabled={!fileTreeLoading}
            fileIndex={fileIndex}
            onOpen={onOpen}
          />
        </div>
      </div>
    </section>
  )
}
