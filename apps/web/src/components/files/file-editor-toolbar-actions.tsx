import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { RelayFileActivity, RelayFileContent } from "@workspace/contracts"
import {
  ALargeSmall,
  Check,
  Copy,
  Download,
  EllipsisVertical,
  GitCompareArrows,
  LoaderCircle,
  LockKeyhole,
  Pin,
  PinOff,
  Save,
  Share2,
  TriangleAlert,
  WrapText,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"

import { FileActionMenuItem } from "@/components/files/file-actions"
import { FileDownloadDialog } from "@/components/files/file-download-dialog"
import {
  type SaveFileRevision,
  isSnbtFile,
  saveEditorChanges,
} from "@/components/files/file-editor-save"
import { EditorTooltip } from "@/components/files/editor-tooltip"
import {
  mclogsShareLabel,
  mclogsShareTooltip,
  useMclogsShareAction,
} from "@/components/use-mclogs-share-action"
import { WorkspaceLineWrapButton } from "@/components/workspace-line-wrap-button"
import {
  type EditorSessionStore,
  fileEditorFontSizes,
  type FileEditorPreferencesStore,
} from "@/components/files/file-workspace-stores"
import { copyToClipboard } from "@/components/files/file-viewer-toolbar"
import { queryKeys, relayFileActivityQueryOptions } from "@/lib/query-options"
import { redactSensitiveText } from "@/lib/redaction"
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"
import { updateRelayFilePin, uploadToMclogs } from "@/server/relay"

function formatName(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path
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
  return useMclogsShareAction(async () => {
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
  })
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
    <EditorTooltip content={mclogsShareTooltip(state)}>
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
        <span>{mclogsShareLabel(state)}</span>
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
      <WorkspaceLineWrapButton
        wrapLines={wrapLines}
        ariaLabel={wrapLines ? "Disable line wrap" : "Enable line wrap"}
        iconClassName="size-[17px]"
        onToggle={sessionStore.toggleWrapLines}
      />
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

function EditorForceSaveMenuItem({
  canWrite,
  file,
  loading,
  sessionStore,
  onSelect,
}: {
  canWrite: boolean
  file: RelayFileContent
  loading: boolean
  sessionStore: EditorSessionStore
  onSelect: () => void
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
  return (
    <FileActionMenuItem
      icon={<TriangleAlert />}
      label="Force save"
      detail="Bypass SNBT validation"
      disabled={
        !canWrite || file.readOnly || loading || !dirty || conflicted || saving
      }
      onClick={onSelect}
    />
  )
}

function ForceSaveDialog({
  canWrite,
  file,
  loading,
  open,
  saveFile,
  sessionStore,
  onOpenChange,
}: {
  canWrite: boolean
  file: RelayFileContent
  loading: boolean
  open: boolean
  saveFile: SaveFileRevision
  sessionStore: EditorSessionStore
  onOpenChange: (open: boolean) => void
}) {
  function handleForceSave() {
    onOpenChange(false)
    void saveEditorChanges(
      {
        canWrite,
        file,
        fileReadOnly: file.readOnly,
        loading,
        saveFile,
        sessionStore,
      },
      { force: true }
    )
  }

  const binary = !file.path.toLowerCase().endsWith(".snbt")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Force save invalid SNBT?</DialogTitle>
          <DialogDescription>
            {binary
              ? "If this cannot be encoded as NBT, Kiln will replace the binary file with your SNBT text. Minecraft may not load it until you repair and save it again."
              : "Kiln will write your changes even if the SNBT is invalid. Minecraft may not load this file until it is repaired."}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border border-destructive/25 bg-destructive/8 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          A normal save is safer and preserves the file&apos;s binary format.
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleForceSave}>
            Force save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EditorOverflowMenu({
  canWrite,
  file,
  filePath,
  fileReadOnly,
  instance,
  loading,
  saveFile,
  sessionStore,
}: {
  canWrite: boolean
  file: RelayFileContent
  filePath: string
  fileReadOnly: boolean
  instance: InstanceWorkspaceInstance
  loading: boolean
  saveFile: SaveFileRevision
  sessionStore: EditorSessionStore
}) {
  const [open, setOpen] = React.useState(false)
  const [forceSaveOpen, setForceSaveOpen] = React.useState(false)
  return (
    <>
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
          <p className="type-technical-label border-b px-2 py-2 text-muted-foreground">
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
          {isSnbtFile(file) ? (
            <EditorForceSaveMenuItem
              canWrite={canWrite}
              file={file}
              loading={loading}
              sessionStore={sessionStore}
              onSelect={() => {
                setOpen(false)
                setForceSaveOpen(true)
              }}
            />
          ) : null}
          <EditorDownloadActionMenuItem
            instance={instance}
            loading={loading}
            path={filePath}
          />
        </PopoverContent>
      </Popover>
      <ForceSaveDialog
        canWrite={canWrite}
        file={file}
        loading={loading}
        open={forceSaveOpen}
        saveFile={saveFile}
        sessionStore={sessionStore}
        onOpenChange={setForceSaveOpen}
      />
    </>
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
        <span className="type-code text-muted-foreground">{fontSize}px</span>
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

export function EditorDownloadButton({
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
  file,
  filePath,
  fileReadOnly,
  instance,
  loading,
  preferencesStore,
  saveFile,
  sessionStore,
}: {
  canShare: boolean
  canWrite: boolean
  file: RelayFileContent
  filePath: string
  fileReadOnly: boolean
  instance: InstanceWorkspaceInstance
  loading: boolean
  preferencesStore: FileEditorPreferencesStore
  saveFile: SaveFileRevision
  sessionStore: EditorSessionStore
}) {
  const [open, setOpen] = React.useState(false)
  const [forceSaveOpen, setForceSaveOpen] = React.useState(false)

  return (
    <>
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
          <p className="type-technical-label px-2 pt-1 pb-1.5 text-muted-foreground">
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
          {isSnbtFile(file) ? (
            <EditorForceSaveMenuItem
              canWrite={canWrite}
              file={file}
              loading={loading}
              sessionStore={sessionStore}
              onSelect={() => {
                setOpen(false)
                setForceSaveOpen(true)
              }}
            />
          ) : null}
          <EditorDownloadActionMenuItem
            instance={instance}
            loading={loading}
            path={filePath}
          />
        </PopoverContent>
      </Popover>
      <ForceSaveDialog
        canWrite={canWrite}
        file={file}
        loading={loading}
        open={forceSaveOpen}
        saveFile={saveFile}
        sessionStore={sessionStore}
        onOpenChange={setForceSaveOpen}
      />
    </>
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

export function EditorSaveButton({
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
      file,
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
      <span className="type-meta w-3 shrink-0 text-left font-mono text-muted-foreground">
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

function queryErrorMessage(error: Error | null, fallback: string) {
  if (!error) return null
  return error.message || fallback
}

export const StableEditorShareButton = React.memo(EditorShareButton)
export const StableEditorFontSizeButton = React.memo(EditorFontSizeButton)
export const StableEditorWrapButton = React.memo(EditorWrapButton)
export const StableEditorCopyButton = React.memo(EditorCopyButton)
export const StableEditorOverflowMenu = React.memo(EditorOverflowMenu)
export const StableEditorMobileOverflowMenu = React.memo(
  EditorMobileOverflowMenu
)
