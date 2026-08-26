import * as React from "react"
import { Result } from "effect"
import type { FileTreePreparedInput } from "@pierre/trees"
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react"
import {
  FilePlus,
  FolderPlus,
  FolderTree,
  GripVertical,
  House,
  LoaderCircle,
  Network,
  PanelLeftClose,
  Plus,
  RefreshCw,
  Search,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"
import { EditorTooltip } from "@/components/files/editor-tooltip"
import { FileActionsMenu } from "@/components/files/file-actions-menu"
import { selectedUploadFiles } from "@/components/files/file-upload-selection"
import {
  directoryPath,
  fileTreeParentDirectoryPaths,
  folderInputAttributes,
  hasDraggedFiles,
  normalizeDirectoryPath,
  uploadDroppedFiles,
} from "@/components/files/file-tree-utils"
import type {
  FileActionsController,
  UploadFiles,
} from "@/components/files/file-tree-utils"
import type { FileSelectionStore } from "@/components/files/file-workspace-stores"
import type { ProgressiveFileIndex } from "@/components/files/progressive-file-index"

const fileTreeWidthCookieName = "file_tree_width"
const fileTreeCookieMaxAge = 60 * 60 * 24 * 7
const fileTreeMinWidth = 224
const fileTreeMaxWidth = 480
const mobileFileDrawerTransitionMs = 200
const fileTreeLoadingLabel = "Loading files…"
const fileTreeLoadingSortPrefix = "\uFFFF"
const fileTreeLoadingFileName = `${fileTreeLoadingSortPrefix}${fileTreeLoadingLabel}`

function fileTreeLoadingPath(directory: string): string {
  return `${normalizeDirectoryPath(directory)}${fileTreeLoadingFileName}`
}

function persistFileTreeWidth(width: number) {
  document.cookie = `${fileTreeWidthCookieName}=${width}; path=/; max-age=${fileTreeCookieMaxAge}; SameSite=Lax`
}

const fileTreeLayoutCss = `
  [data-item-section="content"] {
    flex: 1 1 auto;
  }

  [data-item-section="decoration"]:empty {
    display: none;
  }

  [data-truncate-marker] {
    opacity: 0;
  }

  @container measure (height > calc(1lh + 1px)) {
    [data-truncate-marker] {
      opacity: 1;
    }
  }

  [data-icon-name="file-tree-icon-chevron"] {
    width: 14px;
    height: 14px;
  }

  [data-kiln-file-tree-loading="true"] [data-item-section="icon"] {
    display: grid;
    place-items: center;
    color: var(--primary);
  }

  [data-kiln-file-tree-loading="true"] [data-item-section="icon"] svg {
    display: none;
  }

  [data-kiln-file-tree-loading="true"] [data-item-section="icon"]::before {
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 999px;
    content: "";
    animation: kiln-file-tree-loading-spin 0.8s linear infinite;
  }

  [data-kiln-file-tree-loading="true"] {
    color: var(--muted-foreground);
    cursor: progress;
  }

  [data-kiln-file-tree-loading="true"] [data-item-section="action"] {
    display: none;
  }

  @keyframes kiln-file-tree-loading-spin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    [data-kiln-file-tree-loading="true"] [data-item-section="icon"]::before {
      animation: none;
    }
  }

  [data-item-path][data-external-file-drop-target="true"] {
    background: color-mix(in oklch, var(--primary) 22%, var(--card)) !important;
    color: var(--foreground) !important;
    outline: 1px solid color-mix(in oklch, var(--primary) 72%, transparent);
    outline-offset: -1px;
    box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--primary) 16%, transparent), 0 0 12px color-mix(in oklch, var(--primary) 10%, transparent);
  }

  [data-item-path][data-external-file-drop-target="true"] [data-item-section="icon"] {
    color: var(--primary) !important;
  }

  [data-external-file-drop-segment="true"] {
    border-radius: 2px;
    background: color-mix(in oklch, var(--primary) 24%, transparent);
    box-shadow: 0 0 0 1px color-mix(in oklch, var(--primary) 48%, transparent);
    color: var(--foreground);
    font-weight: 600;
  }

  :host([data-external-file-drop-root="true"]) [data-file-tree-virtualized-wrapper="true"] {
    box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--primary) 48%, transparent);
  }
`

function clampFileTreeWidth(width: number, workspaceWidth: number) {
  const responsiveMaximum = Math.floor(workspaceWidth * 0.45)
  const maximum = Math.max(
    fileTreeMinWidth,
    Math.min(fileTreeMaxWidth, responsiveMaximum)
  )
  return Math.min(maximum, Math.max(fileTreeMinWidth, Math.round(width)))
}

function defaultFileTreeWidth() {
  return window.innerWidth >= 1280 ? 304 : 280
}

function resolveTreeDropDirectory(event: React.DragEvent): string {
  for (const target of event.nativeEvent.composedPath()) {
    if (!(target instanceof HTMLElement)) continue
    const flattened = target.dataset.itemFlattenedSubitem
    if (flattened) return normalizeDirectoryPath(flattened)
    const path = target.dataset.itemPath
    if (!path) continue
    return target.dataset.itemType === "folder"
      ? normalizeDirectoryPath(path)
      : directoryPath(path)
  }
  return ""
}

function resolveTreeEventDirectory(event: Event): string | null {
  for (const target of event.composedPath()) {
    if (!(target instanceof HTMLElement)) continue
    const flattened = target.dataset.itemFlattenedSubitem
    if (flattened) return normalizeDirectoryPath(flattened)
    const path = target.dataset.itemPath
    if (path && target.dataset.itemType === "folder") {
      return normalizeDirectoryPath(path)
    }
  }
  return null
}

function FilesHomeButton({
  active = false,
  onClick,
}: {
  active?: boolean
  onClick: () => void
}) {
  return (
    <EditorTooltip content="Files Home">
      <Button
        variant="ghost"
        size="icon-sm"
        className={`shrink-0 shadow-none ${active ? "text-primary hover:bg-transparent hover:text-primary focus-visible:bg-transparent" : ""}`}
        aria-label="Files home"
        aria-current={active ? "page" : undefined}
        onClick={onClick}
      >
        <House className="size-[18px]" />
      </Button>
    </EditorTooltip>
  )
}

function FileTreeHomeButton({
  selectionStore,
  onClick,
}: {
  selectionStore: FileSelectionStore
  onClick: () => void
}) {
  const isHome = React.useSyncExternalStore(
    selectionStore.subscribe,
    selectionStore.getIsHomeSnapshot,
    selectionStore.getIsHomeSnapshot
  )
  return <FilesHomeButton active={isHome} onClick={onClick} />
}

function FileTreeSearchInput({
  model,
  onSearchQueryChange,
  onMobileOpenChange,
  onMobileClose,
  searchComplete,
  searching,
}: {
  model: ReturnType<typeof useFileTree>["model"]
  onSearchQueryChange: (query: string) => void
  onMobileOpenChange: (open: boolean) => void
  onMobileClose: () => void
  searchComplete: boolean
  searching: boolean
}) {
  const search = useFileTreeSearch(model)

  return (
    <label className="flex h-full min-w-0 flex-1 items-center">
      {searching ? (
        <LoaderCircle className="ml-1 size-[18px] shrink-0 animate-spin text-primary md:ml-1.5" />
      ) : (
        <Search className="ml-1 size-[18px] shrink-0 text-foreground/90 md:ml-1.5" />
      )}
      <input
        type="search"
        maxLength={256}
        value={search.value}
        placeholder="Search files…"
        aria-label="Search instance files"
        className="type-input h-full min-w-0 flex-1 bg-transparent px-2 text-foreground outline-none placeholder:text-muted-foreground"
        onChange={(event) => {
          const value = event.target.value
          if (value) search.setValue(value)
          else search.close()
          onSearchQueryChange(value)
        }}
        onFocus={() => {
          if (window.matchMedia("(max-width: 767px)").matches) {
            onMobileOpenChange(true)
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            if (search.value) search.close()
            else onMobileClose()
            return
          }
          if (event.key === "Enter") {
            event.preventDefault()
            if (event.shiftKey) search.focusPreviousMatch()
            else search.focusNextMatch()
          }
        }}
      />
      {search.value && !searching && !searchComplete ? (
        <span
          role="status"
          aria-label="Search could not finish; results may be incomplete"
          title="Search could not finish. Results may be incomplete."
          className="mr-1 shrink-0 text-destructive"
        >
          <TriangleAlert className="size-4" />
        </span>
      ) : null}
    </label>
  )
}

function FileTreeSelectionSync({
  model,
  selectionStore,
}: {
  model: ReturnType<typeof useFileTree>["model"]
  selectionStore: FileSelectionStore
}) {
  const selectedPath = React.useSyncExternalStore(
    selectionStore.subscribe,
    selectionStore.getSnapshot,
    selectionStore.getSnapshot
  )

  React.useLayoutEffect(() => {
    const currentSelection = model.getSelectedPaths()
    if (selectedPath) {
      for (const parentPath of fileTreeParentDirectoryPaths(selectedPath)) {
        const parent = model.getItem(parentPath)
        if (parent && "isExpanded" in parent && !parent.isExpanded()) {
          parent.expand()
        }
      }
      if (
        currentSelection.length !== 1 ||
        currentSelection[0] !== selectedPath
      ) {
        for (const path of currentSelection) model.getItem(path)?.deselect()
        model.getItem(selectedPath)?.select()
      }
      model.scrollToPath(selectedPath, { focus: false, offset: "nearest" })
      return
    }
    for (const path of currentSelection) model.getItem(path)?.deselect()
  }, [model, selectedPath])

  return null
}

function FileActionPreview({
  icon,
  label,
}: {
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      disabled
      className="type-label flex w-full items-center gap-2.5 px-2 py-2 text-left text-muted-foreground transition-colors hover:bg-popover-accent/75 hover:text-foreground focus-visible:bg-popover-accent focus-visible:text-foreground focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
    >
      <span className="grid size-7 shrink-0 place-items-center border border-border/70 bg-card [&>svg]:size-3.5">
        {icon}
      </span>
      <span className="min-w-0 flex-1 text-foreground">{label}</span>
      <span className="type-technical-label text-muted-foreground">Soon</span>
    </button>
  )
}

function FileUploadPickerAction({
  disabled,
  icon,
  label,
  onClick,
  uploading,
}: {
  disabled: boolean
  icon: React.ReactNode
  label: string
  onClick: () => void
  uploading: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="flex w-full items-center gap-2.5 px-2 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-popover-accent/75 hover:text-foreground focus-visible:bg-popover-accent focus-visible:text-foreground focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40"
      onClick={onClick}
    >
      <span className="grid size-7 shrink-0 place-items-center border border-border/70 bg-card [&>svg]:size-3.5">
        {uploading ? <LoaderCircle className="animate-spin" /> : icon}
      </span>
      <span className="min-w-0 flex-1 text-foreground">
        {uploading ? "Uploading…" : label}
      </span>
      <span className="type-technical-label text-primary">Direct</span>
    </button>
  )
}

export function FileTreePanel({
  instance,
  fileIndex,
  preparedInput,
  selectionStore,
  refreshDisabled,
  mobileOpen,
  onPathChange,
  onRefresh,
  onMobileOpenChange,
  onFileSelected,
  onHome,
  collapsed,
  animateCollapsedChange,
  onCollapsedChange,
  initialWidth,
  canWrite,
  onUploadFiles,
  uploading,
  actions,
}: {
  instance: InstanceWorkspaceInstance
  fileIndex: ProgressiveFileIndex
  preparedInput: FileTreePreparedInput
  selectionStore: FileSelectionStore
  refreshDisabled: boolean
  mobileOpen: boolean
  onPathChange: (path: string) => void
  onRefresh: () => void
  onMobileOpenChange: (open: boolean) => void
  onFileSelected: () => void
  onHome: () => void
  collapsed: boolean
  animateCollapsedChange: boolean
  onCollapsedChange: (collapsed: boolean) => void
  initialWidth: number | null
  canWrite: boolean
  onUploadFiles: UploadFiles
  uploading: boolean
  actions: FileActionsController
}) {
  const selectedPath = selectionStore.getSnapshot()
  const initialPath =
    selectedPath && fileIndex.getPaths().includes(selectedPath)
      ? selectedPath
      : undefined
  const initialExpandedPaths = initialPath
    ? fileTreeParentDirectoryPaths(initialPath)
    : []
  const selectionHandlers = React.useRef({
    onFileSelected,
    onPathChange,
  })
  const searchTimer = React.useRef<number | null>(null)
  const loadingPlaceholderPaths = React.useRef(new Set<string>())
  const { model } = useFileTree({
    preparedInput,
    initialExpansion: "closed",
    initialExpandedPaths,
    initialSelectedPaths: initialPath ? [initialPath] : [],
    onSelectionChange: (paths) => {
      const selected = paths.at(-1)
      const handlers = selectionHandlers.current
      if (
        !selected ||
        loadingPlaceholderPaths.current.has(selected) ||
        selected === selectionStore.getSnapshot()
      ) {
        return
      }
      handlers.onPathChange(selected)
      handlers.onFileSelected()
    },
    search: false,
    flattenEmptyDirectories: true,
    stickyFolders: true,
    itemHeight: 29,
    composition: { contextMenu: { enabled: true, triggerMode: "both" } },
    unsafeCSS: fileTreeLayoutCss,
  })
  const getIndexStatus = React.useCallback(
    () => fileIndex.getStatusSnapshot(),
    [fileIndex]
  )
  const indexStatus = React.useSyncExternalStore(
    React.useCallback(
      (listener) => fileIndex.subscribeStatus(listener),
      [fileIndex]
    ),
    getIndexStatus,
    getIndexStatus
  )
  const [mobileContentVisible, setMobileContentVisible] =
    React.useState(mobileOpen)
  const mobileBrowseButtonRef = React.useRef<HTMLButtonElement>(null)
  const panelRef = React.useRef<HTMLElement>(null)
  const resizeHandleRef = React.useRef<HTMLDivElement>(null)
  const resizeFrame = React.useRef<number | null>(null)
  const transitionOverflowTimer = React.useRef<number | null>(null)
  const pendingWidth = React.useRef<number | null>(null)
  const currentWidth = React.useRef(initialWidth ?? 304)
  const previousCollapsed = React.useRef(collapsed)
  const resizeSession = React.useRef<{
    pointerId: number
    startX: number
    startWidth: number
  } | null>(null)
  const previousDocumentStyles = React.useRef({
    userSelect: "",
  })
  const uploadInputRef = React.useRef<HTMLInputElement>(null)
  const folderUploadInputRef = React.useRef<HTMLInputElement>(null)
  const dragDepth = React.useRef(0)
  const activeDropElement = React.useRef<HTMLElement | null>(null)
  const activeDropSegment = React.useRef<HTMLElement | null>(null)
  const activeTreeHost = React.useRef<HTMLElement | null>(null)
  const dropDirectory = React.useRef("")
  const dropExpandDirectory = React.useRef("")
  const dropExpandTimer = React.useRef<number | null>(null)
  const dropPathLabelRef = React.useRef<HTMLSpanElement>(null)

  const handleFilesSelected = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = selectedUploadFiles(event.target.files ?? [])
      event.target.value = ""
      if (files.length && canWrite) void onUploadFiles(files, "")
    },
    [canWrite, onUploadFiles]
  )

  function clearTreeDropTarget() {
    activeDropElement.current?.removeAttribute("data-external-file-drop-target")
    activeDropSegment.current?.removeAttribute(
      "data-external-file-drop-segment"
    )
    activeTreeHost.current?.removeAttribute("data-external-file-drop-root")
    activeDropElement.current = null
    activeDropSegment.current = null
    activeTreeHost.current = null
    dropDirectory.current = ""
    dropExpandDirectory.current = ""
    if (dropExpandTimer.current !== null) {
      window.clearTimeout(dropExpandTimer.current)
      dropExpandTimer.current = null
    }
    if (panelRef.current) panelRef.current.dataset.fileDropActive = "false"
  }

  function scheduleTreeDropExpansion(directory: string) {
    if (dropExpandDirectory.current === directory) return
    if (dropExpandTimer.current !== null) {
      window.clearTimeout(dropExpandTimer.current)
      dropExpandTimer.current = null
    }
    dropExpandDirectory.current = directory
    const item = model.getItem(directory)
    if (!directory || !item || !("isExpanded" in item) || item.isExpanded())
      return
    dropExpandTimer.current = window.setTimeout(() => {
      dropExpandTimer.current = null
      const currentItem = model.getItem(directory)
      if (
        currentItem &&
        "isExpanded" in currentItem &&
        !currentItem.isExpanded()
      ) {
        currentItem.expand()
      }
    }, 650)
  }

  function showTreeDropTarget(event: React.DragEvent) {
    const directory = resolveTreeDropDirectory(event)
    dropDirectory.current = directory
    activeDropElement.current?.removeAttribute("data-external-file-drop-target")
    activeDropSegment.current?.removeAttribute(
      "data-external-file-drop-segment"
    )
    activeDropElement.current = null
    activeDropSegment.current = null
    const treeHost = panelRef.current?.querySelector<HTMLElement>(
      "file-tree-container"
    )
    activeTreeHost.current?.removeAttribute("data-external-file-drop-root")
    activeTreeHost.current = treeHost ?? null
    if (!directory)
      treeHost?.setAttribute("data-external-file-drop-root", "true")
    const rows =
      treeHost?.shadowRoot?.querySelectorAll<HTMLElement>("[data-item-path]")
    for (const row of rows ?? []) {
      if (normalizeDirectoryPath(row.dataset.itemPath ?? "") === directory) {
        activeDropElement.current = row
      } else {
        const segments = row.querySelectorAll<HTMLElement>(
          "[data-item-flattened-subitem]"
        )
        for (const segment of segments) {
          if (
            normalizeDirectoryPath(
              segment.dataset.itemFlattenedSubitem ?? ""
            ) !== directory
          ) {
            continue
          }
          activeDropElement.current = row
          activeDropSegment.current = segment
          break
        }
      }
      if (!activeDropElement.current) continue
      activeDropElement.current.setAttribute(
        "data-external-file-drop-target",
        "true"
      )
      activeDropSegment.current?.setAttribute(
        "data-external-file-drop-segment",
        "true"
      )
      break
    }
    scheduleTreeDropExpansion(directory)
    if (panelRef.current) panelRef.current.dataset.fileDropActive = "true"
    if (dropPathLabelRef.current) {
      dropPathLabelRef.current.textContent = `/data/${directory}`
    }
  }

  function handleTreeDragEnter(event: React.DragEvent) {
    if (!canWrite || !hasDraggedFiles(event)) return
    event.preventDefault()
    dragDepth.current += 1
    showTreeDropTarget(event)
  }

  function handleTreeDragOver(event: React.DragEvent) {
    if (!canWrite || !hasDraggedFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
    showTreeDropTarget(event)
  }

  function handleTreeDragLeave(event: React.DragEvent) {
    if (!canWrite || !hasDraggedFiles(event)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) clearTreeDropTarget()
  }

  function handleTreeDrop(event: React.DragEvent) {
    if (!canWrite || !hasDraggedFiles(event)) return
    event.preventDefault()
    const directory = dropDirectory.current
    dragDepth.current = 0
    clearTreeDropTarget()
    void uploadDroppedFiles(event.dataTransfer, directory, onUploadFiles)
  }

  function workspaceWidth() {
    return (
      panelRef.current?.parentElement?.getBoundingClientRect().width ??
      window.innerWidth
    )
  }

  function applyFileTreeWidth(width: number) {
    const nextWidth = clampFileTreeWidth(width, workspaceWidth())
    currentWidth.current = nextWidth
    panelRef.current?.style.setProperty("--file-tree-width", `${nextWidth}px`)
    const handle = resizeHandleRef.current
    if (handle) {
      handle.setAttribute("aria-valuenow", String(nextWidth))
      handle.setAttribute(
        "aria-valuemax",
        String(clampFileTreeWidth(fileTreeMaxWidth, workspaceWidth()))
      )
    }
    return nextWidth
  }

  function scheduleFileTreeWidth(width: number) {
    pendingWidth.current = width
    if (resizeFrame.current !== null) return
    resizeFrame.current = window.requestAnimationFrame(() => {
      resizeFrame.current = null
      const nextWidth = pendingWidth.current
      pendingWidth.current = null
      if (nextWidth !== null) applyFileTreeWidth(nextWidth)
    })
  }

  function restoreDocumentAfterResize() {
    document.documentElement.style.userSelect =
      previousDocumentStyles.current.userSelect
  }

  function finishPanelTransition() {
    if (transitionOverflowTimer.current !== null) {
      window.clearTimeout(transitionOverflowTimer.current)
      transitionOverflowTimer.current = null
    }
    panelRef.current?.style.removeProperty("overflow")
  }

  function finishResize(pointerId?: number) {
    if (
      pointerId !== undefined &&
      resizeSession.current?.pointerId !== pointerId
    ) {
      return
    }
    if (resizeFrame.current !== null) {
      window.cancelAnimationFrame(resizeFrame.current)
      resizeFrame.current = null
    }
    if (pendingWidth.current !== null) {
      applyFileTreeWidth(pendingWidth.current)
      pendingWidth.current = null
    }
    resizeSession.current = null
    panelRef.current?.removeAttribute("data-resizing")
    panelRef.current?.style.removeProperty("transition")
    resizeHandleRef.current?.removeAttribute("data-resizing")
    restoreDocumentAfterResize()
    persistFileTreeWidth(currentWidth.current)
  }

  React.useLayoutEffect(() => {
    applyFileTreeWidth(initialWidth ?? defaultFileTreeWidth())
  }, [initialWidth])

  React.useLayoutEffect(() => {
    selectionHandlers.current = {
      onFileSelected,
      onPathChange,
    }
  }, [onFileSelected, onPathChange])

  React.useLayoutEffect(() => {
    const applyTreeLoadingState = (directory: string, loading: boolean) => {
      const path = fileTreeLoadingPath(directory)
      if (loading) {
        if (model.getItem(path)) return
        loadingPlaceholderPaths.current.add(path)
        model.batch([{ path, type: "add" }])
        return
      }
      if (!loadingPlaceholderPaths.current.delete(path)) return
      if (model.getItem(path)) model.batch([{ path, type: "remove" }])
    }
    const unsubscribe = fileIndex.subscribePaths((event) => {
      if (event.type === "reset") {
        loadingPlaceholderPaths.current.clear()
        model.resetPaths([], {
          initialExpandedPaths: fileTreeParentDirectoryPaths(
            selectionStore.getSnapshot()
          ),
        })
        return
      }
      if (event.type === "directory-pagination") {
        applyTreeLoadingState(event.directory, event.hasMore)
        return
      }
      const additions = event.entries.flatMap((entry) => {
        const replacesPlaceholder = loadingPlaceholderPaths.current.delete(
          entry.path
        )
        return [
          ...(replacesPlaceholder
            ? [{ path: entry.path, type: "remove" as const }]
            : []),
          ...(!model.getItem(entry.path) || replacesPlaceholder
            ? [{ path: entry.path, type: "add" as const }]
            : []),
        ]
      })
      if (!additions.length) return
      model.batch(additions)
      const selectedPath = selectionStore.getSnapshot()
      const selected = selectedPath ? model.getItem(selectedPath) : null
      if (!selected || model.getSelectedPaths().includes(selectedPath)) return
      for (const parentPath of fileTreeParentDirectoryPaths(selectedPath)) {
        const parent = model.getItem(parentPath)
        if (parent && "isExpanded" in parent && !parent.isExpanded()) {
          parent.expand()
        }
      }
      selected.select()
      model.scrollToPath(selectedPath, { focus: false, offset: "nearest" })
    })
    fileIndex
      .getTreePendingDirectories()
      .forEach((directory) => applyTreeLoadingState(directory, true))
    return unsubscribe
  }, [fileIndex, model, selectionStore])

  React.useEffect(() => {
    const shadowRoot =
      model.getFileTreeContainer()?.shadowRoot ??
      panelRef.current?.querySelector<HTMLElement>("file-tree-container")
        ?.shadowRoot
    if (!shadowRoot) return
    let loadTimer: number | null = null
    const loadVisiblePages = () => {
      loadTimer = null
      const directories = new Set<string>()
      for (const row of shadowRoot.querySelectorAll<HTMLElement>(
        "[data-item-path]"
      )) {
        const path = row.dataset.itemPath
        if (path && loadingPlaceholderPaths.current.has(path)) {
          directories.add(directoryPath(path))
        }
      }
      directories.forEach(
        (directory) => void fileIndex.loadMoreDirectory(directory)
      )
    }
    const prepareVisibleRows = () => {
      let hasLoadingRow = false
      for (const row of shadowRoot.querySelectorAll<HTMLElement>(
        "[data-item-path]"
      )) {
        const path = row.dataset.itemPath
        if (!path || !loadingPlaceholderPaths.current.has(path)) {
          row.removeAttribute("data-kiln-file-tree-loading")
          continue
        }
        hasLoadingRow = true
        row.dataset.kilnFileTreeLoading = "true"
        row.setAttribute("aria-label", fileTreeLoadingLabel)
        const content = row.querySelector('[data-item-section="content"]')
        if (content) {
          const walker = document.createTreeWalker(
            content,
            NodeFilter.SHOW_TEXT
          )
          let text = walker.nextNode()
          while (text) {
            const current = text.textContent ?? ""
            const normalized = current.replaceAll(fileTreeLoadingSortPrefix, "")
            if (normalized !== current) text.textContent = normalized
            text = walker.nextNode()
          }
        }
      }
      if (hasLoadingRow && loadTimer === null) {
        loadTimer = window.setTimeout(loadVisiblePages, 0)
      }
    }
    const observer = new MutationObserver(prepareVisibleRows)
    observer.observe(shadowRoot, {
      characterData: true,
      childList: true,
      subtree: true,
    })
    prepareVisibleRows()
    return () => {
      observer.disconnect()
      if (loadTimer !== null) window.clearTimeout(loadTimer)
    }
  }, [fileIndex, model])

  const handleSearchQueryChange = React.useCallback(
    (query: string) => {
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current)
      searchTimer.current = null
      if (!query.trim()) {
        fileIndex.search("")
        return
      }
      searchTimer.current = window.setTimeout(() => {
        searchTimer.current = null
        fileIndex.search(query)
      }, 120)
    },
    [fileIndex]
  )

  React.useLayoutEffect(() => {
    if (mobileOpen) {
      setMobileContentVisible(true)
      return
    }
    const timer = window.setTimeout(
      () => setMobileContentVisible(false),
      mobileFileDrawerTransitionMs
    )
    return () => window.clearTimeout(timer)
  }, [mobileOpen])

  React.useLayoutEffect(() => {
    if (!collapsed) applyFileTreeWidth(currentWidth.current)
  }, [collapsed])

  React.useLayoutEffect(() => {
    const panel = panelRef.current
    const changed = previousCollapsed.current !== collapsed
    previousCollapsed.current = collapsed
    if (!panel || !changed || !window.matchMedia("(min-width: 768px)").matches)
      return
    if (!animateCollapsedChange) {
      finishPanelTransition()
      return
    }

    panel.style.overflow = "hidden"
    if (transitionOverflowTimer.current !== null) {
      window.clearTimeout(transitionOverflowTimer.current)
    }
    transitionOverflowTimer.current = window.setTimeout(
      finishPanelTransition,
      240
    )
  }, [animateCollapsedChange, collapsed])

  React.useEffect(
    () => () => {
      if (resizeFrame.current !== null) {
        window.cancelAnimationFrame(resizeFrame.current)
      }
      if (transitionOverflowTimer.current !== null) {
        window.clearTimeout(transitionOverflowTimer.current)
      }
      if (dropExpandTimer.current !== null) {
        window.clearTimeout(dropExpandTimer.current)
      }
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current)
      if (resizeSession.current) restoreDocumentAfterResize()
    },
    []
  )

  function handleResizePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    const panel = panelRef.current
    if (!panel) return
    resizeSession.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: panel.getBoundingClientRect().width,
    }
    previousDocumentStyles.current = {
      userSelect: document.documentElement.style.userSelect,
    }
    document.documentElement.style.userSelect = "none"
    panel.dataset.resizing = "true"
    panel.style.transition = "none"
    event.currentTarget.dataset.resizing = "true"
    // Pointer capture is progressive enhancement; pointer events still work.
    Result.try(() => event.currentTarget.setPointerCapture(event.pointerId))
  }

  function handleResizePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const session = resizeSession.current
    if (!session || session.pointerId !== event.pointerId) return
    scheduleFileTreeWidth(session.startWidth + event.clientX - session.startX)
  }

  function handleResizePointerEnd(event: React.PointerEvent<HTMLDivElement>) {
    if (resizeSession.current?.pointerId !== event.pointerId) return
    // The pointer may already have been released by the browser.
    Result.try(() => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    })
    finishResize(event.pointerId)
  }

  function handleResizeKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 32 : 16
    let nextWidth: number | null = null
    if (event.key === "ArrowLeft") nextWidth = currentWidth.current - step
    if (event.key === "ArrowRight") nextWidth = currentWidth.current + step
    if (event.key === "Home") nextWidth = fileTreeMinWidth
    if (event.key === "End") nextWidth = fileTreeMaxWidth
    if (nextWidth === null) return
    event.preventDefault()
    persistFileTreeWidth(applyFileTreeWidth(nextWidth))
  }

  function handleHomeClick() {
    onMobileOpenChange(false)
    onHome()
  }

  function closeMobileFileBrowser() {
    onMobileOpenChange(false)
    window.requestAnimationFrame(() => mobileBrowseButtonRef.current?.focus())
  }

  return (
    <aside
      ref={panelRef}
      id={`file-tree-${instance.shortId}`}
      data-file-tree-panel
      data-mobile-file-drawer
      data-state={mobileOpen ? "open" : "closed"}
      data-collapsed={collapsed}
      className={`group/tree-drop absolute inset-x-0 bottom-0 z-30 flex w-full shrink-0 flex-col overflow-hidden border-t border-border/80 bg-card shadow-[0_-18px_45px_rgba(0,0,0,0.35)] transition-[height] duration-200 ease-out md:relative md:inset-auto md:z-auto md:h-auto md:min-h-0 md:border-t-0 md:shadow-none ${animateCollapsedChange ? "md:transition-[width,min-width,max-width] md:duration-200 md:ease-linear" : "md:transition-none"} ${collapsed ? "md:!w-0 md:!max-w-0 md:!min-w-0 md:overflow-hidden" : "md:w-[var(--file-tree-width)] md:max-w-[45%] md:min-w-56 md:overflow-visible md:[--file-tree-width:17.5rem] xl:max-w-[30rem] xl:[--file-tree-width:19rem]"} ${mobileOpen ? "h-full" : "h-11"}`}
      onDragEnter={handleTreeDragEnter}
      onDragOver={handleTreeDragOver}
      onDragLeave={handleTreeDragLeave}
      onDrop={handleTreeDrop}
      onTransitionEnd={(event) => {
        if (event.currentTarget !== event.target) return
        if (
          event.propertyName === "width" ||
          event.propertyName === "min-width" ||
          event.propertyName === "max-width"
        ) {
          finishPanelTransition()
        }
      }}
      style={
        initialWidth
          ? ({
              "--file-tree-width": `${initialWidth}px`,
            } as React.CSSProperties)
          : undefined
      }
    >
      <div
        className={`${mobileContentVisible ? "flex" : "hidden"} order-1 h-12 shrink-0 items-center border-b border-border/80 bg-card px-3 md:hidden`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <FolderTree className="size-[18px] shrink-0 text-primary" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">Browse files</p>
            <p className="type-code truncate text-muted-foreground">/data</p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close file browser"
          onClick={closeMobileFileBrowser}
        >
          <X className="size-[18px]" />
        </Button>
      </div>

      <div
        className={`absolute inset-x-0 bottom-0 z-10 order-2 flex h-11 shrink-0 items-center overflow-hidden border-t bg-card px-1.5 md:relative md:inset-auto md:z-auto md:order-1 md:h-14 md:w-[var(--file-tree-width)] md:border-t-0 md:border-b md:px-2 ${collapsed ? "md:invisible" : ""}`}
      >
        <FileTreeHomeButton
          selectionStore={selectionStore}
          onClick={handleHomeClick}
        />
        <Button
          ref={mobileBrowseButtonRef}
          variant={mobileOpen ? "secondary" : "ghost"}
          size="icon-sm"
          className="shrink-0 shadow-none md:hidden"
          aria-label="Browse files"
          aria-controls={`file-tree-${instance.shortId}`}
          aria-expanded={mobileOpen}
          onClick={() => onMobileOpenChange(!mobileOpen)}
        >
          <FolderTree className="size-[18px]" />
        </Button>
        <FileTreeSearchInput
          model={model}
          onSearchQueryChange={handleSearchQueryChange}
          onMobileOpenChange={onMobileOpenChange}
          onMobileClose={closeMobileFileBrowser}
          searchComplete={indexStatus.searchComplete}
          searching={indexStatus.searching}
        />
        <div className="flex shrink-0 items-center gap-0.5">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="New"
                title="New…"
              >
                <Plus className="size-[18px]" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              side="bottom"
              sideOffset={6}
              className="w-56 p-1"
            >
              <p className="type-technical-label border-b px-2 py-2 text-muted-foreground">
                Add to instance
              </p>
              <FileActionPreview icon={<FolderPlus />} label="New directory" />
              <FileActionPreview icon={<FilePlus />} label="New file" />
              <FileUploadPickerAction
                disabled={!canWrite || uploading || refreshDisabled}
                onClick={() => uploadInputRef.current?.click()}
                icon={<Upload />}
                label="Upload files"
                uploading={uploading}
              />
              <FileUploadPickerAction
                disabled={!canWrite || uploading || refreshDisabled}
                onClick={() => folderUploadInputRef.current?.click()}
                icon={<FolderPlus />}
                label="Upload folder"
                uploading={uploading}
              />
              <input
                ref={uploadInputRef}
                type="file"
                multiple
                className="hidden"
                aria-label="Choose files to upload"
                onChange={(event) => void handleFilesSelected(event)}
              />
              <input
                {...folderInputAttributes}
                ref={folderUploadInputRef}
                type="file"
                multiple
                className="hidden"
                aria-label="Choose folder to upload"
                onChange={(event) => void handleFilesSelected(event)}
              />
              <FileActionPreview icon={<Network />} label="Connect with SFTP" />
            </PopoverContent>
          </Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              {indexStatus.refreshing ? (
                <span className="inline-flex">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Refreshing files"
                    disabled
                  >
                    <RefreshCw className="size-[18px] animate-spin" />
                  </Button>
                </span>
              ) : (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Refresh files"
                  disabled={refreshDisabled}
                  onClick={onRefresh}
                >
                  <RefreshCw className="size-[18px]" />
                </Button>
              )}
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {indexStatus.refreshing
                ? "Refreshing Files"
                : refreshDisabled
                  ? "Relay disconnected"
                  : "Refresh Files"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="hidden md:inline-flex"
                aria-label="Collapse file tree"
                aria-controls={`file-tree-${instance.shortId}`}
                onClick={() => onCollapsedChange(true)}
              >
                <PanelLeftClose className="size-[18px]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Collapse File Tree
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div
        className={`order-1 mb-11 min-h-0 flex-1 overflow-hidden bg-card py-1.5 md:order-2 md:mb-0 md:block md:w-[var(--file-tree-width)] md:shrink-0 ${mobileContentVisible ? "block" : "hidden"} ${collapsed ? "md:invisible" : ""}`}
      >
        <FileTreeSelectionSync model={model} selectionStore={selectionStore} />
        <FileTree
          model={model}
          aria-label={`${instance.name} files`}
          className="block size-full min-h-[210px]"
          onPointerDownCapture={(event) => {
            const directory = resolveTreeEventDirectory(event.nativeEvent)
            if (directory !== null) void fileIndex.ensureDirectory(directory)
          }}
          onKeyDownCapture={(event) => {
            if (!["ArrowRight", "Enter", " "].includes(event.key)) return
            const directory = resolveTreeEventDirectory(event.nativeEvent)
            if (directory !== null) void fileIndex.ensureDirectory(directory)
          }}
          style={
            {
              "--trees-selected-bg-override":
                "color-mix(in oklch, var(--primary) 20%, transparent)",
              "--trees-selected-fg-override": "var(--foreground)",
              "--trees-bg-override": "var(--card)",
              "--trees-bg-muted-override": "var(--muted)",
              "--trees-fg-override": "var(--foreground)",
              "--trees-fg-muted-override": "var(--muted-foreground)",
              "--trees-input-bg-override": "var(--background)",
              "--trees-search-bg-override": "var(--background)",
              "--trees-search-fg-override": "var(--foreground)",
              "--trees-border-color-override": "var(--border)",
              "--trees-border-radius-override": "0px",
              "--trees-font-family-override": "var(--font-sans)",
              "--trees-font-size-override": "0.75rem",
              "--trees-padding-inline-override": "0px",
              "--trees-item-padding-x-override": "5px",
              "--trees-item-margin-x-override": "0px",
              "--trees-item-row-gap-override": "4px",
              "--trees-level-gap-override": "4px",
              "--trees-context-menu-trigger-inline-offset": "8px",
              height: "100%",
            } as React.CSSProperties
          }
          renderContextMenu={(item, context) =>
            loadingPlaceholderPaths.current.has(item.path) ? null : (
              <FileActionsMenu
                surface="tree"
                anchorRect={context.anchorRect}
                close={context.close}
                controller={actions}
                directory={item.kind === "directory"}
                label={`Actions for ${item.name}`}
                paths={[item.path]}
                onOpen={() => {
                  onPathChange(item.path)
                  onFileSelected()
                }}
              />
            )
          }
        />
      </div>

      <div className="pointer-events-none absolute right-2 bottom-12 left-2 z-50 hidden items-center gap-2 border border-primary/35 bg-popover/95 px-3 py-2 text-xs shadow-xl backdrop-blur-sm group-data-[file-drop-active=true]/tree-drop:flex md:bottom-2">
        <Upload className="size-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate">Upload to</span>
        <span
          ref={dropPathLabelRef}
          className="type-code max-w-[65%] truncate text-primary"
        >
          /data/
        </span>
      </div>

      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 z-30 hidden w-px bg-border/80 md:block"
      />

      <div
        ref={resizeHandleRef}
        role="separator"
        tabIndex={0}
        aria-label="Resize file tree"
        aria-orientation="vertical"
        aria-valuemin={fileTreeMinWidth}
        aria-valuemax={fileTreeMaxWidth}
        aria-valuenow={currentWidth.current}
        className={`${collapsed ? "md:hidden" : "md:flex"} group absolute inset-y-0 -right-1 z-40 hidden w-2.5 cursor-col-resize touch-none items-center justify-center outline-none`}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerEnd}
        onPointerCancel={handleResizePointerEnd}
        onLostPointerCapture={() => {
          if (resizeSession.current) finishResize()
        }}
        onDoubleClick={(event) => {
          event.preventDefault()
          persistFileTreeWidth(applyFileTreeWidth(defaultFileTreeWidth()))
        }}
        onKeyDown={handleResizeKeyDown}
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/80 transition-colors group-hover:bg-primary/55 group-focus-visible:bg-primary/75 group-data-[resizing=true]:bg-primary" />
        <span className="relative grid h-9 w-2.5 place-items-center overflow-hidden border border-primary/35 bg-background text-primary opacity-0 shadow-[0_0_14px_color-mix(in_oklch,var(--primary),transparent_70%)] transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[resizing=true]:opacity-100">
          <GripVertical className="size-2" />
        </span>
      </div>
    </aside>
  )
}
