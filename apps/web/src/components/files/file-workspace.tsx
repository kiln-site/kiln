import * as React from "react"
import { prepareFileTreeInput } from "@pierre/trees"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"

import { FileTreeLoadingPanel } from "@/components/file-tree-loading-panel"
import {
  FileActionDialogHost,
  useFileActions,
} from "@/components/files/file-actions"
import { FileDownloadDialog } from "@/components/files/file-download-dialog"
import { FileTreePanel } from "@/components/files/file-tree-panel"
import {
  createFileEditorPreferencesStore,
  createFileSelectionStore,
  type FileSelectionStore,
} from "@/components/files/file-workspace-stores"
import { useFileUploadAction } from "@/components/files/file-upload"
import { FileViewer, queryErrorMessage } from "@/components/files/file-viewer"
import { ProgressiveFileIndex } from "@/components/files/progressive-file-index"
import { relayRootDirectoryQueryOptions } from "@/lib/query-options"
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"
import {
  warmSyntaxCodeEditorModule,
  warmSyntaxCodeEditorModuleWhenIdle,
} from "@/lib/syntax-editor-module-preload"
const fileTreeCollapsedCookieName = "file_tree_collapsed"
const fileTreeCookieMaxAge = 60 * 60 * 24 * 7

const StableFileTreePanel = React.memo(FileTreePanel)

const InitializedFileTreePanel = React.memo(function InitializedFileTreePanel({
  initialPaths,
  ...props
}: Omit<React.ComponentProps<typeof FileTreePanel>, "preparedInput"> & {
  readonly initialPaths: readonly string[]
}) {
  const [preparedInput] = React.useState(() =>
    prepareFileTreeInput(initialPaths)
  )
  return <StableFileTreePanel {...props} preparedInput={preparedInput} />
})

interface FileWorkspaceProps {
  instance: InstanceWorkspaceInstance
  serverId: string
  active: boolean
  routeFilePath?: string
  canShare: boolean
  canWrite: boolean
  relayConnected: boolean
  openTreeOnEntry: boolean
  initialTreeCollapsed: boolean
  initialTreeWidth: number | null
}

export function FileWorkspace(props: FileWorkspaceProps) {
  const normalizedRoutePath = props.routeFilePath?.replace(/^\/+/, "") ?? ""
  const [selectionStore] = React.useState(() =>
    createFileSelectionStore(normalizedRoutePath)
  )
  const lastRoutedPath = React.useRef(normalizedRoutePath)
  const router = useRouter()

  React.useLayoutEffect(() => {
    if (lastRoutedPath.current === normalizedRoutePath) return
    lastRoutedPath.current = normalizedRoutePath
    selectionStore.select(normalizedRoutePath)
  }, [normalizedRoutePath, selectionStore])

  React.useEffect(
    () => () => selectionStore.cancelNavigation(),
    [selectionStore]
  )

  const handlePathChange = React.useCallback(
    (path: string) => {
      const currentPath = selectionStore.getSnapshot()
      if (currentPath === path) return
      if (path) warmSyntaxCodeEditorModule()

      const nextLocation = router.buildLocation({
        to: "/server/$serverId/files/$",
        params: { serverId: props.serverId, _splat: path },
      })
      const nextUrl = new URL(nextLocation.href, window.location.href).href
      selectionStore.navigate(path, window.location.href, nextUrl)
      if (!props.active) return

      void router
        .navigate({
          to: "/server/$serverId/files/$",
          params: { serverId: props.serverId, _splat: path },
          resetScroll: false,
        })
        .then(() => {
          if (!path.endsWith("/") || window.location.pathname.endsWith("/")) {
            return
          }
          const canonical = new URL(window.location.href)
          canonical.pathname = `${canonical.pathname}/`
          window.history.replaceState(window.history.state, "", canonical)
        })
    },
    [props.active, props.serverId, router, selectionStore]
  )

  return (
    <StableFileWorkspaceSurface
      instance={props.instance}
      selectionStore={selectionStore}
      canShare={props.canShare}
      canWrite={props.canWrite}
      relayConnected={props.relayConnected}
      onPathChange={handlePathChange}
      openTreeOnEntry={props.openTreeOnEntry}
      initialTreeCollapsed={props.initialTreeCollapsed}
      initialTreeWidth={props.initialTreeWidth}
    />
  )
}

interface FileWorkspaceSurfaceProps {
  instance: InstanceWorkspaceInstance
  selectionStore: FileSelectionStore
  canShare: boolean
  canWrite: boolean
  relayConnected: boolean
  onPathChange: (path: string) => void
  openTreeOnEntry: boolean
  initialTreeCollapsed: boolean
  initialTreeWidth: number | null
}

const StableFileWorkspaceSurface = React.memo(function FileWorkspaceSurface({
  instance,
  selectionStore,
  canShare,
  canWrite,
  relayConnected,
  onPathChange,
  openTreeOnEntry,
  initialTreeCollapsed,
  initialTreeWidth,
}: FileWorkspaceSurfaceProps) {
  const queryClient = useQueryClient()
  const [preferencesStore] = React.useState(createFileEditorPreferencesStore)
  const [mobileTreeOpen, setMobileTreeOpen] = React.useState(false)
  const [treeCollapsed, setTreeCollapsed] = React.useState(
    initialTreeCollapsed && !openTreeOnEntry
  )
  const [treeTransitionSuppressed, setTreeTransitionSuppressed] =
    React.useState(openTreeOnEntry)
  const handledTreeEntry = React.useRef(false)
  const openingTreeForRouteEntry = openTreeOnEntry && !handledTreeEntry.current
  const displayedTreeCollapsed = treeCollapsed && !openingTreeForRouteEntry
  const rootDirectoryQuery = useQuery(
    relayRootDirectoryQueryOptions(instance.relayId, instance.id)
  )
  const [fileIndex] = React.useState(
    () =>
      new ProgressiveFileIndex({
        initialRoot: rootDirectoryQuery.data ?? null,
        instanceId: instance.id,
        relayId: instance.relayId,
      })
  )
  const treeReady = rootDirectoryQuery.data !== undefined
  const initialTreePaths = React.useMemo(
    () => rootDirectoryQuery.data?.entries.map((entry) => entry.path) ?? [],
    [rootDirectoryQuery.data]
  )

  React.useLayoutEffect(() => {
    if (rootDirectoryQuery.data) {
      fileIndex.hydrateRoot(rootDirectoryQuery.data)
    }
  }, [fileIndex, rootDirectoryQuery.data])

  React.useEffect(() => {
    if (treeReady) fileIndex.start()
  }, [fileIndex, treeReady])

  React.useEffect(() => () => fileIndex.dispose(), [fileIndex])

  React.useEffect(() => preferencesStore.hydrate(), [preferencesStore])

  React.useEffect(() => {
    if (!treeReady || selectionStore.getSnapshot()) return
    return warmSyntaxCodeEditorModuleWhenIdle()
  }, [selectionStore, treeReady])

  const handleTreeCollapsedChange = React.useCallback(
    (nextCollapsed: boolean) => {
      setTreeCollapsed(nextCollapsed)
      document.cookie = `${fileTreeCollapsedCookieName}=${nextCollapsed}; path=/; max-age=${fileTreeCookieMaxAge}; SameSite=Lax`
    },
    []
  )
  const handleTreeExpand = React.useCallback(
    () => handleTreeCollapsedChange(false),
    [handleTreeCollapsedChange]
  )

  React.useLayoutEffect(() => {
    if (!openTreeOnEntry) {
      handledTreeEntry.current = false
      return
    }
    if (handledTreeEntry.current) return
    handledTreeEntry.current = true
    setTreeTransitionSuppressed(true)
    handleTreeCollapsedChange(false)
  }, [handleTreeCollapsedChange, openTreeOnEntry])

  React.useEffect(() => {
    if (!treeTransitionSuppressed) return
    let secondFrame: number | null = null
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        setTreeTransitionSuppressed(false)
      })
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame)
    }
  }, [treeTransitionSuppressed])

  const handleHome = React.useCallback(() => {
    onPathChange("")
  }, [onPathChange])

  const closeMobileTree = React.useCallback(() => {
    setMobileTreeOpen(false)
  }, [])

  const handleRefresh = React.useCallback(() => {
    fileIndex.refresh()
    void queryClient.invalidateQueries({
      exact: true,
      queryKey: relayRootDirectoryQueryOptions(instance.relayId, instance.id)
        .queryKey,
      refetchType: "none",
    })
  }, [fileIndex, instance.id, instance.relayId, queryClient])
  const uploads = useFileUploadAction({
    canWrite: canWrite && relayConnected,
    instance,
    onRefresh: handleRefresh,
  })
  const fileActions = useFileActions({
    canWrite: canWrite && relayConnected,
    instance,
    onRefresh: handleRefresh,
    onPathChange,
    selectionStore,
  })

  return (
    <div
      className="relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden md:flex-row"
      data-file-workspace
    >
      {treeReady && rootDirectoryQuery.data ? (
        <InitializedFileTreePanel
          key={instance.id}
          instance={instance}
          fileIndex={fileIndex}
          initialPaths={initialTreePaths}
          selectionStore={selectionStore}
          refreshDisabled={!relayConnected}
          mobileOpen={mobileTreeOpen}
          onPathChange={onPathChange}
          onRefresh={handleRefresh}
          onMobileOpenChange={setMobileTreeOpen}
          onFileSelected={closeMobileTree}
          onHome={handleHome}
          collapsed={displayedTreeCollapsed}
          animateCollapsedChange={
            !openingTreeForRouteEntry && !treeTransitionSuppressed
          }
          onCollapsedChange={handleTreeCollapsedChange}
          initialWidth={initialTreeWidth}
          canWrite={canWrite && relayConnected}
          onUploadFiles={uploads.uploadFiles}
          uploading={uploads.uploading}
          actions={fileActions.controller}
        />
      ) : (
        <FileTreeLoadingPanel
          collapsed={displayedTreeCollapsed}
          width={initialTreeWidth}
        />
      )}
      <div className="relative flex min-h-0 min-w-0 flex-1 pb-11 md:pb-0">
        <FileViewer
          canShare={canShare && relayConnected}
          canWrite={canWrite && relayConnected}
          fileTreeError={queryErrorMessage(
            rootDirectoryQuery.error,
            "Could not load files"
          )}
          fileTreeLoading={rootDirectoryQuery.isPending}
          fileIndex={fileIndex}
          instance={instance}
          onPathChange={onPathChange}
          onTreeExpand={handleTreeExpand}
          preferencesStore={preferencesStore}
          selectionStore={selectionStore}
          treeCollapsed={displayedTreeCollapsed}
          relayConnected={relayConnected}
          onUploadFiles={uploads.uploadFiles}
          uploading={uploads.uploading}
          actions={fileActions.controller}
        />
      </div>
      <FileActionDialogHost
        key={
          fileActions.dialog?.kind === "rename"
            ? `rename:${fileActions.dialog.path}`
            : fileActions.dialog
              ? `${fileActions.dialog.kind}:${fileActions.dialog.paths.join("|")}`
              : "closed"
        }
        dialog={fileActions.dialog}
        busy={fileActions.controller.busy}
        onOpenChange={(open) => {
          if (!open) fileActions.setDialog(null)
        }}
        onSubmit={fileActions.submitDialog}
      />
      {fileActions.downloadPath ? (
        <FileDownloadDialog
          instance={instance}
          open
          path={fileActions.downloadPath}
          onOpenChange={(open) => {
            if (!open) fileActions.setDownloadPath(null)
          }}
        />
      ) : null}
    </div>
  )
})
