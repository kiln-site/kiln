import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { HardDriveDownload } from "lucide-react"

import { FileWorkspaceLoadingState } from "@/components/file-tree-loading-panel"
import { DirectoryView } from "@/components/files/file-directory-view"
import { FileEditor } from "@/components/files/file-editor"
import { FilesHome } from "@/components/files/files-home"
import {
  type FileActionsController,
  normalizeDirectoryPath,
} from "@/components/files/file-tree-utils"
import type {
  FileEditorPreferencesStore,
  FileSelectionStore,
} from "@/components/files/file-workspace-stores"
import type { UploadFiles } from "@/components/files/file-upload"
import type { ProgressiveFileIndex } from "@/components/files/progressive-file-index"
import {
  fileEditorHeaderClassName,
  fileEditorHeaderContentClassName,
  FileToolbarIdentity,
  FileTreeRevealButton,
} from "@/components/files/file-viewer-toolbar"
import {
  queryKeys,
  relayFileEntryQueryOptions,
  relayFileQueryOptions,
} from "@/lib/query-options"
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"
import { warmSyntaxCodeEditorModule } from "@/lib/syntax-editor-module-preload"

const activeFileRevisionPollDelayMs = 30_000

const UnavailablePreviewToolbar = React.memo(
  function UnavailablePreviewToolbar({
    path,
    pathIsCopyable,
    canShare,
    treeCollapsed,
    onTreeExpand,
  }: {
    path: string
    pathIsCopyable: boolean
    canShare: boolean
    treeCollapsed: boolean
    onTreeExpand: () => void
  }) {
    return (
      <div className={fileEditorHeaderClassName} data-file-toolbar>
        {treeCollapsed ? <FileTreeRevealButton onClick={onTreeExpand} /> : null}
        <div className={fileEditorHeaderContentClassName}>
          <FileToolbarIdentity path={path} pathIsCopyable={pathIsCopyable} />

          <div
            className="ml-auto hidden max-w-full min-w-0 flex-wrap items-center justify-end gap-1 md:flex"
            aria-hidden="true"
          >
            {canShare ? (
              <span className="h-8 w-[5.5rem] animate-pulse bg-muted/35" />
            ) : null}
            {Array.from({ length: 5 }, (_, index) => (
              <span key={index} className="size-8 animate-pulse bg-muted/35" />
            ))}
          </div>

          <div
            className="ml-auto flex shrink-0 items-center gap-1 md:hidden"
            aria-hidden="true"
          >
            <span className="size-8 animate-pulse bg-muted/35" />
            <span className="size-8 animate-pulse bg-muted/35" />
          </div>
        </div>
      </div>
    )
  }
)

function UnavailablePreview({
  path,
  pathIsCopyable,
  loading,
  message,
  canShare,
  treeCollapsed,
  onTreeExpand,
}: {
  path: string
  pathIsCopyable: boolean
  loading: boolean
  message: string | null
  canShare: boolean
  treeCollapsed: boolean
  onTreeExpand: () => void
}) {
  return (
    <section
      className="flex min-h-[360px] min-w-0 flex-1 flex-col bg-card"
      aria-busy={loading}
    >
      <UnavailablePreviewToolbar
        path={path}
        pathIsCopyable={pathIsCopyable}
        canShare={canShare}
        treeCollapsed={treeCollapsed}
        onTreeExpand={onTreeExpand}
      />
      {loading ? (
        <div className="flex min-h-0 flex-1">
          <div
            className="w-[var(--file-editor-gutter-width,3rem)] shrink-0 border-r border-border/80 bg-muted/10"
            data-file-editor-loading-rail
            aria-hidden="true"
          />
          <div className="grid min-w-0 flex-1 place-items-center px-6 text-center">
            <FileWorkspaceLoadingState
              title="Reading from Relay"
              description="Checking the file and preparing a safe text preview."
            />
          </div>
        </div>
      ) : (
        <div className="grid flex-1 place-items-center px-6 text-center">
          <div className="max-w-xs">
            <div className="mx-auto mb-4 grid size-11 place-items-center rounded-xl border bg-muted/20 text-muted-foreground">
              <HardDriveDownload className="size-5" />
            </div>
            <p className="text-sm font-semibold">Preview unavailable</p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {message || "This file cannot be displayed as text."}
            </p>
          </div>
        </div>
      )}
    </section>
  )
}

interface FileViewerProps {
  actions: FileActionsController
  canShare: boolean
  canWrite: boolean
  fileTreeError: string | null
  fileTreeLoading: boolean
  fileTreeRetrying: boolean
  fileIndex: ProgressiveFileIndex
  instance: InstanceWorkspaceInstance
  onPathChange: (path: string) => void
  onRetryFileTree: () => void
  onTreeExpand: () => void
  preferencesStore: FileEditorPreferencesStore
  selectionStore: FileSelectionStore
  treeCollapsed: boolean
  relayConnected: boolean
  onUploadFiles: UploadFiles
  uploading: boolean
}

export function FileViewer({
  actions,
  canShare,
  canWrite,
  fileTreeError,
  fileTreeLoading,
  fileTreeRetrying,
  fileIndex,
  instance,
  onPathChange,
  onRetryFileTree,
  onTreeExpand,
  preferencesStore,
  selectionStore,
  treeCollapsed,
  relayConnected,
  onUploadFiles,
  uploading,
}: FileViewerProps) {
  const queryClient = useQueryClient()
  const selectedPath = React.useSyncExternalStore(
    selectionStore.subscribe,
    selectionStore.getSnapshot,
    selectionStore.getSnapshot
  )
  const isHome = !selectedPath
  const selectedDirectoryPath = normalizeDirectoryPath(selectedPath)
  const entryQuery = useQuery({
    ...relayFileEntryQueryOptions(instance.relayId, instance.id, selectedPath),
    enabled: Boolean(selectedPath) && relayConnected,
  })
  const selectedEntry = entryQuery.data ?? null
  React.useEffect(() => {
    if (selectedEntry) fileIndex.addEntry(selectedEntry)
  }, [fileIndex, selectedEntry])
  const selectedPathIsDirectory = Boolean(
    selectedPath &&
    (selectedPath.endsWith("/") || selectedEntry?.kind === "directory")
  )
  const selectedPathIsReadable = Boolean(
    selectedPath && selectedEntry?.kind === "file"
  )
  React.useEffect(() => {
    if (selectedPathIsDirectory && selectedPath !== selectedDirectoryPath) {
      onPathChange(selectedDirectoryPath)
    }
  }, [
    onPathChange,
    selectedDirectoryPath,
    selectedPath,
    selectedPathIsDirectory,
  ])
  React.useEffect(() => {
    if (selectedPath) warmSyntaxCodeEditorModule()
  }, [selectedPath])
  const fileQuery = useQuery({
    ...relayFileQueryOptions(instance.relayId, instance.id, selectedPath),
    enabled: selectedPathIsReadable && relayConnected,
    refetchInterval: activeFileRevisionPollDelayMs,
    refetchIntervalInBackground: false,
    refetchOnReconnect: "always",
    refetchOnWindowFocus: "always",
  })
  const file = fileQuery.data?.path === selectedPath ? fileQuery.data : null
  const loadingFile =
    fileTreeLoading ||
    (Boolean(selectedPath) && relayConnected && entryQuery.isPending) ||
    (selectedPathIsReadable && fileQuery.isPending)
  const routeError =
    selectedPath && entryQuery.isError
      ? queryErrorMessage(
          entryQuery.error,
          `Could not find /data/${selectedPath}`
        )
      : null
  const error =
    routeError ??
    fileTreeError ??
    (selectedPath && !relayConnected
      ? file
        ? "Relay disconnected. Showing a cached read-only copy."
        : "Unable to connect to Relay. This file is not cached."
      : null) ??
    queryErrorMessage(fileQuery.error, "Could not read file")
  const selectedFileUnavailable =
    Boolean(
      entryQuery.isError &&
      selectedPath &&
      !selectedPathIsReadable &&
      !selectedPathIsDirectory
    ) ||
    Boolean(selectedPath && !relayConnected && !selectedEntry && !file) ||
    (selectedPathIsReadable && !file && (!relayConnected || fileQuery.isError))
  const activitySyncKey = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (!fileQuery.data || fileQuery.data.path !== selectedPath) return
    const nextKey = `${fileQuery.data.path}:${fileQuery.data.modifiedAt}`
    if (activitySyncKey.current === nextKey) return
    activitySyncKey.current = nextKey
    void queryClient.invalidateQueries({
      queryKey: queryKeys.relay.fileActivity(instance.relayId, instance.id),
      // Avoid refetching the active pin-only observer. Files Home mounts its
      // own observer and refetches this stale query when it opens.
      refetchType: "none",
    })
  }, [fileQuery.data, instance.id, instance.relayId, queryClient, selectedPath])

  React.useEffect(() => {
    if (isHome) {
      selectionStore.completeNavigation(selectedPath, "loaded")
      return
    }
    if (loadingFile) return
    selectionStore.completeNavigation(
      selectedPath,
      selectedPathIsDirectory || (file && !selectedFileUnavailable)
        ? "loaded"
        : "unavailable"
    )
  }, [
    file,
    isHome,
    loadingFile,
    selectedFileUnavailable,
    selectedPath,
    selectedPathIsDirectory,
    selectionStore,
  ])

  if (isHome) {
    return (
      <FilesHome
        instance={instance}
        fileIndex={fileIndex}
        fileTreeLoading={fileTreeLoading}
        fileTreeError={fileTreeError}
        fileTreeRetrying={fileTreeRetrying}
        treeCollapsed={treeCollapsed}
        onTreeExpand={onTreeExpand}
        onOpen={onPathChange}
        onRetryFileTree={onRetryFileTree}
        canWrite={canWrite}
        onUploadFiles={onUploadFiles}
        actions={actions}
      />
    )
  }

  if (selectedPathIsDirectory) {
    return (
      <DirectoryView
        key={selectedDirectoryPath}
        actions={actions}
        canWrite={canWrite}
        fileIndex={fileIndex}
        onOpen={onPathChange}
        onTreeExpand={onTreeExpand}
        onUploadFiles={onUploadFiles}
        path={selectedDirectoryPath}
        treeCollapsed={treeCollapsed}
        uploading={uploading}
      />
    )
  }

  if (file && !selectedFileUnavailable && !loadingFile) {
    return (
      <FileEditor
        key={`${file.instanceId}:${file.path}`}
        canShare={canShare}
        canWrite={canWrite}
        file={file}
        displayPath={selectedPath}
        instance={instance}
        loading={fileQuery.isPending}
        error={error}
        preferencesStore={preferencesStore}
        treeCollapsed={treeCollapsed}
        onTreeExpand={onTreeExpand}
        onUploadFiles={onUploadFiles}
      />
    )
  }

  return (
    <UnavailablePreview
      path={selectedPath || instance.name}
      pathIsCopyable={Boolean(selectedPath)}
      loading={loadingFile}
      message={error}
      canShare={canShare}
      treeCollapsed={treeCollapsed}
      onTreeExpand={onTreeExpand}
    />
  )
}

export function queryErrorMessage(error: Error | null, fallback: string) {
  if (!error) return null
  return error.message || fallback
}
