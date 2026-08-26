import * as React from "react"
import type { RelayFileEntry } from "@workspace/contracts"
import {
  ArrowDownUp,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  FilePlus,
  Folder,
  FolderPlus,
  LoaderCircle,
  Upload,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import { FileActionsDropdown } from "@/components/files/file-actions"
import { FileTypeIcon } from "@/components/files/file-type-icon"
import { selectedUploadFiles } from "@/components/files/file-upload-selection"
import {
  type FileActionsController,
  directoryPath,
  folderInputAttributes,
  normalizeDirectoryPath,
} from "@/components/files/file-tree-utils"
import {
  FileDropOverlay,
  type UploadFiles,
  useFileDropTarget,
} from "@/components/files/file-upload"
import {
  type FileDirectorySnapshot,
  ProgressiveFileIndex,
} from "@/components/files/progressive-file-index"
import { shortRelativeFileTime } from "@/components/files/file-time"
import {
  fileEditorHeaderClassName,
  fileEditorHeaderContentClassName,
  FileToolbarIdentity,
  FileTreeRevealButton,
} from "@/components/files/file-viewer-toolbar"

function formatName(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path
}

interface DirectoryEntry {
  kind: "directory" | "file"
  modifiedAt: number
  name: string
  path: string
  size: number | null
}

type DirectorySortKey = "modifiedAt" | "name" | "size"
type DirectorySortDirection = "ascending" | "descending"
const directoryEntryBatchSize = 128

const fileModifiedAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

function formatFileSize(bytes: number | null): string {
  if (bytes === null) return "—"
  if (bytes < 1_024) return `${bytes} B`
  const units = ["KiB", "MiB", "GiB", "TiB"] as const
  let value = bytes / 1_024
  let unit: (typeof units)[number] = units[0]
  for (const candidate of units.slice(1)) {
    if (value < 1_024) break
    value /= 1_024
    unit = candidate
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`
}

function formatFileModifiedAt(modifiedAt: number): string {
  if (modifiedAt <= 0) return "—"
  return (
    shortRelativeFileTime(modifiedAt) ??
    fileModifiedAtFormatter.format(modifiedAt)
  )
}

function FileModifiedAtTime({ modifiedAt }: { modifiedAt: number }) {
  if (modifiedAt <= 0) {
    return (
      <span className="type-code truncate pr-2 text-muted-foreground">—</span>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          className="type-code cursor-help truncate pr-2 text-muted-foreground"
          dateTime={new Date(modifiedAt).toISOString()}
          suppressHydrationWarning
        >
          {formatFileModifiedAt(modifiedAt)}
        </time>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        <span suppressHydrationWarning>
          {fileModifiedAtFormatter.format(modifiedAt)}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

const DirectorySizeCell = React.memo(function DirectorySizeCell({
  fileIndex,
  path,
}: {
  fileIndex: ProgressiveFileIndex
  path: string
}) {
  const subscribe = React.useCallback(
    (listener: () => void) => fileIndex.subscribeDirectorySize(path, listener),
    [fileIndex, path]
  )
  const getSnapshot = React.useCallback(
    () => fileIndex.getDirectorySize(path),
    [fileIndex, path]
  )
  const size = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return (
    <span className="type-code text-muted-foreground">
      {formatFileSize(size)}
    </span>
  )
})

function FileSizeCell({
  entry,
  fileIndex,
}: {
  entry: DirectoryEntry
  fileIndex: ProgressiveFileIndex
}) {
  if (entry.kind === "directory") {
    return <DirectorySizeCell fileIndex={fileIndex} path={entry.path} />
  }
  return (
    <span className="type-code text-muted-foreground">
      {formatFileSize(entry.size)}
    </span>
  )
}

function useFileDirectory(
  fileIndex: ProgressiveFileIndex,
  directory: string,
  enabled = true
): FileDirectorySnapshot {
  const normalized = normalizeDirectoryPath(directory)
  const subscribe = React.useCallback(
    (listener: () => void) =>
      fileIndex.subscribeDirectory(normalized, listener),
    [fileIndex, normalized]
  )
  const getSnapshot = React.useCallback(
    () => fileIndex.getDirectorySnapshot(normalized),
    [fileIndex, normalized]
  )
  const snapshot = React.useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot
  )
  React.useEffect(() => {
    if (enabled) void fileIndex.ensureDirectory(normalized)
  }, [enabled, fileIndex, normalized])
  return snapshot
}

function directoryEntries(
  entries: ReadonlyArray<RelayFileEntry>
): Array<DirectoryEntry> {
  return entries.map((entry) => ({
    ...entry,
    name: formatName(entry.path.replace(/\/$/u, "")),
  }))
}

function directoryEntrySortNumber(
  entry: DirectoryEntry,
  sortKey: Exclude<DirectorySortKey, "name">,
  fileIndex: ProgressiveFileIndex
) {
  const value =
    sortKey === "size" && entry.kind === "directory"
      ? fileIndex.getDirectorySize(entry.path)
      : entry[sortKey]
  return value ?? -1
}

function useSortedDirectoryEntries(
  entries: Array<DirectoryEntry>,
  fileIndex: ProgressiveFileIndex
) {
  const [sortKey, setSortKey] = React.useState<DirectorySortKey>("name")
  const [sortDirection, setSortDirection] =
    React.useState<DirectorySortDirection>("ascending")
  const sortedEntries = React.useMemo(() => {
    const direction = sortDirection === "ascending" ? 1 : -1
    return [...entries].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1
      const comparison =
        sortKey === "name"
          ? left.name.localeCompare(right.name, undefined, {
              numeric: true,
              sensitivity: "base",
            })
          : directoryEntrySortNumber(left, sortKey, fileIndex) -
            directoryEntrySortNumber(right, sortKey, fileIndex)
      return comparison === 0
        ? left.name.localeCompare(right.name, undefined, { numeric: true })
        : comparison * direction
    })
  }, [entries, fileIndex, sortDirection, sortKey])

  const toggleSort = React.useCallback(
    (nextKey: DirectorySortKey) => {
      if (nextKey === sortKey) {
        setSortDirection((current) =>
          current === "ascending" ? "descending" : "ascending"
        )
        return
      }
      setSortKey(nextKey)
      setSortDirection(nextKey === "name" ? "ascending" : "descending")
    },
    [sortKey]
  )

  return { sortDirection, sortedEntries, sortKey, toggleSort }
}

function useBatchedDirectoryEntries(
  entries: Array<DirectoryEntry>,
  complete: boolean,
  loadMore: () => Promise<void>
) {
  const [visibleCount, setVisibleCount] = React.useState(
    directoryEntryBatchSize
  )
  const visibleEntries = React.useMemo(
    () => entries.slice(0, visibleCount),
    [entries, visibleCount]
  )
  const hasBufferedEntries = visibleCount < entries.length
  const hasMoreEntries = hasBufferedEntries || !complete
  const revealMore = React.useCallback(() => {
    const needsFetch = visibleCount >= entries.length
    setVisibleCount((current) => current + directoryEntryBatchSize)
    if (needsFetch) void loadMore()
  }, [entries.length, loadMore, visibleCount])
  return { hasBufferedEntries, hasMoreEntries, revealMore, visibleEntries }
}

function DirectorySortButton({
  direction,
  label,
  onClick,
  selected,
}: {
  direction: DirectorySortDirection
  label: string
  onClick: () => void
  selected: boolean
}) {
  return (
    <button
      type="button"
      className="flex h-full min-w-0 items-center gap-1 text-left hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-inset"
      aria-label={`Sort by ${label}${selected ? `, currently ${direction}` : ""}`}
      onClick={onClick}
    >
      <span className="truncate">{label}</span>
      {selected ? (
        direction === "ascending" ? (
          <ChevronUp className="size-3" />
        ) : (
          <ChevronDown className="size-3" />
        )
      ) : (
        <ArrowDownUp className="size-3 opacity-45" />
      )}
    </button>
  )
}

export function RootDirectoryList({
  actions,
  enabled,
  fileIndex,
  loadError,
  onOpen,
  onRetry,
  retrying,
}: {
  actions: FileActionsController
  enabled: boolean
  fileIndex: ProgressiveFileIndex
  loadError: string | null
  onOpen: (path: string) => void
  onRetry: () => void
  retrying: boolean
}) {
  const directory = useFileDirectory(fileIndex, "", enabled)
  const entries = React.useMemo(
    () => directoryEntries(directory.entries),
    [directory.entries]
  )
  const { sortDirection, sortedEntries, sortKey, toggleSort } =
    useSortedDirectoryEntries(entries, fileIndex)
  const loadMore = React.useCallback(
    () => fileIndex.loadMoreDirectory(""),
    [fileIndex]
  )
  const { hasBufferedEntries, hasMoreEntries, revealMore, visibleEntries } =
    useBatchedDirectoryEntries(sortedEntries, directory.complete, loadMore)
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(
    () => new Set()
  )
  const selectedPaths = React.useMemo(
    () =>
      entries.flatMap((entry) =>
        selected.has(entry.path) ? [entry.path] : []
      ),
    [entries, selected]
  )
  const allSelected =
    visibleEntries.length > 0 &&
    visibleEntries.every((entry) => selected.has(entry.path))

  function toggle(path: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div className="mt-5">
      <div className="mb-2 flex min-h-8 items-center gap-2 px-1">
        <Folder className="size-3.5 text-primary" />
        <h2 className="type-technical-label text-muted-foreground">
          Root · /data
        </h2>
        {selectedPaths.length ? (
          <span className="type-code ml-auto text-muted-foreground">
            {selectedPaths.length} selected
          </span>
        ) : (
          <span className="ml-auto" />
        )}
        <FileActionsDropdown controller={actions} paths={selectedPaths} />
      </div>
      <div className="overflow-hidden border border-border/75 bg-muted/[0.025]">
        <div className="type-technical-label grid h-9 grid-cols-[2.25rem_minmax(12rem,1fr)_7rem_11rem_2.5rem] items-center border-b border-border/75 bg-muted/10 px-2 text-muted-foreground">
          <label className="grid size-7 place-items-center">
            <input
              type="checkbox"
              className="size-3.5 accent-primary"
              aria-label="Select all root files"
              checked={allSelected}
              onChange={() =>
                setSelected(
                  allSelected
                    ? new Set()
                    : new Set(visibleEntries.map((entry) => entry.path))
                )
              }
            />
          </label>
          <DirectorySortButton
            label="Name"
            selected={sortKey === "name"}
            direction={sortDirection}
            onClick={() => toggleSort("name")}
          />
          <DirectorySortButton
            label="Size"
            selected={sortKey === "size"}
            direction={sortDirection}
            onClick={() => toggleSort("size")}
          />
          <DirectorySortButton
            label="Last modified"
            selected={sortKey === "modifiedAt"}
            direction={sortDirection}
            onClick={() => toggleSort("modifiedAt")}
          />
          <span />
        </div>
        {visibleEntries.map((entry) => (
          <div
            key={entry.path}
            className="grid min-h-11 grid-cols-[2.25rem_minmax(12rem,1fr)_7rem_11rem_2.5rem] items-center border-b border-border/55 px-2 last:border-b-0 hover:bg-accent/30 has-checked:bg-primary/[0.07]"
          >
            <label className="grid size-7 place-items-center">
              <input
                type="checkbox"
                className="size-3.5 accent-primary"
                aria-label={`Select ${entry.name}`}
                checked={selected.has(entry.path)}
                onChange={() => toggle(entry.path)}
              />
            </label>
            <button
              type="button"
              className="flex min-w-0 items-center gap-2.5 self-stretch text-left text-sm font-medium focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-inset"
              onClick={() => onOpen(entry.path)}
            >
              {entry.kind === "directory" ? (
                <Folder className="size-4 shrink-0 text-primary/80" />
              ) : (
                <FileTypeIcon path={entry.path} />
              )}
              <span className="truncate">{entry.name}</span>
            </button>
            <FileSizeCell entry={entry} fileIndex={fileIndex} />
            <FileModifiedAtTime modifiedAt={entry.modifiedAt} />
            <FileActionsDropdown controller={actions} paths={[entry.path]} />
          </div>
        ))}
        {loadError ? (
          <div
            className="flex min-h-10 items-center justify-center gap-1.5 border-t border-destructive/30 bg-destructive/5 px-6 text-xs text-destructive"
            role="alert"
          >
            {retrying ? (
              <>
                <LoaderCircle className="size-3.5 animate-spin" />
                Retrying…
              </>
            ) : (
              <>
                <span>Loading failed.</span>
                <button
                  type="button"
                  className="font-medium underline underline-offset-2 hover:text-destructive/80 focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:outline-none"
                  onClick={onRetry}
                >
                  Retry
                </button>
              </>
            )}
          </div>
        ) : directory.loading && !hasBufferedEntries ? (
          <div className="flex min-h-10 items-center justify-center gap-2 border-t border-border/55 px-6 text-xs text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin text-primary" />
            Loading more files
          </div>
        ) : hasMoreEntries ? (
          <button
            type="button"
            className="flex min-h-10 w-full items-center justify-center gap-2 border-t border-border/55 px-6 text-xs font-medium text-primary transition-colors hover:bg-accent/30 focus-visible:bg-accent/40 focus-visible:outline-none"
            onClick={revealMore}
          >
            {directory.loading ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : null}
            Load more files
          </button>
        ) : null}
        {!loadError && directory.error ? (
          <div className="border-t border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
            {directory.error.message || "Could not load this directory"}
          </div>
        ) : null}
        {!entries.length && directory.complete ? (
          <div className="grid min-h-32 place-items-center px-6 text-center text-xs text-muted-foreground">
            The server root is empty. Drop files anywhere on this page to
            upload.
          </div>
        ) : null}
      </div>
    </div>
  )
}

function DirectoryViewContent({
  actions,
  canWrite,
  fileIndex,
  onOpen,
  onTreeExpand,
  onUploadFiles,
  path,
  treeCollapsed,
  uploading,
}: {
  actions: FileActionsController
  canWrite: boolean
  fileIndex: ProgressiveFileIndex
  onOpen: (path: string) => void
  onTreeExpand: () => void
  onUploadFiles: UploadFiles
  path: string
  treeCollapsed: boolean
  uploading: boolean
}) {
  const directory = useFileDirectory(fileIndex, path)
  const entries = React.useMemo(
    () => directoryEntries(directory.entries),
    [directory.entries]
  )
  const { sortDirection, sortedEntries, sortKey, toggleSort } =
    useSortedDirectoryEntries(entries, fileIndex)
  const loadMore = React.useCallback(
    () => fileIndex.loadMoreDirectory(path),
    [fileIndex, path]
  )
  const { hasBufferedEntries, hasMoreEntries, revealMore, visibleEntries } =
    useBatchedDirectoryEntries(sortedEntries, directory.complete, loadMore)
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(
    () => new Set()
  )
  const sectionRef = React.useRef<HTMLElement>(null)
  const uploadInputRef = React.useRef<HTMLInputElement>(null)
  const folderUploadInputRef = React.useRef<HTMLInputElement>(null)
  const dropTarget = useFileDropTarget({
    directory: path,
    enabled: canWrite,
    onUploadFiles,
    ref: sectionRef,
  })
  const selectedPaths = React.useMemo(
    () =>
      entries.flatMap((entry) =>
        selected.has(entry.path) ? [entry.path] : []
      ),
    [entries, selected]
  )
  const allSelected =
    visibleEntries.length > 0 &&
    visibleEntries.every((entry) => selected.has(entry.path))

  function toggle(pathToToggle: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(pathToToggle)) next.delete(pathToToggle)
      else next.add(pathToToggle)
      return next
    })
  }

  function handleUploadInput(event: React.ChangeEvent<HTMLInputElement>) {
    const files = selectedUploadFiles(event.target.files ?? [])
    event.target.value = ""
    if (files.length) void onUploadFiles(files, path)
  }

  const parent = directoryPath(path.replace(/\/+$/u, ""))

  return (
    <section
      ref={sectionRef}
      className="group/drop relative flex min-h-[360px] min-w-0 flex-1 flex-col bg-card"
      {...dropTarget}
    >
      <FileDropOverlay directory={path} />
      <div className={fileEditorHeaderClassName}>
        {treeCollapsed ? <FileTreeRevealButton onClick={onTreeExpand} /> : null}
        <div className={fileEditorHeaderContentClassName}>
          <FileToolbarIdentity path={path} directory />
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {selectedPaths.length ? (
              <span className="type-code mr-1 hidden text-muted-foreground sm:inline">
                {selectedPaths.length} selected
              </span>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!canWrite || uploading}
                >
                  {uploading ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Upload />
                  )}
                  <span className="hidden sm:inline">Upload</span>
                  <ChevronDown className="hidden size-3 sm:block" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem
                  onSelect={() => uploadInputRef.current?.click()}
                >
                  <FilePlus /> Upload files
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => folderUploadInputRef.current?.click()}
                >
                  <FolderPlus /> Upload folder
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <input
              ref={uploadInputRef}
              type="file"
              multiple
              className="hidden"
              aria-label={`Upload files to /data/${path}`}
              onChange={handleUploadInput}
            />
            <input
              {...folderInputAttributes}
              ref={folderUploadInputRef}
              type="file"
              multiple
              className="hidden"
              aria-label={`Upload folder to /data/${path}`}
              onChange={handleUploadInput}
            />
            <FileActionsDropdown controller={actions} paths={selectedPaths} />
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-4 sm:px-5 lg:px-7">
        <div className="mx-auto w-full max-w-5xl overflow-hidden border border-border/75 bg-muted/[0.025]">
          <div className="type-technical-label grid h-9 grid-cols-[2.25rem_minmax(12rem,1fr)_7rem_11rem_2.5rem] items-center border-b border-border/75 bg-muted/10 px-2 text-muted-foreground">
            <label className="grid size-7 place-items-center">
              <input
                type="checkbox"
                className="size-3.5 accent-primary"
                aria-label="Select all files"
                checked={allSelected}
                onChange={() =>
                  setSelected(
                    allSelected
                      ? new Set()
                      : new Set(visibleEntries.map((entry) => entry.path))
                  )
                }
              />
            </label>
            <DirectorySortButton
              label="Name"
              selected={sortKey === "name"}
              direction={sortDirection}
              onClick={() => toggleSort("name")}
            />
            <DirectorySortButton
              label="Size"
              selected={sortKey === "size"}
              direction={sortDirection}
              onClick={() => toggleSort("size")}
            />
            <DirectorySortButton
              label="Last modified"
              selected={sortKey === "modifiedAt"}
              direction={sortDirection}
              onClick={() => toggleSort("modifiedAt")}
            />
            <span />
          </div>

          <button
            type="button"
            aria-label={`Go up to /data/${parent}`}
            className="group/row grid min-h-11 w-full grid-cols-[2.25rem_minmax(12rem,1fr)_7rem_11rem_2.5rem] items-center border-b border-border/55 px-2 text-left transition-colors hover:bg-accent/30 focus-visible:bg-accent/40 focus-visible:outline-none"
            onClick={() => onOpen(parent)}
          >
            <span className="grid size-7 place-items-center text-muted-foreground">
              <ArrowUp className="size-4" />
            </span>
            <span className="flex min-w-0 items-center gap-2.5 text-sm font-medium">
              <Folder className="size-4 shrink-0 text-primary/80" />
              <span className="truncate">...</span>
            </span>
            <span className="type-code text-muted-foreground">—</span>
            <span className="type-code text-muted-foreground">—</span>
            <span />
          </button>

          {visibleEntries.map((entry) => (
            <div
              key={entry.path}
              className="group/row grid min-h-11 grid-cols-[2.25rem_minmax(12rem,1fr)_7rem_11rem_2.5rem] items-center border-b border-border/55 px-2 last:border-b-0 hover:bg-accent/30 has-checked:bg-primary/[0.07]"
            >
              <label className="grid size-7 place-items-center">
                <input
                  type="checkbox"
                  className="size-3.5 accent-primary"
                  aria-label={`Select ${entry.name}`}
                  checked={selected.has(entry.path)}
                  onChange={() => toggle(entry.path)}
                />
              </label>
              <button
                type="button"
                className="flex min-w-0 items-center gap-2.5 self-stretch text-left text-sm font-medium focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-inset"
                onClick={() => onOpen(entry.path)}
              >
                {entry.kind === "directory" ? (
                  <Folder className="size-4 shrink-0 text-primary/80" />
                ) : (
                  <FileTypeIcon path={entry.path} />
                )}
                <span className="truncate">{entry.name}</span>
              </button>
              <FileSizeCell entry={entry} fileIndex={fileIndex} />
              <FileModifiedAtTime modifiedAt={entry.modifiedAt} />
              <FileActionsDropdown controller={actions} paths={[entry.path]} />
            </div>
          ))}

          {directory.loading && !hasBufferedEntries ? (
            <div className="flex min-h-11 items-center justify-center gap-2 border-t border-border/55 px-6 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin text-primary" />
              Loading more files
            </div>
          ) : hasMoreEntries ? (
            <button
              type="button"
              className="flex min-h-11 w-full items-center justify-center gap-2 border-t border-border/55 px-6 text-xs font-medium text-primary transition-colors hover:bg-accent/30 focus-visible:bg-accent/40 focus-visible:outline-none"
              onClick={revealMore}
            >
              {directory.loading ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              Load more files
            </button>
          ) : null}

          {directory.error ? (
            <div className="border-t border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
              {directory.error.message || "Could not load this directory"}
            </div>
          ) : null}

          {!entries.length && directory.complete ? (
            <div className="grid min-h-40 place-items-center px-6 text-center">
              <div>
                <Folder className="mx-auto size-6 text-muted-foreground/60" />
                <p className="mt-3 text-sm font-medium">
                  This directory is empty
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Drop files here or use Upload to add them.
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}

export const DirectoryView = React.memo(DirectoryViewContent)
