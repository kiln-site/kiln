import * as React from "react"
import { Effect } from "effect"
import { Upload } from "lucide-react"

import { Progress } from "@workspace/ui/components/progress"
import { dismissToast, showToast } from "@workspace/ui/components/sonner"

import {
  maxFolderUploadFiles,
  type UploadFile,
} from "@/components/files/file-upload-selection"
import {
  hasDraggedFiles,
  joinFilePath,
  normalizeDirectoryPath,
  uploadDroppedFiles,
} from "@/components/files/file-tree-utils"
import type { InstanceWorkspaceInstance } from "@/lib/relay-selectors"
import { uploadRelayFile } from "@/lib/relay-file-transfer"

export type UploadFiles = (
  files: ReadonlyArray<UploadFile>,
  directory: string
) => Promise<void>

function UploadProgressDescription({
  completed,
  total,
  directory,
}: {
  completed: number
  total: number
  directory: string
}) {
  const progress = total ? Math.round((completed / total) * 100) : 0
  return (
    <div className="mt-1.5 space-y-2">
      <div className="flex items-center justify-between gap-4 font-mono text-[0.625rem] text-muted-foreground">
        <span className="truncate">
          /data/{normalizeDirectoryPath(directory)}
        </span>
        <span className="shrink-0">
          {completed}/{total}
        </span>
      </div>
      <Progress value={progress} aria-label={`Upload ${progress}% complete`} />
    </div>
  )
}

export function useFileUploadAction({
  canWrite,
  instance,
  onRefresh,
}: {
  canWrite: boolean
  instance: InstanceWorkspaceInstance
  onRefresh: () => void
}): { uploadFiles: UploadFiles; uploading: boolean } {
  const [uploading, setUploading] = React.useState(false)

  const uploadFiles = React.useCallback<UploadFiles>(
    async (files, directory) => {
      if (!files.length || !canWrite) return
      if (files.length > maxFolderUploadFiles) {
        showToast({
          type: "error",
          message: "Too many files selected",
          description: `Upload at most ${maxFolderUploadFiles.toLocaleString()} files at a time.`,
        })
        return
      }
      setUploading(true)
      let completed = 0
      let uploaded = 0
      const toastId = showToast({
        type: "loading",
        message:
          files.length === 1
            ? "Uploading file"
            : `Uploading ${files.length} files`,
        description: (
          <UploadProgressDescription
            completed={completed}
            total={files.length}
            directory={directory}
          />
        ),
        duration: Number.POSITIVE_INFINITY,
      })

      await Effect.runPromise(
        Effect.forEach(
          files,
          (upload) =>
            Effect.tryPromise({
              try: () =>
                uploadRelayFile({
                  file: upload.file,
                  instanceId: instance.id,
                  path: joinFilePath(directory, upload.path),
                  relayId: instance.relayId,
                }),
              catch: (cause) => cause,
            }).pipe(
              Effect.match({
                onFailure: (cause) => ({ cause, uploaded: false as const }),
                onSuccess: () => ({ cause: null, uploaded: true as const }),
              }),
              Effect.tap((result) =>
                Effect.sync(() => {
                  completed += 1
                  if (result.uploaded) uploaded += 1
                  showToast({
                    id: toastId,
                    type: "loading",
                    message:
                      files.length === 1
                        ? "Uploading file"
                        : `Uploading ${files.length} files`,
                    description: (
                      <UploadProgressDescription
                        completed={completed}
                        total={files.length}
                        directory={directory}
                      />
                    ),
                    duration: Number.POSITIVE_INFINITY,
                  })
                })
              )
            ),
          { concurrency: 3 }
        ).pipe(
          Effect.tap((results) =>
            Effect.sync(() => {
              dismissToast(toastId)
              const failed = results.find((result) => !result.uploaded)
              showToast({
                type: failed ? "error" : "success",
                message: failed
                  ? uploaded
                    ? `${uploaded} of ${files.length} files uploaded`
                    : "Upload failed"
                  : uploaded === 1
                    ? "File uploaded"
                    : `${uploaded} files uploaded`,
                description: failed
                  ? failed.cause instanceof Error
                    ? failed.cause.message
                    : "The Relay could not complete every upload."
                  : `Added to /data/${normalizeDirectoryPath(directory)}`,
              })
              if (uploaded) onRefresh()
            })
          ),
          Effect.ensuring(Effect.sync(() => setUploading(false)))
        )
      )
    },
    [canWrite, instance.id, instance.relayId, onRefresh]
  )

  return { uploadFiles, uploading }
}

export function useFileDropTarget({
  directory,
  enabled,
  onUploadFiles,
  ref,
}: {
  directory: string
  enabled: boolean
  onUploadFiles: UploadFiles
  ref: React.RefObject<HTMLElement | null>
}) {
  const dragDepth = React.useRef(0)

  const setActive = React.useCallback(
    (active: boolean) => {
      if (ref.current) ref.current.dataset.fileDropActive = String(active)
    },
    [ref]
  )

  return {
    onDragEnter(event: React.DragEvent) {
      if (!enabled || !hasDraggedFiles(event)) return
      event.preventDefault()
      dragDepth.current += 1
      setActive(true)
    },
    onDragOver(event: React.DragEvent) {
      if (!enabled || !hasDraggedFiles(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = "copy"
      setActive(true)
    },
    onDragLeave(event: React.DragEvent) {
      if (!enabled || !hasDraggedFiles(event)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setActive(false)
    },
    onDrop(event: React.DragEvent) {
      if (!enabled || !hasDraggedFiles(event)) return
      event.preventDefault()
      dragDepth.current = 0
      setActive(false)
      void uploadDroppedFiles(event.dataTransfer, directory, onUploadFiles)
    },
  }
}

export function FileDropOverlay({ directory }: { directory: string }) {
  return (
    <div className="pointer-events-none absolute inset-2 z-50 hidden place-items-center border border-primary/55 bg-card/88 shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--primary),transparent_75%)] backdrop-blur-sm group-data-[file-drop-active=true]/drop:grid">
      <div className="text-center">
        <div className="mx-auto grid size-10 place-items-center border border-primary/35 bg-primary/10 text-primary">
          <Upload className="size-5" />
        </div>
        <p className="mt-3 text-sm font-semibold">Drop files to upload</p>
        <p className="mt-1 font-mono text-[0.625rem] text-muted-foreground">
          /data/{normalizeDirectoryPath(directory)}
        </p>
      </div>
    </div>
  )
}
