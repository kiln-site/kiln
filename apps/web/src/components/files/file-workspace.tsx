import * as React from "react"
import { useRouter } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { prepareFileTreeInput } from "@pierre/trees"
import { Effect } from "effect"
import type {
  RelayFileActivity,
  RelayFileActivityEntry,
  RelayFileContent,
  RelayFileEntry,
} from "@workspace/contracts"
import {
  ALargeSmall,
  ArrowDownUp,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  Copy,
  Download,
  EllipsisVertical,
  FileCode2,
  FileIcon,
  FilePlus,
  Folder,
  FolderPlus,
  FolderTree,
  GitCompareArrows,
  HardDriveDownload,
  LoaderCircle,
  LockKeyhole,
  Pin,
  PinOff,
  RefreshCw,
  Save,
  Search,
  Share2,
  TriangleAlert,
  Upload,
  WrapText,
  X,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { useIsMobile } from "@workspace/ui/hooks/use-mobile"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import type { SyntaxCodeEditorHandle } from "@/components/syntax-code-editor"
import {
  FileTreeLoadingPanel,
  FileWorkspaceLoadingState,
} from "@/components/file-tree-loading-panel"
import {
  createEditorSearchStore,
  createEditorSessionStore,
  createFileEditorPreferencesStore,
  createFileSelectionStore,
  fileEditorFontSizes,
} from "@/components/files/file-workspace-stores"
import {
  FileActionDialogHost,
  FileActionMenuItem,
  FileActionsDropdown,
  useFileActions,
} from "@/components/files/file-actions"
import { FileDownloadDialog } from "@/components/files/file-download-dialog"
import { FileTreePanel } from "@/components/files/file-tree-panel"
import {
  ProgressiveFileIndex,
  type FileDirectorySnapshot,
} from "@/components/files/progressive-file-index"
import {
  directoryPath,
  folderInputAttributes,
  normalizeDirectoryPath,
} from "@/components/files/file-tree-utils"
import type { FileActionsController } from "@/components/files/file-tree-utils"
import { EditorTooltip } from "@/components/files/editor-tooltip"
import { selectedUploadFiles } from "@/components/files/file-upload-selection"
import {
  FileDropOverlay,
  useFileDropTarget,
  useFileUploadAction,
  type UploadFiles,
} from "@/components/files/file-upload"
import type {
  EditorSearchStore,
  EditorSessionStore,
  FileEditorPreferencesStore,
  FileSelectionStore,
} from "@/components/files/file-workspace-stores"
import { redactSensitiveText } from "@/lib/redaction"
import { fileLanguageForPath } from "@/lib/file-language"
import {
  loadSyntaxCodeEditorModule,
  warmSyntaxCodeEditorModule,
  warmSyntaxCodeEditorModuleWhenIdle,
} from "@/lib/syntax-editor-module-preload"
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"
import {
  queryKeys,
  relayFileActivityQueryOptions,
  relayFileEntryQueryOptions,
  relayFileQueryOptions,
  relayRootDirectoryQueryOptions,
} from "@/lib/query-options"
import {
  saveRelayFile,
  updateRelayFilePin,
  uploadToMclogs,
} from "@/server/relay"

const SyntaxCodeEditor = React.lazy(async () => {
  const module = await loadSyntaxCodeEditorModule()
  return { default: module.SyntaxCodeEditor }
})

const activeFileRevisionPollDelayMs = 30_000

function formatName(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path
}

const fileEditorHeaderClassName =
  "flex h-14 shrink-0 border-b md:h-auto md:min-h-14"
const fileEditorHeaderContentClassName =
  "flex min-w-0 flex-1 items-center gap-2 px-2 sm:px-3 md:flex-wrap md:gap-x-3 md:gap-y-2 md:py-[7px]"

const fileTreeCollapsedCookieName = "file_tree_collapsed"
const fileTreeCookieMaxAge = 60 * 60 * 24 * 7
const recentFileDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
})
const olderFileDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
})
const relativeFileMinuteMs = 60_000
const relativeFileHourMs = 60 * relativeFileMinuteMs
const relativeFileDayMs = 24 * relativeFileHourMs

function shortRelativeFileTime(timestamp: number): string | null {
  const elapsed = Math.max(0, Date.now() - timestamp)
  if (elapsed < relativeFileMinuteMs) return "just now"
  if (elapsed < relativeFileHourMs) {
    return `${Math.floor(elapsed / relativeFileMinuteMs)}m ago`
  }
  if (elapsed < relativeFileDayMs) {
    return `${Math.floor(elapsed / relativeFileHourMs)}h ago`
  }
  if (elapsed < 7 * relativeFileDayMs) {
    return `${Math.floor(elapsed / relativeFileDayMs)}d ago`
  }
  return null
}

async function copyToClipboard(value: string) {
  await Effect.runPromise(
    Effect.tryPromise({
      try: () => navigator.clipboard.writeText(value),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch(() =>
        Effect.try({
          try: () => {
            const textarea = document.createElement("textarea")
            textarea.value = value
            textarea.style.position = "fixed"
            textarea.style.opacity = "0"
            document.body.append(textarea)
            textarea.select()
            const copied = document.execCommand("copy")
            textarea.remove()
            if (!copied) throw new Error("Could not copy to clipboard")
          },
          catch: (cause) => cause,
        })
      )
    )
  )
}

async function runEditorSave(
  save: () => Promise<unknown>,
  sessionStore: EditorSessionStore,
  fallbackMessage: string
): Promise<void> {
  await Effect.runPromise(
    Effect.tryPromise({ try: save, catch: (cause) => cause }).pipe(
      Effect.catch((cause) =>
        Effect.sync(() =>
          sessionStore.setSaveError(
            cause instanceof Error ? cause.message : fallbackMessage
          )
        )
      ),
      Effect.ensuring(
        Effect.sync(() => {
          sessionStore.setSaving(false)
        })
      )
    )
  )
}

function FileTreeRevealButton({ onClick }: { onClick: () => void }) {
  return (
    <div
      className="hidden shrink-0 self-stretch border-r md:flex"
      style={{ width: "var(--file-editor-gutter-width, 3rem)" }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="grid size-full place-items-center text-primary transition-colors outline-none hover:bg-accent/45 hover:text-primary focus-visible:bg-accent/55 focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:ring-inset"
            aria-label="Open file tree"
            onClick={onClick}
          >
            <FolderTree className="size-[17px]" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={7}>
          Open File Tree
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

function FilePathCopyButton({ path }: { path: string }) {
  const [copyState, setCopyState] = React.useState<"idle" | "copied">("idle")
  const resetTimer = React.useRef<number | null>(null)
  const fullFilePath = `/data/${path.replace(/^\/+/, "")}`

  React.useEffect(
    () => () => {
      if (resetTimer.current) window.clearTimeout(resetTimer.current)
    },
    []
  )

  async function handleCopy() {
    await copyToClipboard(fullFilePath)
    setCopyState("copied")
    if (resetTimer.current) window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 1800)
  }

  return (
    <EditorTooltip
      content={copyState === "copied" ? "File Path Copied" : "Copy File Path"}
    >
      <button
        type="button"
        className="group/path flex max-w-full items-center gap-1 font-mono text-[0.625rem] text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:outline-none sm:text-[0.6875rem]"
        aria-label={
          copyState === "copied"
            ? `Copied ${fullFilePath}`
            : `Copy ${fullFilePath}`
        }
        onClick={handleCopy}
      >
        <span className="truncate">{fullFilePath}</span>
        {copyState === "copied" ? (
          <Check className="size-3.5 shrink-0 text-primary" />
        ) : (
          <Copy className="size-3.5 shrink-0 opacity-65 transition-opacity group-hover/path:opacity-100" />
        )}
      </button>
    </EditorTooltip>
  )
}

function FileToolbarIdentity({
  path,
  pathIsCopyable = true,
  readOnly = false,
  directory = false,
}: {
  path: string
  pathIsCopyable?: boolean
  readOnly?: boolean
  directory?: boolean
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5 md:gap-3">
      {directory ? (
        <Folder className="size-5 shrink-0 text-primary" />
      ) : (
        <FileCode2 className="size-5 shrink-0 text-primary" />
      )}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex min-w-0 items-center gap-2.5">
          <p className="min-w-0 truncate text-sm font-semibold">
            {formatName(path)}
          </p>
          {readOnly ? (
            <span className="hidden shrink-0 border border-primary/20 bg-primary/8 px-2 py-0.5 font-mono text-[0.5625rem] tracking-wider text-primary sm:inline-flex">
              READ ONLY
            </span>
          ) : null}
        </div>
        {pathIsCopyable ? (
          <FilePathCopyButton key={path} path={path} />
        ) : (
          <p className="truncate font-mono text-[0.625rem] text-muted-foreground sm:text-[0.6875rem]">
            /data/{path}
          </p>
        )}
      </div>
    </div>
  )
}

const StableFileToolbarIdentity = React.memo(FileToolbarIdentity)

type SaveFileRevision = (
  content: string,
  expectedModifiedAt: string | undefined
) => Promise<RelayFileContent>

interface EditorSaveOptions {
  canWrite: boolean
  fileReadOnly: boolean
  loading: boolean
  saveFile: SaveFileRevision
  sessionStore: EditorSessionStore
}

function canSaveEditor({
  canWrite,
  fileReadOnly,
  loading,
  sessionStore,
}: EditorSaveOptions) {
  return (
    canWrite &&
    !fileReadOnly &&
    !loading &&
    sessionStore.getDirtySnapshot() &&
    !sessionStore.getDiskConflictSnapshot() &&
    !sessionStore.getSavingSnapshot()
  )
}

async function saveEditorChanges(options: EditorSaveOptions) {
  if (!canSaveEditor(options)) return

  const { saveFile, sessionStore } = options
  sessionStore.setSaving(true)
  sessionStore.setSaveError(null)
  await runEditorSave(
    () =>
      saveFile(sessionStore.getValue(), sessionStore.getExpectedModifiedAt()),
    sessionStore,
    "Save failed"
  )
}

function Editor({
  file,
  displayPath,
  instance,
  loading: queryLoading,
  error,
  canShare,
  canWrite,
  preferencesStore,
  treeCollapsed,
  onTreeExpand,
  onUploadFiles,
}: {
  file: RelayFileContent
  displayPath: string
  instance: InstanceWorkspaceInstance
  loading: boolean
  error: string | null
  canShare: boolean
  canWrite: boolean
  preferencesStore: FileEditorPreferencesStore
  treeCollapsed: boolean
  onTreeExpand: () => void
  onUploadFiles: UploadFiles
}) {
  const [sessionStore] = React.useState(() =>
    createEditorSessionStore(file.content, file.modifiedAt)
  )
  const searchStore = React.useMemo(createEditorSearchStore, [])
  const editorRef = React.useRef<SyntaxCodeEditorHandle>(null)
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  const sectionRef = React.useRef<HTMLElement>(null)
  const saveFile = useFileSaveAction(file, instance, sessionStore)
  const loading = queryLoading
  const dropTarget = useFileDropTarget({
    directory: directoryPath(file.path),
    enabled: canWrite,
    onUploadFiles,
    ref: sectionRef,
  })

  React.useEffect(() => {
    const saveOptions = {
      canWrite,
      fileReadOnly: file.readOnly,
      loading,
      saveFile,
      sessionStore,
    }
    function handleSaveShortcut(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.key.toLowerCase() !== "s" ||
        (!event.ctrlKey && !event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        !canSaveEditor(saveOptions)
      ) {
        return
      }

      event.preventDefault()
      void saveEditorChanges(saveOptions)
    }

    window.addEventListener("keydown", handleSaveShortcut)
    return () => window.removeEventListener("keydown", handleSaveShortcut)
  }, [canWrite, file.readOnly, loading, saveFile, sessionStore])

  React.useLayoutEffect(() => {
    const section = sectionRef.current
    const gutters = section?.querySelector<HTMLElement>(".cm-gutters")
    if (!section || !gutters) return
    const sectionElement = section
    const gutterElement = gutters

    function syncGutterWidth() {
      const nextWidth = `${gutterElement.getBoundingClientRect().width}px`
      if (
        sectionElement.style.getPropertyValue("--file-editor-gutter-width") ===
        nextWidth
      ) {
        return
      }
      sectionElement.style.setProperty("--file-editor-gutter-width", nextWidth)
    }

    syncGutterWidth()
    const observer = new ResizeObserver(syncGutterWidth)
    observer.observe(gutterElement)
    return () => observer.disconnect()
  }, [file.path])

  return (
    <section
      ref={sectionRef}
      className="group/drop relative flex min-h-0 min-w-0 flex-1 flex-col bg-card"
      {...dropTarget}
    >
      <FileDropOverlay directory={directoryPath(file.path)} />
      <EditorDiskRevisionSync
        content={file.content}
        modifiedAt={file.modifiedAt}
        sessionStore={sessionStore}
      />
      <EditorSearchBoundary
        editorRef={editorRef}
        inputRef={searchInputRef}
        searchStore={searchStore}
        sessionStore={sessionStore}
      >
        <PopoverAnchor asChild>
          <div className={fileEditorHeaderClassName} data-file-toolbar>
            {treeCollapsed ? (
              <FileTreeRevealButton onClick={onTreeExpand} />
            ) : null}
            <div className={fileEditorHeaderContentClassName}>
              <StableFileToolbarIdentity
                path={displayPath}
                readOnly={file.encoding === "gzip"}
              />

              <EditorResponsiveActions
                canShare={canShare}
                canWrite={canWrite}
                file={file}
                instance={instance}
                loading={loading}
                preferencesStore={preferencesStore}
                saveFile={saveFile}
                sessionStore={sessionStore}
              />
            </div>
          </div>
        </PopoverAnchor>
      </EditorSearchBoundary>

      <EditorDiskConflictNotice
        canOverwrite={canWrite && !file.readOnly}
        content={file.content}
        loading={loading}
        modifiedAt={file.modifiedAt}
        saveFile={saveFile}
        sessionStore={sessionStore}
      />

      <div className="editor-grid relative min-h-[360px] min-w-0 flex-1 overflow-hidden">
        <React.Suspense fallback={<SyntaxEditorLoadingState />}>
          <StableEditorDocument
            editorRef={editorRef}
            ariaLabel={`Edit ${formatName(file.path)}`}
            path={file.path}
            disabled={loading}
            redactSensitive
            readOnly={file.readOnly || !canWrite}
            preferencesStore={preferencesStore}
            searchStore={searchStore}
            sessionStore={sessionStore}
          />
        </React.Suspense>
        {loading ? (
          <div className="absolute inset-y-0 right-0 left-[var(--file-editor-gutter-width,3rem)] z-20 grid place-items-center bg-card/75 backdrop-blur-[2px]">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin text-primary" />
              Reading from Relay
            </div>
          </div>
        ) : null}
      </div>

      <EditorFooter error={error} file={file} sessionStore={sessionStore} />
    </section>
  )
}

function EditorDiskRevisionSync({
  content,
  modifiedAt,
  sessionStore,
}: {
  content: string
  modifiedAt: string
  sessionStore: EditorSessionStore
}) {
  const dirty = React.useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getDirtySnapshot,
    sessionStore.getDirtySnapshot
  )

  React.useLayoutEffect(() => {
    sessionStore.reconcileDiskRevision(content, modifiedAt)
  }, [content, dirty, modifiedAt, sessionStore])

  return null
}

function EditorDiskConflictNotice({
  canOverwrite,
  content,
  loading,
  modifiedAt,
  saveFile,
  sessionStore,
}: {
  canOverwrite: boolean
  content: string
  loading: boolean
  modifiedAt: string
  saveFile: SaveFileRevision
  sessionStore: EditorSessionStore
}) {
  const conflicted = React.useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getDiskConflictSnapshot,
    sessionStore.getDiskConflictSnapshot
  )
  const saving = React.useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getSavingSnapshot,
    sessionStore.getSavingSnapshot
  )

  if (!conflicted) return null

  function handleReload() {
    if (sessionStore.getSavingSnapshot()) return
    sessionStore.reloadFromDisk(content, modifiedAt)
  }

  async function handleOverwrite() {
    if (sessionStore.getSavingSnapshot()) return
    sessionStore.setSaving(true)
    sessionStore.setSaveError(null)
    await runEditorSave(
      () => saveFile(sessionStore.getValue(), undefined),
      sessionStore,
      "Overwrite failed"
    )
  }

  return (
    <div
      role="alert"
      className="flex shrink-0 flex-col gap-2 border-b border-destructive/30 bg-destructive/[0.07] px-3 py-2.5 xl:flex-row xl:items-center"
    >
      <div className="flex min-w-0 items-start gap-2 xl:items-center">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive xl:mt-0" />
        <div className="min-w-0">
          <p className="text-xs font-medium text-destructive">
            File changed on disk
          </p>
          <p className="text-[0.625rem] leading-4 text-muted-foreground">
            Reload the latest version or explicitly overwrite it with your
            changes.
          </p>
        </div>
      </div>
      <div className="ml-6 flex shrink-0 gap-1.5 xl:ml-auto">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={saving || loading}
          onClick={handleReload}
        >
          <RefreshCw />
          Reload
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={!canOverwrite || saving || loading}
          onClick={() => void handleOverwrite()}
        >
          {saving ? <LoaderCircle className="animate-spin" /> : <Save />}
          {saving ? "Overwriting" : "Overwrite"}
        </Button>
      </div>
    </div>
  )
}

function SyntaxEditorLoadingState() {
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 bg-card"
      aria-label="Opening editor"
      aria-busy="true"
    >
      <div
        className="w-[var(--file-editor-gutter-width,3rem)] shrink-0 border-r border-border/80 bg-muted/10"
        aria-hidden="true"
      />
      <div className="grid min-w-0 flex-1 place-items-center px-6 text-center">
        <FileWorkspaceLoadingState
          title="Opening editor"
          description="Preparing the syntax-aware editor."
        />
      </div>
    </div>
  )
}

function EditorResponsiveActions({
  canShare,
  canWrite,
  file,
  instance,
  loading,
  preferencesStore,
  saveFile,
  sessionStore,
}: {
  canShare: boolean
  canWrite: boolean
  file: RelayFileContent
  instance: InstanceWorkspaceInstance
  loading: boolean
  preferencesStore: FileEditorPreferencesStore
  saveFile: SaveFileRevision
  sessionStore: EditorSessionStore
}) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return (
      <div className="ml-auto flex shrink-0 items-center gap-1 md:hidden">
        <StableEditorSearchToggleButton
          loading={loading}
          sessionStore={sessionStore}
        />
        <EditorSaveButton
          canWrite={canWrite}
          file={file}
          loading={loading}
          saveFile={saveFile}
          sessionStore={sessionStore}
        />
        <StableEditorMobileOverflowMenu
          canShare={canShare}
          canWrite={canWrite}
          filePath={file.path}
          fileReadOnly={file.readOnly}
          instance={instance}
          loading={loading}
          preferencesStore={preferencesStore}
          sessionStore={sessionStore}
        />
      </div>
    )
  }

  return (
    <div
      className="ml-auto hidden max-w-full min-w-0 flex-wrap items-center justify-end gap-1 md:flex"
      data-file-editor-actions
    >
      {canShare ? (
        <StableEditorShareButton
          instance={instance}
          loading={loading}
          path={file.path}
          sessionStore={sessionStore}
        />
      ) : null}
      <StableEditorSearchToggleButton
        loading={loading}
        sessionStore={sessionStore}
      />
      <StableEditorFontSizeButton preferencesStore={preferencesStore} />
      <StableEditorWrapButton sessionStore={sessionStore} />
      <StableEditorCopyButton sessionStore={sessionStore} />
      <EditorDownloadButton
        instance={instance}
        loading={loading}
        path={file.path}
      />
      <EditorSaveButton
        canWrite={canWrite}
        file={file}
        loading={loading}
        saveFile={saveFile}
        sessionStore={sessionStore}
      />
      <StableEditorOverflowMenu
        canWrite={canWrite}
        filePath={file.path}
        fileReadOnly={file.readOnly}
        instance={instance}
        loading={loading}
        sessionStore={sessionStore}
      />
    </div>
  )
}

function EditorSearchBoundary({
  children,
  editorRef,
  inputRef,
  searchStore,
  sessionStore,
}: {
  children: React.ReactElement
  editorRef: React.RefObject<SyntaxCodeEditorHandle | null>
  inputRef: React.RefObject<HTMLInputElement | null>
  searchStore: EditorSearchStore
  sessionStore: EditorSessionStore
}) {
  const open = React.useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getSearchOpenSnapshot,
    sessionStore.getSearchOpenSnapshot
  )

  return (
    <Popover open={open} onOpenChange={sessionStore.setSearchOpen}>
      {children}
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={7}
        collisionPadding={12}
        className="w-[min(18rem,calc(100vw-1rem))] p-2"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
        }}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <EditorSearchContent
          editorRef={editorRef}
          inputRef={inputRef}
          store={searchStore}
          onClose={() => sessionStore.setSearchOpen(false)}
        />
      </PopoverContent>
    </Popover>
  )
}

function EditorSearchToggleButton({
  loading,
  sessionStore,
}: {
  loading: boolean
  sessionStore: EditorSessionStore
}) {
  const open = React.useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getSearchOpenSnapshot,
    sessionStore.getSearchOpenSnapshot
  )
  return (
    <EditorTooltip content={open ? "Hide Search in File" : "Search in File"}>
      <Button
        variant={open ? "secondary" : "ghost"}
        size="icon"
        className="disabled:opacity-100"
        aria-label={open ? "Close file search" : "Search file"}
        aria-pressed={open}
        aria-keyshortcuts="Control+F Meta+F"
        disabled={loading}
        onClick={() => sessionStore.setSearchOpen(!open)}
      >
        <Search className="size-[17px]" />
      </Button>
    </EditorTooltip>
  )
}

function useEditorShareAction({
  instance,
  path,
  sessionStore,
}: {
  instance: InstanceWorkspaceInstance
  path: string
  sessionStore: EditorSessionStore
}) {
  const [state, setState] = React.useState<
    "idle" | "uploading" | "copied" | "error"
  >("idle")
  const resetTimer = React.useRef<number | null>(null)
  React.useEffect(
    () => () => {
      if (resetTimer.current) window.clearTimeout(resetTimer.current)
    },
    []
  )

  async function handleShare() {
    setState("uploading")
    await Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          const result = await uploadToMclogs({
            data: {
              content: redactSensitiveText(sessionStore.getValue()),
              instanceId: instance.id,
              relayId: instance.relayId,
              path,
              implementation: instance.implementation,
              version: instance.version,
            },
          })
          await copyToClipboard(result.url)
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.match({
          onFailure: () => setState("error"),
          onSuccess: () => setState("copied"),
        })
      )
    )
    if (resetTimer.current) window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setState("idle"), 2800)
  }

  return { share: handleShare, state }
}

function EditorShareButton({
  instance,
  loading,
  path,
  sessionStore,
}: {
  instance: InstanceWorkspaceInstance
  loading: boolean
  path: string
  sessionStore: EditorSessionStore
}) {
  const { share, state } = useEditorShareAction({
    instance,
    path,
    sessionStore,
  })

  return (
    <EditorTooltip
      content={
        state === "uploading"
          ? "Uploading to mclo.gs"
          : state === "copied"
            ? "Link Copied"
            : state === "error"
              ? "Retry mclo.gs Upload"
              : "Upload to mclo.gs"
      }
    >
      <Button
        variant={
          state === "copied"
            ? "secondary"
            : state === "error"
              ? "destructive"
              : "ghost"
        }
        size="default"
        className="h-8 shrink-0 gap-1.5 px-2.5 text-xs shadow-none disabled:opacity-100"
        aria-label={`Upload ${formatName(path)} to mclo.gs and copy link`}
        disabled={state === "uploading" || loading}
        onClick={share}
      >
        {state === "uploading" ? (
          <LoaderCircle className="size-[17px] animate-spin" />
        ) : state === "copied" ? (
          <Check className="size-[17px]" />
        ) : state === "error" ? (
          <TriangleAlert className="size-[17px]" />
        ) : (
          <Share2 className="size-[17px]" />
        )}
        <span>
          {state === "uploading"
            ? "Uploading"
            : state === "copied"
              ? "Link copied"
              : state === "error"
                ? "Try again"
                : "mclo.gs"}
        </span>
      </Button>
    </EditorTooltip>
  )
}

function useEditorCopyAction(sessionStore: EditorSessionStore) {
  const [copied, setCopied] = React.useState(false)
  const resetTimer = React.useRef<number | null>(null)
  React.useEffect(
    () => () => {
      if (resetTimer.current) window.clearTimeout(resetTimer.current)
    },
    []
  )

  async function copy() {
    await copyToClipboard(redactSensitiveText(sessionStore.getValue()))
    setCopied(true)
    if (resetTimer.current) window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setCopied(false), 1800)
  }

  return { copied, copy }
}

function EditorCopyButton({
  sessionStore,
}: {
  sessionStore: EditorSessionStore
}) {
  const { copied, copy } = useEditorCopyAction(sessionStore)

  return (
    <EditorTooltip
      content={copied ? "File Contents Copied" : "Copy File Contents"}
    >
      <Button
        variant={copied ? "secondary" : "ghost"}
        size="icon"
        aria-label={copied ? "File Contents Copied" : "Copy File Contents"}
        onClick={copy}
      >
        {copied ? (
          <Check className="size-[17px]" />
        ) : (
          <Copy className="size-[17px]" />
        )}
      </Button>
    </EditorTooltip>
  )
}

function EditorWrapButton({
  sessionStore,
}: {
  sessionStore: EditorSessionStore
}) {
  const wrapLines = React.useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getWrapLinesSnapshot,
    sessionStore.getWrapLinesSnapshot
  )
  return (
    <EditorTooltip
      content={wrapLines ? "Disable Line Wrap" : "Enable Line Wrap"}
    >
      <Button
        variant={wrapLines ? "secondary" : "ghost"}
        size="icon"
        aria-label={wrapLines ? "Disable line wrap" : "Enable line wrap"}
        aria-pressed={wrapLines}
        onClick={sessionStore.toggleWrapLines}
      >
        <WrapText className="size-[17px]" />
      </Button>
    </EditorTooltip>
  )
}

function EditorReviewChangesMenuItem({
  fileReadOnly,
  labelMode,
  loading,
  sessionStore,
}: {
  fileReadOnly: boolean
  labelMode: "dynamic" | "static"
  loading: boolean
  sessionStore: EditorSessionStore
}) {
  const dirty = React.useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getDirtySnapshot,
    sessionStore.getDirtySnapshot
  )
  const reviewChanges = React.useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getReviewChangesSnapshot,
    sessionStore.getReviewChangesSnapshot
  )
  const label =
    labelMode === "static"
      ? "Review changes"
      : dirty
        ? reviewChanges
          ? "Hide changes"
          : "Highlight changes"
        : "Review changes"

  return (
    <FileActionMenuItem
      active={dirty && reviewChanges}
      icon={<GitCompareArrows />}
      label={label}
      detail="Compare with the saved file"
      disabled={!dirty || loading || fileReadOnly}
      onClick={sessionStore.toggleReviewChanges}
    />
  )
}

function EditorOverflowMenu({
  canWrite,
  filePath,
  fileReadOnly,
  instance,
  loading,
  sessionStore,
}: {
  canWrite: boolean
  filePath: string
  fileReadOnly: boolean
  instance: InstanceWorkspaceInstance
  loading: boolean
  sessionStore: EditorSessionStore
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={open ? "secondary" : "ghost"}
          size="icon"
          aria-label="More file actions"
          aria-expanded={open}
          title="More file actions"
        >
          <EllipsisVertical className="size-[18px]" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={7}
        collisionPadding={8}
        className="w-[min(17rem,calc(100vw-1rem))] p-1"
      >
        <p className="border-b px-2 py-2 text-[0.625rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
          File actions
        </p>
        <FilePinActionMenuItem
          canWrite={canWrite}
          editorLoading={loading}
          instance={instance}
          path={filePath}
        />
        <EditorReviewChangesMenuItem
          fileReadOnly={fileReadOnly}
          labelMode="dynamic"
          loading={loading}
          sessionStore={sessionStore}
        />
        <EditorDownloadActionMenuItem
          instance={instance}
          loading={loading}
          path={filePath}
        />
      </PopoverContent>
    </Popover>
  )
}

function EditorMobileFontSizeSection({
  preferencesStore,
}: {
  preferencesStore: FileEditorPreferencesStore
}) {
  const fontSize = React.useSyncExternalStore(
    preferencesStore.subscribe,
    preferencesStore.getFontSizeSnapshot,
    preferencesStore.getFontSizeSnapshot
  )

  return (
    <div className="border-t border-border/45 px-2 py-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-xs font-medium text-foreground">
          <ALargeSmall className="size-4 text-muted-foreground" /> Text size
        </span>
        <span className="font-mono text-[0.625rem] text-muted-foreground">
          {fontSize}px
        </span>
      </div>
      <EditorFontSizeControl
        fontSize={fontSize}
        onFontSizeChange={preferencesStore.setFontSize}
      />
    </div>
  )
}

function EditorShareActionMenuItem({
  instance,
  loading,
  path,
  sessionStore,
}: {
  instance: InstanceWorkspaceInstance
  loading: boolean
  path: string
  sessionStore: EditorSessionStore
}) {
  const { share, state } = useEditorShareAction({
    instance,
    path,
    sessionStore,
  })

  return (
    <FileActionMenuItem
      icon={
        state === "uploading" ? (
          <LoaderCircle className="animate-spin" />
        ) : state === "copied" ? (
          <Check />
        ) : state === "error" ? (
          <TriangleAlert />
        ) : (
          <Share2 />
        )
      }
      label={
        state === "uploading"
          ? "Uploading"
          : state === "copied"
            ? "Link copied"
            : state === "error"
              ? "Try mclo.gs again"
              : "Upload to mclo.gs"
      }
      detail="Copies a shareable link"
      disabled={state === "uploading" || loading}
      onClick={share}
    />
  )
}

function EditorWrapActionMenuItem({
  sessionStore,
}: {
  sessionStore: EditorSessionStore
}) {
  const wrapLines = React.useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getWrapLinesSnapshot,
    sessionStore.getWrapLinesSnapshot
  )

  return (
    <FileActionMenuItem
      active={wrapLines}
      icon={<WrapText />}
      label="Wrap long lines"
      detail="Fit text to the editor"
      onClick={sessionStore.toggleWrapLines}
    />
  )
}

function EditorCopyActionMenuItem({
  sessionStore,
}: {
  sessionStore: EditorSessionStore
}) {
  const { copied, copy } = useEditorCopyAction(sessionStore)

  return (
    <FileActionMenuItem
      icon={copied ? <Check /> : <Copy />}
      label={copied ? "Contents copied" : "Copy contents"}
      detail="Redacts IP addresses"
      onClick={copy}
    />
  )
}

function EditorDownloadActionMenuItem({
  instance,
  loading,
  path,
}: {
  instance: InstanceWorkspaceInstance
  loading: boolean
  path: string
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <>
      <FileActionMenuItem
        icon={<Download />}
        label="Download"
        detail="Preview size and compression"
        disabled={loading}
        onClick={() => setOpen(true)}
      />
      <FileDownloadDialog
        instance={instance}
        open={open}
        path={path}
        onOpenChange={setOpen}
      />
    </>
  )
}

function EditorDownloadButton({
  instance,
  loading,
  path,
}: {
  instance: InstanceWorkspaceInstance
  loading: boolean
  path: string
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <>
      <EditorTooltip content="Download">
        <Button
          variant={open ? "secondary" : "ghost"}
          size="icon"
          aria-label="Download file"
          disabled={loading}
          onClick={() => setOpen(true)}
        >
          <Download className="size-[17px]" />
        </Button>
      </EditorTooltip>
      <FileDownloadDialog
        instance={instance}
        open={open}
        path={path}
        onOpenChange={setOpen}
      />
    </>
  )
}

function EditorMobileOverflowMenu({
  canShare,
  canWrite,
  filePath,
  fileReadOnly,
  instance,
  loading,
  preferencesStore,
  sessionStore,
}: {
  canShare: boolean
  canWrite: boolean
  filePath: string
  fileReadOnly: boolean
  instance: InstanceWorkspaceInstance
  loading: boolean
  preferencesStore: FileEditorPreferencesStore
  sessionStore: EditorSessionStore
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={open ? "secondary" : "ghost"}
          size="icon"
          className="shadow-none"
          aria-label="More file actions"
          aria-expanded={open}
        >
          <EllipsisVertical className="size-[18px]" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={7}
        collisionPadding={8}
        className="w-[min(18rem,calc(100vw-1rem))] p-1.5"
      >
        <p className="px-2 pt-1 pb-1.5 font-mono text-[0.5625rem] tracking-[0.12em] text-muted-foreground uppercase">
          File actions
        </p>
        <EditorMobileFontSizeSection preferencesStore={preferencesStore} />
        {canShare ? (
          <EditorShareActionMenuItem
            instance={instance}
            loading={loading}
            path={filePath}
            sessionStore={sessionStore}
          />
        ) : null}
        <FilePinActionMenuItem
          canWrite={canWrite}
          editorLoading={loading}
          instance={instance}
          path={filePath}
        />
        <EditorWrapActionMenuItem sessionStore={sessionStore} />
        <EditorCopyActionMenuItem sessionStore={sessionStore} />
        <EditorReviewChangesMenuItem
          fileReadOnly={fileReadOnly}
          labelMode="static"
          loading={loading}
          sessionStore={sessionStore}
        />
        <EditorDownloadActionMenuItem
          instance={instance}
          loading={loading}
          path={filePath}
        />
      </PopoverContent>
    </Popover>
  )
}

const StableEditorSearchToggleButton = React.memo(EditorSearchToggleButton)
const StableEditorShareButton = React.memo(EditorShareButton)
const StableEditorFontSizeButton = React.memo(EditorFontSizeButton)
const StableEditorWrapButton = React.memo(EditorWrapButton)
const StableEditorCopyButton = React.memo(EditorCopyButton)
const StableEditorOverflowMenu = React.memo(EditorOverflowMenu)
const StableEditorMobileOverflowMenu = React.memo(EditorMobileOverflowMenu)

function EditorFooter({
  error,
  file,
  sessionStore,
}: {
  error: string | null
  file: RelayFileContent
  sessionStore: EditorSessionStore
}) {
  const saveError = React.useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getSaveErrorSnapshot,
    sessionStore.getSaveErrorSnapshot
  )
  return (
    <div className="flex h-7 shrink-0 items-center justify-between border-t bg-muted/10 px-3 font-mono text-[0.5625rem] text-muted-foreground">
      <span className={error || saveError ? "text-destructive" : undefined}>
        {error ||
          saveError ||
          (file.encoding === "gzip"
            ? `${file.size.toLocaleString()} B GZIP → ${file.decodedSize.toLocaleString()} B TEXT`
            : `${file.size.toLocaleString()} BYTES`)}
      </span>
      <div className="flex items-center gap-3">
        <span>UTF-8</span>
        <span>LF</span>
        <span>{fileLanguageForPath(file.path).label}</span>
      </div>
    </div>
  )
}

function useFilePinAction(instance: InstanceWorkspaceInstance, path: string) {
  const queryClient = useQueryClient()
  const selectPinned = React.useCallback(
    (activity: RelayFileActivity) =>
      activity.files.find((entry) => entry.path === path)?.pinned ?? false,
    [path]
  )
  const pinQuery = useQuery({
    ...relayFileActivityQueryOptions(instance.relayId, instance.id),
    select: selectPinned,
  })
  const pinMutation = useMutation({
    mutationFn: updateRelayFilePin,
    onSuccess: (nextActivity) => {
      queryClient.setQueryData(
        queryKeys.relay.fileActivity(instance.relayId, instance.id),
        nextActivity
      )
    },
  })
  const pinned = pinQuery.data ?? false
  const updatePinned = pinMutation.mutate
  const setPinned = React.useCallback(
    (nextPinned: boolean) => {
      updatePinned({
        data: {
          instanceId: instance.id,
          relayId: instance.relayId,
          path,
          pinned: nextPinned,
        },
      })
    },
    [instance.id, instance.relayId, path, updatePinned]
  )
  const error = queryErrorMessage(
    pinMutation.error,
    "Could not update file pin"
  )

  return {
    error,
    loading: pinQuery.isPending,
    pinned,
    pinning: pinMutation.isPending,
    setPinned,
  }
}

function FilePinActionMenuItem({
  canWrite,
  editorLoading,
  instance,
  path,
}: {
  canWrite: boolean
  editorLoading: boolean
  instance: InstanceWorkspaceInstance
  path: string
}) {
  const { error, loading, pinned, pinning, setPinned } = useFilePinAction(
    instance,
    path
  )

  return (
    <FileActionMenuItem
      active={pinned}
      icon={pinned ? <PinOff /> : <Pin />}
      label={pinned ? "Unpin file" : "Pin file"}
      detail={
        error ??
        (canWrite
          ? "Shared on this server's Files home"
          : "Requires file write access")
      }
      disabled={editorLoading || loading || pinning || !canWrite}
      onClick={() => setPinned(!pinned)}
    />
  )
}

function EditorDocument({
  editorRef,
  preferencesStore,
  searchStore,
  sessionStore,
  ...props
}: Omit<
  React.ComponentProps<typeof SyntaxCodeEditor>,
  | "fontSize"
  | "onChange"
  | "onSearchOpenChange"
  | "originalValue"
  | "ref"
  | "searchOpen"
  | "searchQuery"
  | "showChanges"
  | "value"
  | "wrapLines"
> & {
  editorRef: React.RefObject<SyntaxCodeEditorHandle | null>
  preferencesStore: FileEditorPreferencesStore
  searchStore: EditorSearchStore
  sessionStore: EditorSessionStore
}) {
  const value = React.useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getValueSnapshot,
    sessionStore.getValueSnapshot
  )
  const fontSize = React.useSyncExternalStore(
    preferencesStore.subscribe,
    preferencesStore.getFontSizeSnapshot,
    preferencesStore.getFontSizeSnapshot
  )
  const originalValue = React.useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getSavedValueSnapshot,
    sessionStore.getSavedValueSnapshot
  )
  const searchOpen = React.useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getSearchOpenSnapshot,
    sessionStore.getSearchOpenSnapshot
  )
  const showChanges = React.useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getReviewChangesSnapshot,
    sessionStore.getReviewChangesSnapshot
  )
  const wrapLines = React.useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getWrapLinesSnapshot,
    sessionStore.getWrapLinesSnapshot
  )
  const searchQuery = React.useSyncExternalStore(
    searchStore.subscribe,
    searchStore.getSnapshot,
    searchStore.getSnapshot
  )

  const handleChange = React.useCallback(
    (nextValue: string) => {
      sessionStore.setValue(nextValue)
    },
    [sessionStore]
  )

  return (
    <SyntaxCodeEditor
      ref={editorRef}
      {...props}
      fontSize={fontSize}
      onSearchOpenChange={sessionStore.setSearchOpen}
      originalValue={originalValue}
      searchOpen={searchOpen}
      searchQuery={searchQuery}
      showChanges={showChanges}
      value={value}
      wrapLines={wrapLines}
      onChange={handleChange}
    />
  )
}

const StableEditorDocument = React.memo(EditorDocument)

function EditorSearchContent({
  editorRef,
  inputRef,
  onClose,
  store,
}: {
  editorRef: React.RefObject<SyntaxCodeEditorHandle | null>
  inputRef: React.RefObject<HTMLInputElement | null>
  onClose: () => void
  store: EditorSearchStore
}) {
  const query = React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  )

  return (
    <div className="flex items-center gap-1.5">
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          aria-label="Find in file"
          className="h-8 bg-background/70 pr-2 pl-8 font-mono text-base shadow-none md:text-xs"
          placeholder="Find in file…"
          spellCheck={false}
          onChange={(event) => store.setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            event.preventDefault()
            if (event.shiftKey) editorRef.current?.findPrevious()
            else editorRef.current?.findNext()
          }}
        />
      </div>
      <div className="flex shrink-0 items-center">
        <div className="flex h-10 w-9 flex-col gap-px">
          <button
            type="button"
            className="grid min-h-0 flex-1 place-items-center text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:z-10 focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-35"
            aria-label="Previous match"
            disabled={!query}
            onClick={() => editorRef.current?.findPrevious()}
          >
            <ChevronUp className="size-[18px]" />
          </button>
          <button
            type="button"
            className="grid min-h-0 flex-1 place-items-center text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:z-10 focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-35"
            aria-label="Next match"
            disabled={!query}
            onClick={() => editorRef.current?.findNext()}
          >
            <ChevronDown className="size-[18px]" />
          </button>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label="Close file search"
          onClick={onClose}
        >
          <X className="size-[18px]" />
        </Button>
      </div>
    </div>
  )
}

function useFileSaveAction(
  file: RelayFileContent,
  instance: InstanceWorkspaceInstance,
  sessionStore: EditorSessionStore
) {
  const queryClient = useQueryClient()
  const saveMutation = useMutation({
    mutationFn: saveRelayFile,
    onSuccess: async (nextFile, variables) => {
      sessionStore.markSaved(variables.data.content, nextFile.modifiedAt)
      queryClient.setQueryData(
        queryKeys.relay.file(
          variables.data.relayId,
          variables.data.instanceId,
          variables.data.path
        ),
        nextFile
      )
      await queryClient.invalidateQueries({
        queryKey: queryKeys.relay.fileActivity(
          variables.data.relayId,
          variables.data.instanceId
        ),
      })
    },
  })
  const saveFile = saveMutation.mutateAsync

  return React.useCallback(
    (content: string, expectedModifiedAt: string | undefined) =>
      saveFile({
        data: {
          instanceId: instance.id,
          relayId: instance.relayId,
          path: file.path,
          content,
          expectedModifiedAt,
        },
      }),
    [file.path, instance.id, instance.relayId, saveFile]
  )
}

function EditorSaveButton({
  canWrite,
  file,
  loading,
  saveFile,
  sessionStore,
}: {
  canWrite: boolean
  file: RelayFileContent
  loading: boolean
  saveFile: SaveFileRevision
  sessionStore: EditorSessionStore
}) {
  const dirty = React.useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getDirtySnapshot,
    sessionStore.getDirtySnapshot
  )
  const saving = React.useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getSavingSnapshot,
    sessionStore.getSavingSnapshot
  )
  const conflicted = React.useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getDiskConflictSnapshot,
    sessionStore.getDiskConflictSnapshot
  )
  const canSave =
    canWrite && !file.readOnly && !loading && dirty && !conflicted && !saving

  function handleSave() {
    void saveEditorChanges({
      canWrite,
      fileReadOnly: file.readOnly,
      loading,
      saveFile,
      sessionStore,
    })
  }

  return (
    <EditorTooltip
      content={
        file.readOnly
          ? "Read Only"
          : saving
            ? "Saving"
            : conflicted
              ? "Resolve disk conflict"
              : dirty
                ? "Save"
                : "Saved"
      }
    >
      <Button
        size="default"
        className={
          !dirty && !file.readOnly
            ? "gap-1.5 bg-primary/35 px-2.5 text-xs text-primary-foreground/65 shadow-none disabled:opacity-100"
            : "gap-1.5 px-2.5 text-xs shadow-none"
        }
        aria-label={
          file.readOnly
            ? "Archived log is read only"
            : dirty
              ? "Save changes"
              : "Changes saved"
        }
        aria-keyshortcuts="Control+S Meta+S"
        disabled={!canSave}
        onClick={handleSave}
      >
        {file.readOnly ? (
          <LockKeyhole className="size-[17px]" />
        ) : saving ? (
          <LoaderCircle className="size-[17px] animate-spin" />
        ) : (
          <Save className="size-[17px]" />
        )}
        <span>{file.readOnly ? "Read only" : saving ? "Saving" : "Save"}</span>
      </Button>
    </EditorTooltip>
  )
}

function EditorFontSizeButton({
  preferencesStore,
}: {
  preferencesStore: FileEditorPreferencesStore
}) {
  const [open, setOpen] = React.useState(false)
  const fontSize = React.useSyncExternalStore(
    preferencesStore.subscribe,
    preferencesStore.getFontSizeSnapshot,
    preferencesStore.getFontSizeSnapshot
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <EditorTooltip content="File Text Size">
        <PopoverTrigger asChild>
          <Button
            variant={open ? "secondary" : "ghost"}
            size="icon"
            aria-label={`File text size, ${fontSize} pixels`}
            aria-expanded={open}
          >
            <ALargeSmall className="size-[18px]" />
          </Button>
        </PopoverTrigger>
      </EditorTooltip>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={7}
        collisionPadding={12}
        className="w-[min(13rem,calc(100vw-1rem))] p-2.5"
      >
        <EditorFontSizeControl
          fontSize={fontSize}
          onFontSizeChange={preferencesStore.setFontSize}
        />
      </PopoverContent>
    </Popover>
  )
}

function EditorFontSizeControl({
  fontSize,
  onFontSizeChange,
}: {
  fontSize: number
  onFontSizeChange: (fontSize: number) => void
}) {
  const selectedIndex = Math.max(0, fileEditorFontSizes.indexOf(fontSize))

  return (
    <div className="flex items-center gap-2.5">
      <span className="w-3 shrink-0 text-left font-mono text-[0.5625rem] text-muted-foreground">
        A
      </span>
      <div className="relative min-w-0 flex-1 py-1.5">
        <div className="pointer-events-none absolute inset-x-2 top-1/2 grid -translate-y-1/2 grid-cols-4 gap-1">
          {fileEditorFontSizes.slice(1).map((size, index) => (
            <span
              key={size}
              className={`h-1 ${index < selectedIndex ? "bg-primary/75" : "bg-muted-foreground/25"}`}
            />
          ))}
        </div>
        <input
          type="range"
          min={0}
          max={fileEditorFontSizes.length - 1}
          step={1}
          value={selectedIndex}
          aria-label="File text size"
          aria-valuetext={`${fontSize} pixels`}
          className="relative z-10 block h-5 w-full cursor-pointer appearance-none bg-transparent accent-primary [&::-moz-range-progress]:bg-transparent [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-none [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-background [&::-moz-range-thumb]:bg-primary [&::-moz-range-track]:bg-transparent [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:mt-[-6px] [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-none [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-background [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-sm"
          onChange={(event) => {
            const nextFontSize = fileEditorFontSizes[event.target.valueAsNumber]
            if (nextFontSize !== undefined) onFontSizeChange(nextFontSize)
          }}
        />
      </div>
      <span className="w-3 shrink-0 text-right font-mono text-sm leading-none text-muted-foreground">
        A
      </span>
    </div>
  )
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
        <span className="mt-0.5 block truncate font-mono text-[0.625rem] text-muted-foreground">
          /data/{entry.path}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2 pl-2 text-[0.625rem] text-muted-foreground">
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

function FilesHome({
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
                <h2 className="font-mono text-[0.625rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
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
                <h2 className="font-mono text-[0.625rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
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
      <span className="truncate pr-2 font-mono text-[0.625rem] text-muted-foreground">
        —
      </span>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          className="cursor-help truncate pr-2 font-mono text-[0.625rem] text-muted-foreground"
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

function useSortedDirectoryEntries(entries: Array<DirectoryEntry>) {
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
          : (left[sortKey] ?? -1) - (right[sortKey] ?? -1)
      return comparison === 0
        ? left.name.localeCompare(right.name, undefined, { numeric: true })
        : comparison * direction
    })
  }, [entries, sortDirection, sortKey])

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

function RootDirectoryList({
  actions,
  enabled,
  fileIndex,
  onOpen,
}: {
  actions: FileActionsController
  enabled: boolean
  fileIndex: ProgressiveFileIndex
  onOpen: (path: string) => void
}) {
  const directory = useFileDirectory(fileIndex, "", enabled)
  const entries = React.useMemo(
    () => directoryEntries(directory.entries),
    [directory.entries]
  )
  const { sortDirection, sortedEntries, sortKey, toggleSort } =
    useSortedDirectoryEntries(entries)
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
    <div className="mt-8">
      <div className="mb-2 flex min-h-8 items-center gap-2 px-1">
        <Folder className="size-3.5 text-primary" />
        <h2 className="font-mono text-[0.625rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
          Root · /data
        </h2>
        {selectedPaths.length ? (
          <span className="ml-auto font-mono text-[0.625rem] text-muted-foreground">
            {selectedPaths.length} selected
          </span>
        ) : (
          <span className="ml-auto" />
        )}
        <FileActionsDropdown controller={actions} paths={selectedPaths} />
      </div>
      <div className="overflow-hidden border border-border/75 bg-muted/[0.025]">
        <div className="grid h-9 grid-cols-[2.25rem_minmax(12rem,1fr)_7rem_11rem_2.5rem] items-center border-b border-border/75 bg-muted/10 px-2 font-mono text-[0.5625rem] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
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
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{entry.name}</span>
            </button>
            <span className="font-mono text-[0.625rem] text-muted-foreground">
              {formatFileSize(entry.size)}
            </span>
            <FileModifiedAtTime modifiedAt={entry.modifiedAt} />
            <FileActionsDropdown controller={actions} paths={[entry.path]} />
          </div>
        ))}
        {directory.loading && !hasBufferedEntries ? (
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
        {directory.error ? (
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

function DirectoryView({
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
    useSortedDirectoryEntries(entries)
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
          <StableFileToolbarIdentity path={path} directory />
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {selectedPaths.length ? (
              <span className="mr-1 hidden font-mono text-[0.625rem] text-muted-foreground sm:inline">
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
          <div className="grid h-9 grid-cols-[2.25rem_minmax(12rem,1fr)_7rem_11rem_2.5rem] items-center border-b border-border/75 bg-muted/10 px-2 font-mono text-[0.5625rem] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
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
            <span className="font-mono text-[0.625rem] text-muted-foreground">
              —
            </span>
            <span className="font-mono text-[0.625rem] text-muted-foreground">
              —
            </span>
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
                  <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{entry.name}</span>
              </button>
              <span className="font-mono text-[0.625rem] text-muted-foreground">
                {formatFileSize(entry.size)}
              </span>
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

const StableEditor = React.memo(Editor)
const StableDirectoryView = React.memo(DirectoryView)
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

interface FileViewerProps {
  actions: FileActionsController
  canShare: boolean
  canWrite: boolean
  fileTreeError: string | null
  fileTreeLoading: boolean
  fileIndex: ProgressiveFileIndex
  instance: InstanceWorkspaceInstance
  onPathChange: (path: string) => void
  onTreeExpand: () => void
  preferencesStore: FileEditorPreferencesStore
  selectionStore: FileSelectionStore
  treeCollapsed: boolean
  relayConnected: boolean
  onUploadFiles: UploadFiles
  uploading: boolean
}

function FileViewer({
  actions,
  canShare,
  canWrite,
  fileTreeError,
  fileTreeLoading,
  fileIndex,
  instance,
  onPathChange,
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
        treeCollapsed={treeCollapsed}
        onTreeExpand={onTreeExpand}
        onOpen={onPathChange}
        canWrite={canWrite}
        onUploadFiles={onUploadFiles}
        actions={actions}
      />
    )
  }

  if (selectedPathIsDirectory) {
    return (
      <StableDirectoryView
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
      <StableEditor
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

function queryErrorMessage(error: Error | null, fallback: string) {
  if (!error) return null
  return error.message || fallback
}
