import { Effect } from "effect"

import { relayFileUnarchiveSuffix } from "@workspace/contracts"
import { showToast } from "@workspace/ui/components/sonner"

import type { UploadFile } from "@/components/files/file-upload-selection"
import { droppedUploadFiles } from "@/components/files/file-upload-selection"

export const folderInputAttributes = { webkitdirectory: "" }

export function directoryPath(path: string): string {
  const normalized = path.replace(/^\/+|\/+$/gu, "")
  const segments = normalized.split("/").filter(Boolean)
  segments.pop()
  return segments.length ? `${segments.join("/")}/` : ""
}

export function normalizeDirectoryPath(path: string): string {
  const normalized = path.replace(/^\/+|\/+$/gu, "")
  return normalized ? `${normalized}/` : ""
}

export function joinFilePath(directory: string, name: string): string {
  return `${normalizeDirectoryPath(directory)}${name}`
}

export function isUnarchiveSupportedPath(path: string): boolean {
  return !path.endsWith("/") && relayFileUnarchiveSuffix(path) !== null
}

export function unarchiveDestinationPath(path: string): string {
  const suffix = relayFileUnarchiveSuffix(path)
  return suffix ? path.slice(0, -suffix.length) : path
}

export function hasDraggedFiles(event: {
  dataTransfer: DataTransfer
}): boolean {
  return Array.from(event.dataTransfer.types).includes("Files")
}

export function fileTreeParentDirectoryPaths(path: string): Array<string> {
  const parent = directoryPath(path)
  const parents: Array<string> = []
  let current = ""
  for (const segment of parent.split("/").filter(Boolean)) {
    current = `${current}${segment}/`
    parents.push(current)
  }
  return parents
}

export type UploadFiles = (
  files: ReadonlyArray<UploadFile>,
  directory: string
) => Promise<void>

export type FileWorkspaceAction =
  | "archive"
  | "delete"
  | "download"
  | "duplicate"
  | "rename"
  | "unarchive"

export interface FileActionsController {
  busy: boolean
  canWrite: boolean
  request: (action: FileWorkspaceAction, paths: ReadonlyArray<string>) => void
}

export async function uploadDroppedFiles(
  dataTransfer: DataTransfer,
  directory: string,
  onUploadFiles: UploadFiles
): Promise<void> {
  await Effect.runPromise(
    Effect.tryPromise({
      try: () => droppedUploadFiles(dataTransfer),
      catch: (cause) => cause,
    }).pipe(
      Effect.flatMap((files) => {
        if (!files.length) {
          return Effect.sync(() => {
            showToast({
              type: "error",
              message: "Folder contains no files",
              description: "Empty folders are not uploaded.",
            })
          })
        }
        return Effect.tryPromise({
          try: () => onUploadFiles(files, directory),
          catch: (cause) => cause,
        })
      }),
      Effect.catch((cause) =>
        Effect.sync(() => {
          showToast({
            type: "error",
            message: "Could not read dropped folder",
            description:
              cause instanceof Error
                ? cause.message
                : "The browser could not enumerate these files.",
          })
        })
      )
    )
  )
}
