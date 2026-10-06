import { Result } from "effect"

export type FileArchiveFormat = "gzip" | "zip"

export interface FileDownloadPreferences {
  archiveFormat: FileArchiveFormat
  compressByDefault: boolean
  confirmBeforeDownload: boolean
  previewBackupDownloads: boolean
}

const defaultFileDownloadPreferences: FileDownloadPreferences = {
  archiveFormat: "zip",
  compressByDefault: true,
  confirmBeforeDownload: true,
  previewBackupDownloads: true,
}

const storageKey = "kiln:file-download-preferences:v1"
const preferencesChangedEvent = "kiln:file-download-preferences:changed"
const defaultPreferencesSnapshot = JSON.stringify(
  defaultFileDownloadPreferences
)

export function readFileDownloadPreferences(): FileDownloadPreferences {
  if (typeof window === "undefined") return defaultFileDownloadPreferences
  return Result.getOrElse(
    Result.try(() => {
      const stored = window.localStorage.getItem(storageKey)
      return normalizeFileDownloadPreferences(
        stored === null ? null : JSON.parse(stored)
      )
    }),
    () => defaultFileDownloadPreferences
  )
}

export function writeFileDownloadPreferences(
  update: Partial<FileDownloadPreferences>
): FileDownloadPreferences {
  const preferences = normalizeFileDownloadPreferences({
    ...readFileDownloadPreferences(),
    ...update,
  })
  if (typeof window === "undefined") return preferences
  Result.try(() => {
    window.localStorage.setItem(storageKey, JSON.stringify(preferences))
    window.dispatchEvent(new Event(preferencesChangedEvent))
  })
  return preferences
}

export function readFileDownloadPreferencesSnapshot(): string {
  return JSON.stringify(readFileDownloadPreferences())
}

export function defaultFileDownloadPreferencesSnapshot(): string {
  return defaultPreferencesSnapshot
}

export function shouldPreviewBackupDownload(
  mode: "download" | "link",
  previewSharedLinks: boolean
): boolean {
  return mode === "link" && previewSharedLinks
}

export function fileDownloadPreferencesFromSnapshot(
  snapshot: string
): FileDownloadPreferences {
  return Result.getOrElse(
    Result.try(() => normalizeFileDownloadPreferences(JSON.parse(snapshot))),
    () => defaultFileDownloadPreferences
  )
}

export function subscribeFileDownloadPreferences(
  listener: () => void
): () => void {
  if (typeof window === "undefined") return () => undefined
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey) listener()
  }
  window.addEventListener(preferencesChangedEvent, listener)
  window.addEventListener("storage", onStorage)
  return () => {
    window.removeEventListener(preferencesChangedEvent, listener)
    window.removeEventListener("storage", onStorage)
  }
}

function normalizeFileDownloadPreferences(
  value: unknown
): FileDownloadPreferences {
  if (!value || typeof value !== "object") {
    return defaultFileDownloadPreferences
  }
  return {
    archiveFormat:
      "archiveFormat" in value && value.archiveFormat === "gzip"
        ? "gzip"
        : "zip",
    compressByDefault:
      "compressByDefault" in value &&
      typeof value.compressByDefault === "boolean"
        ? value.compressByDefault
        : defaultFileDownloadPreferences.compressByDefault,
    confirmBeforeDownload:
      "confirmBeforeDownload" in value &&
      typeof value.confirmBeforeDownload === "boolean"
        ? value.confirmBeforeDownload
        : defaultFileDownloadPreferences.confirmBeforeDownload,
    previewBackupDownloads:
      "previewBackupDownloads" in value &&
      typeof value.previewBackupDownloads === "boolean"
        ? value.previewBackupDownloads
        : defaultFileDownloadPreferences.previewBackupDownloads,
  }
}

export function fileDownloadName(
  name: string,
  compressed: boolean,
  archiveFormat: FileArchiveFormat
): string {
  if (!compressed) return name
  return `${name}${fileDownloadArchiveSuffix(archiveFormat)}`
}

export function fileDownloadArchiveSuffix(
  archiveFormat: FileArchiveFormat
): ".gz" | ".zip" {
  return archiveFormat === "zip" ? ".zip" : ".gz"
}
