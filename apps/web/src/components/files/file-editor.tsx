import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Effect } from "effect"
import type { RelayFileActivity, RelayFileContent } from "@workspace/contracts"
import {
  ALargeSmall,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  EllipsisVertical,
  GitCompareArrows,
  LoaderCircle,
  LockKeyhole,
  Pin,
  PinOff,
  RefreshCw,
  Save,
  Search,
  Share2,
  TriangleAlert,
  WrapText,
  X,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { useIsMobile } from "@workspace/ui/hooks/use-mobile"
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"

import type { SyntaxCodeEditorHandle } from "@/components/syntax-code-editor"
import { FileWorkspaceLoadingState } from "@/components/file-tree-loading-panel"
import { FileActionMenuItem } from "@/components/files/file-actions"
import { FileDownloadDialog } from "@/components/files/file-download-dialog"
import { EditorTooltip } from "@/components/files/editor-tooltip"
import { directoryPath } from "@/components/files/file-tree-utils"
import {
  createEditorSearchStore,
  createEditorSessionStore,
  fileEditorFontSizes,
  type EditorSearchStore,
  type EditorSessionStore,
  type FileEditorPreferencesStore,
} from "@/components/files/file-workspace-stores"
import {
  FileDropOverlay,
  type UploadFiles,
  useFileDropTarget,
} from "@/components/files/file-upload"
import {
  copyToClipboard,
  fileEditorHeaderClassName,
  fileEditorHeaderContentClassName,
  FileToolbarIdentity,
  FileTreeRevealButton,
} from "@/components/files/file-viewer-toolbar"
import { fileLanguageForPath } from "@/lib/file-language"
import { loadSyntaxCodeEditorModule } from "@/lib/syntax-editor-module-preload"
import { redactSensitiveText } from "@/lib/redaction"
import { queryKeys, relayFileActivityQueryOptions } from "@/lib/query-options"
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"
import {
  saveRelayFile,
  updateRelayFilePin,
  uploadToMclogs,
} from "@/server/relay"

const SyntaxCodeEditor = React.lazy(async () => {
  const module = await loadSyntaxCodeEditorModule()
  return { default: module.SyntaxCodeEditor }
})

function formatName(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path
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
              <FileToolbarIdentity
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

export const FileEditor = React.memo(Editor)

function queryErrorMessage(error: Error | null, fallback: string) {
  if (!error) return null
  return error.message || fallback
}
