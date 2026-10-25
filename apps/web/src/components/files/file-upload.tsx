import { useFileRootPath } from "@/components/files/file-root-context"
import * as React from "react"
import { useMutation } from "@tanstack/react-query"
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
import type { FileWorkspaceInstance } from "@/lib/relay-selectors"
import { runBrowserEffect } from "@/lib/browser-telemetry"
import {
  uploadRelayFilesEffect,
  type RelayUploadItem,
} from "@/lib/relay-file-transfer"

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
  instance: FileWorkspaceInstance
  onRefresh: () => void
}): { uploadFiles: UploadFiles; uploading: boolean } {
  const rootPath = useFileRootPath()
  const mutation = useMutation({
    mutationFn: async ({
      files,
      directory,
    }: {
      files: ReadonlyArray<UploadFile>
      directory: string
    }) => {
      if (!files.length || !canWrite) return
      if (files.length > maxFolderUploadFiles) {
        showToast({
          type: "error",
          message: "Too many files selected",
          description: `Upload at most ${maxFolderUploadFiles.toLocaleString()} files at a time.`,
        })
        return
      }
      let completed = 0
      let uploaded = 0
      let failedCount = 0
      let uploadedBytes = 0
      const items = files.map((upload) => ({
        file: upload.file,
        path: joinFilePath(directory, upload.path),
      }))
      const uploads = new Map(items.map((item, index) => [item, files[index]!]))
      const totalBytes = files.reduce(
        (total, upload) => total + Math.max(upload.file.size, 1),
        0
      )
      // The files being sent and how much of each has gone.
      const active = new Map<RelayUploadItem, number>()
      let toastId: number | string | undefined
      let progressTimer: ReturnType<typeof setTimeout> | undefined

      function updateToast() {
        clearTimeout(progressTimer)
        progressTimer = undefined
        const [currentItem, loaded = 0] = active.entries().next().value ?? []
        const upload = currentItem ? uploads.get(currentItem) : files[completed]
        if (!upload) return
        const fileProgress = upload.file.size
          ? Math.floor((loaded / upload.file.size) * 100)
          : 0
        const totalProgress = Math.min(
          99,
          Math.floor((uploadedBytes / totalBytes) * 100)
        )
        toastId = showToast({
          id: toastId,
          type: "loading",
          closeButton: false,
          dismissible: false,
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
            <div className="flex items-center justify-between gap-3">
              <span
                className="min-w-0 truncate"
                title={joinFilePath(directory, upload.path)}
              >
                {upload.file.name}
              </span>
              {failedCount > 0 && (
                <span className="shrink-0 text-destructive">
                  {failedCount} failed
                </span>
              )}
            </div>
          ),
          icon: (
            <UploadProgressIcon
              fileName={upload.file.name}
              progress={fileProgress}
            />
          ),
          duration: Number.POSITIVE_INFINITY,
        })
      }
      updateToast()

      const outcomes = await runBrowserEffect(
        uploadRelayFilesEffect({
          instanceId: instance.id,
          items,
          relayId: instance.relayId,
          onStart: (item) => {
            active.set(item, 0)
            updateToast()
          },
          onProgress: (item, loaded) => {
            const previous = active.get(item)
            if (previous === undefined) return
            uploadedBytes += loaded - previous
            active.set(item, loaded)
            // Keep progress updates inside Sonner and cap them at 10 per second.
            progressTimer ??= setTimeout(updateToast, 100)
          },
          onSettled: ({ cause, item }) => {
            const loaded = active.get(item) ?? 0
            completed += 1
            if (cause) {
              failedCount += 1
              uploadedBytes -= loaded
            } else {
              uploaded += 1
              uploadedBytes += Math.max(item.file.size, 1) - loaded
            }
            active.delete(item)
            if (completed < files.length) updateToast()
          },
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              clearTimeout(progressTimer)
              dismissToast(toastId)
            })
          )
        )
      )
      const failed = outcomes.find((outcome) => outcome.cause)?.cause
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
          ? failed.message
          : `Added to ${rootPath}/${normalizeDirectoryPath(directory)}`,
      })
      if (uploaded) onRefresh()
    },
  })
  const uploadFiles = React.useCallback<UploadFiles>(
    (files, directory) => mutation.mutateAsync({ files, directory }),
    [mutation.mutateAsync]
  )
  return { uploadFiles, uploading: mutation.isPending }
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
  const rootPath = useFileRootPath()
  return (
    <div className="pointer-events-none absolute inset-2 z-50 hidden place-items-center border border-primary/55 bg-card/88 shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--primary),transparent_75%)] backdrop-blur-sm group-data-[file-drop-active=true]/drop:grid">
      <div className="text-center">
        <div className="mx-auto grid size-10 place-items-center border border-primary/35 bg-primary/10 text-primary-ink">
          <Upload className="size-5" />
        </div>
        <p className="mt-3 text-sm font-semibold">Drop files to upload</p>
        <p className="type-code mt-1 text-muted-foreground">
          {rootPath}/{normalizeDirectoryPath(directory)}
        </p>
      </div>
    </div>
  )
}
