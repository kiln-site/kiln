import * as React from "react"
import type { RelayFileContent } from "@workspace/contracts"
import { LoaderCircle, RefreshCw, Save, TriangleAlert } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { PopoverAnchor } from "@workspace/ui/components/popover"

import type { SyntaxCodeEditorHandle } from "@/components/syntax-code-editor"
import { FileWorkspaceLoadingState } from "@/components/file-tree-loading-panel"
import {
  type SaveFileRevision,
  canSaveEditor,
  runEditorSave,
  saveEditorChanges,
  useFileSaveAction,
} from "@/components/files/file-editor-save"
import { EditorSearchBoundary } from "@/components/files/file-editor-search"
import { EditorResponsiveActions } from "@/components/files/file-editor-toolbar"
import { directoryPath } from "@/components/files/file-tree-utils"
import {
  createEditorSearchStore,
  createEditorSessionStore,
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
  fileEditorHeaderClassName,
  fileEditorHeaderContentClassName,
  FileToolbarIdentity,
  FileTreeRevealButton,
} from "@/components/files/file-viewer-toolbar"
import { fileLanguageForPath } from "@/lib/file-language"
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"
import { loadSyntaxCodeEditorModule } from "@/lib/syntax-editor-module-preload"
const SyntaxCodeEditor = React.lazy(async () => {
  const module = await loadSyntaxCodeEditorModule()
  return { default: module.SyntaxCodeEditor }
})

function formatName(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path
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

export const FileEditor = React.memo(Editor)
