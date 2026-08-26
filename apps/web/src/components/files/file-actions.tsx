import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { Effect } from "effect"
import type { RelayFileMutationInput } from "@workspace/contracts"
import { Check, LoaderCircle } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import { dismissToast, showToast } from "@workspace/ui/components/sonner"

import {
  directoryPath,
  isUnarchiveSupportedPath,
  joinFilePath,
  unarchiveDestinationPath,
  type FileActionsController,
  type FileWorkspaceAction,
} from "@/components/files/file-tree-utils"
import {
  deletedPathContainsSelection,
  type FileSelectionStore,
} from "@/components/files/file-workspace-stores"
import { downloadRelayArchive } from "@/lib/relay-file-transfer"
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"
import { mutateRelayFiles } from "@/server/relay"

type FileActionDialogState =
  | { kind: "archive"; paths: ReadonlyArray<string> }
  | { kind: "delete"; paths: ReadonlyArray<string> }
  | { kind: "rename"; path: string }
  | null

function formatName(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path
}

export function useFileActions({
  canWrite,
  instance,
  onRefresh,
  onPathChange,
  selectionStore,
}: {
  canWrite: boolean
  instance: InstanceWorkspaceInstance
  onRefresh: () => void
  onPathChange: (path: string) => void
  selectionStore: FileSelectionStore
}) {
  const [dialog, setDialog] = React.useState<FileActionDialogState>(null)
  const [downloadPath, setDownloadPath] = React.useState<string | null>(null)
  const [downloadPending, setDownloadPending] = React.useState(false)
  const mutation = useMutation({
    mutationFn: (input: RelayFileMutationInput) =>
      mutateRelayFiles({
        data: { ...input, instanceId: instance.id, relayId: instance.relayId },
      }),
    onSuccess: onRefresh,
  })

  const runMutation = React.useCallback(
    (input: RelayFileMutationInput, successMessage: string) => {
      const toastId = showToast({
        type: "loading",
        message: "Updating files",
        duration: Number.POSITIVE_INFINITY,
      })
      return Effect.runPromise(
        Effect.tryPromise({
          try: () => mutation.mutateAsync(input),
          catch: (cause) => cause,
        }).pipe(
          Effect.match({
            onFailure: (cause) => {
              dismissToast(toastId)
              showToast({
                type: "error",
                message: "File action failed",
                description:
                  cause instanceof Error
                    ? cause.message
                    : "The Relay could not update these files.",
              })
              return null
            },
            onSuccess: (tree) => {
              dismissToast(toastId)
              showToast({ type: "success", message: successMessage })
              return tree
            },
          })
        )
      )
    },
    [mutation]
  )

  const archive = React.useCallback(
    async (paths: ReadonlyArray<string>, requestedName: string) => {
      const name = requestedName.trim().endsWith(".zip")
        ? requestedName.trim()
        : `${requestedName.trim()}.zip`
      if (!name || name.includes("/") || name.includes("\\")) {
        showToast({
          type: "error",
          message: "Enter a valid archive name",
          description: "Archive names cannot contain slashes.",
        })
        return false
      }
      const destination = joinFilePath(directoryPath(paths[0] ?? ""), name)
      const result = await runMutation(
        { operation: "archive", paths: [...paths], destination },
        "Archive created"
      )
      return Boolean(result)
    },
    [runMutation]
  )

  const downloadArchive = React.useCallback(
    async (paths: ReadonlyArray<string>, requestedName: string) => {
      const toastId = showToast({
        type: "loading",
        message: "Preparing download",
        duration: Number.POSITIVE_INFINITY,
      })
      setDownloadPending(true)
      await Effect.runPromise(
        Effect.tryPromise({
          try: () =>
            downloadRelayArchive({
              instanceId: instance.id,
              name: requestedName.endsWith(".zip")
                ? requestedName
                : `${requestedName}.zip`,
              paths,
              relayId: instance.relayId,
            }),
          catch: (cause) => cause,
        }).pipe(
          Effect.match({
            onFailure: (cause) => {
              dismissToast(toastId)
              showToast({
                type: "error",
                message: "Download failed",
                description:
                  cause instanceof Error
                    ? cause.message
                    : "The Relay could not prepare this download.",
              })
            },
            onSuccess: () => {
              dismissToast(toastId)
              showToast({ type: "success", message: "Download started" })
            },
          }),
          Effect.ensuring(Effect.sync(() => setDownloadPending(false)))
        )
      )
    },
    [instance.id, instance.relayId]
  )

  const request = React.useCallback(
    (action: FileWorkspaceAction, paths: ReadonlyArray<string>) => {
      if (!paths.length) return
      if (action === "download") {
        if (paths.length === 1 && !paths[0]?.endsWith("/")) {
          setDownloadPath(paths[0] ?? null)
          return
        }
        const first = paths[0] ?? "files"
        const defaultName =
          paths.length === 1 ? formatName(first) : "selected-files"
        void downloadArchive(paths, defaultName)
        return
      }
      if (!canWrite) return
      if (action === "rename" && paths.length === 1) {
        setDialog({ kind: "rename", path: paths[0] ?? "" })
        return
      }
      if (action === "archive") {
        setDialog({ kind: "archive", paths })
        return
      }
      if (
        action === "unarchive" &&
        paths.length === 1 &&
        isUnarchiveSupportedPath(paths[0] ?? "")
      ) {
        const path = paths[0] ?? ""
        void runMutation(
          {
            operation: "unarchive",
            path,
            destination: unarchiveDestinationPath(path),
          },
          "Archive unarchived"
        )
        return
      }
      if (action === "delete") {
        setDialog({ kind: "delete", paths })
        return
      }
      if (action === "duplicate") {
        void runMutation(
          { operation: "duplicate", paths: [...paths] },
          paths.length === 1
            ? "Item duplicated"
            : `${paths.length} items duplicated`
        )
      }
    },
    [canWrite, downloadArchive, runMutation]
  )

  async function submitDialog(value?: string) {
    if (!dialog) return
    if (dialog.kind === "delete") {
      const result = await runMutation(
        { operation: "delete", paths: [...dialog.paths] },
        dialog.paths.length === 1
          ? "Item deleted"
          : `${dialog.paths.length} items deleted`
      )
      if (result) {
        const selectedPath = selectionStore.getSnapshot()
        if (
          dialog.paths.some((path) =>
            deletedPathContainsSelection(path, selectedPath)
          )
        ) {
          onPathChange(directoryPath(dialog.paths[0] ?? ""))
        }
        setDialog(null)
      }
      return
    }
    if (dialog.kind === "rename") {
      const name = value?.trim() ?? ""
      if (!name || name.includes("/") || name.includes("\\")) return
      const wasDirectory = dialog.path.endsWith("/")
      const destination = joinFilePath(directoryPath(dialog.path), name)
      const result = await runMutation(
        { operation: "rename", path: dialog.path, destination },
        "Item renamed"
      )
      if (result) {
        if (selectionStore.getSnapshot() === dialog.path) {
          onPathChange(wasDirectory ? `${destination}/` : destination)
        }
        setDialog(null)
      }
      return
    }
    const created = await archive(dialog.paths, value?.trim() || "archive")
    if (created) setDialog(null)
  }

  return {
    controller: {
      busy: mutation.isPending || downloadPending,
      canWrite,
      request,
    } satisfies FileActionsController,
    dialog,
    downloadPath,
    setDialog,
    setDownloadPath,
    submitDialog,
  }
}

export function FileActionDialogHost({
  dialog,
  busy,
  onOpenChange,
  onSubmit,
}: {
  dialog: FileActionDialogState
  busy: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (value?: string) => Promise<void>
}) {
  const initialValue =
    dialog?.kind === "rename"
      ? formatName(dialog.path)
      : dialog?.kind === "archive"
        ? dialog.paths.length === 1
          ? `${formatName(dialog.paths[0] ?? "archive")}.zip`
          : "selected-files.zip"
        : ""
  const [value, setValue] = React.useState(initialValue)
  if (!dialog) return null
  const title =
    dialog.kind === "rename"
      ? "Rename item"
      : dialog.kind === "archive"
        ? "Create archive"
        : `Delete ${dialog.paths.length === 1 ? "item" : `${dialog.paths.length} items`}?`

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {dialog.kind === "delete"
              ? "This permanently removes the selected files from the server."
              : dialog.kind === "archive"
                ? "The ZIP archive will be created in the current directory."
                : `Choose a new name for ${formatName(dialog.path)}.`}
          </DialogDescription>
        </DialogHeader>
        {dialog.kind !== "delete" ? (
          <Input
            autoFocus
            value={value}
            aria-label={dialog.kind === "rename" ? "New name" : "Archive name"}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && value.trim()) {
                event.preventDefault()
                void onSubmit(value)
              }
            }}
          />
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            variant={dialog.kind === "delete" ? "destructive" : "default"}
            disabled={busy || (dialog.kind !== "delete" && !value.trim())}
            onClick={() => void onSubmit(value)}
          >
            {busy ? <LoaderCircle className="animate-spin" /> : null}
            {dialog.kind === "delete"
              ? "Delete"
              : dialog.kind === "archive"
                ? "Create archive"
                : "Rename"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function FileActionMenuItem({
  active = false,
  icon,
  label,
  detail,
  disabled = false,
  onClick,
}: {
  active?: boolean
  icon: React.ReactNode
  label: string
  detail: string
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      className="group flex w-full items-center gap-2.5 border-t border-border/45 px-2 py-2 text-left transition-colors first:border-t-0 hover:bg-popover-accent/75 focus-visible:bg-popover-accent focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40"
      disabled={disabled}
      onClick={onClick}
    >
      <span
        className={`grid size-7 shrink-0 place-items-center border transition-colors [&_svg]:size-3.5 ${active ? "border-primary/30 bg-primary/12 text-primary" : "border-border/60 bg-muted/20 text-muted-foreground group-hover:text-foreground"}`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium text-foreground">
          {label}
        </span>
        <span className="type-meta block truncate text-muted-foreground">
          {detail}
        </span>
      </span>
      {active ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
    </button>
  )
}
