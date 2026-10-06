import * as React from "react"
import { Effect } from "effect"
import { Upload } from "lucide-react"

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

function UploadProgressIcon({
  fileName,
  progress,
}: {
  fileName: string
  progress: number
}) {
  return (
    <svg
      className="size-6 -rotate-90"
      viewBox="0 0 24 24"
      fill="none"
      role="progressbar"
      aria-label={`Uploading ${fileName}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress}
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="2"
        opacity="0.2"
      />
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        pathLength="100"
        strokeDasharray={`${progress} 100`}
      />
    </svg>
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
      let uploadedBytes = 0
      const totalBytes = files.reduce(
        (total, upload) => total + Math.max(upload.file.size, 1),
        0
      )
      const active = new Map<number, { upload: UploadFile; loaded: number }>()
      let toastId: number | string | undefined
      let progressTimer: ReturnType<typeof setTimeout> | undefined

      function updateToast() {
        clearTimeout(progressTimer)
        progressTimer = undefined
        const current = active.values().next().value
        const upload = current?.upload ?? files[completed]
        if (!upload) return
        const fileProgress = upload.file.size
          ? Math.floor(((current?.loaded ?? 0) / upload.file.size) * 100)
          : 0
        const totalProgress = Math.min(
          99,
          Math.floor((uploadedBytes / totalBytes) * 100)
        )
        toastId = showToast({
          id: toastId,
          type: "loading",
          className: "file-upload-toast",
          message: (
            <div className="flex items-center justify-between gap-3 tabular-nums">
              <span>
                Uploading{" "}
                <span className="text-muted-foreground">
                  {uploaded}/{files.length}
                </span>
              </span>
              <span className="shrink-0">{totalProgress}%</span>
            </div>
          ),
          description: (
            <div
              className="truncate"
              title={joinFilePath(directory, upload.path)}
            >
              {upload.path}
            </div>
          ),
          icon: (
            <UploadProgressIcon
              fileName={upload.path}
              progress={fileProgress}
            />
          ),
          duration: Number.POSITIVE_INFINITY,
        })
      }
      updateToast()

      await Effect.runPromise(
        Effect.forEach(
          files,
          (upload, index) =>
            Effect.gen(function* () {
              const current = { upload, loaded: 0 }
              active.set(index, current)
              updateToast()
              const result = yield* Effect.tryPromise({
                try: () =>
                  uploadRelayFile({
                    file: upload.file,
                    instanceId: instance.id,
                    path: joinFilePath(directory, upload.path),
                    relayId: instance.relayId,
                    onProgress: (loaded) => {
                      uploadedBytes += loaded - current.loaded
                      current.loaded = loaded
                      // Keep progress updates inside Sonner and cap them at 10 per second.
                      progressTimer ??= setTimeout(updateToast, 100)
                    },
                  }),
                catch: (cause) => cause,
              }).pipe(
                Effect.match({
                  onFailure: (cause) => ({ cause, uploaded: false as const }),
                  onSuccess: () => ({ cause: null, uploaded: true as const }),
                })
              )
              completed += 1
              if (result.uploaded) {
                uploaded += 1
                uploadedBytes += Math.max(upload.file.size, 1) - current.loaded
              }
              active.delete(index)
              if (completed < files.length) updateToast()
              return result
            }),
          { concurrency: 3 }
        ).pipe(
          Effect.tap((results) =>
            Effect.sync(() => {
              clearTimeout(progressTimer)
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
          Effect.ensuring(
            Effect.sync(() => {
              clearTimeout(progressTimer)
              dismissToast(toastId)
              setUploading(false)
            })
          )
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
        <p className="type-code mt-1 text-muted-foreground">
          /data/{normalizeDirectoryPath(directory)}
        </p>
      </div>
    </div>
  )
}
