import * as React from "react"
import { Archive, Check, FileArchive } from "lucide-react"

import { Switch } from "@workspace/ui/components/switch"
import { cn } from "@workspace/ui/lib/utils"

import {
  defaultFileDownloadPreferencesSnapshot,
  fileDownloadPreferencesFromSnapshot,
  readFileDownloadPreferencesSnapshot,
  subscribeFileDownloadPreferences,
  writeFileDownloadPreferences,
} from "@/lib/file-download-preferences"
import type {
  FileArchiveFormat,
  FileDownloadPreferences,
} from "@/lib/file-download-preferences"

export const FilesSettingsPage = React.memo(function FilesSettingsPage() {
  const preferencesSnapshot = React.useSyncExternalStore(
    subscribeFileDownloadPreferences,
    readFileDownloadPreferencesSnapshot,
    defaultFileDownloadPreferencesSnapshot
  )
  const preferences = React.useMemo(
    () => fileDownloadPreferencesFromSnapshot(preferencesSnapshot),
    [preferencesSnapshot]
  )

  const update = React.useCallback((next: Partial<FileDownloadPreferences>) => {
    writeFileDownloadPreferences(next)
  }, [])

  return (
    <div className="w-full max-w-2xl px-5 pb-12">
      <section className="border-b">
        <SettingRow
          label="Download dialog"
          description="Review the file name, size, and compression before downloading."
        >
          <Switch
            aria-label="Show download dialog"
            checked={preferences.confirmBeforeDownload}
            onCheckedChange={(confirmBeforeDownload) =>
              update({ confirmBeforeDownload })
            }
          />
        </SettingRow>

        <SettingRow
          label="Backup link preview"
          description="Open shared backup links on a Hearth preview page before downloading."
        >
          <Switch
            aria-label="Show backup link preview"
            checked={preferences.previewBackupDownloads}
            onCheckedChange={(previewBackupDownloads) =>
              update({ previewBackupDownloads })
            }
          />
        </SettingRow>

        <SettingRow
          label="Compress by default"
          description="Package files before downloading to reduce transfer size."
        >
          <Switch
            aria-label="Compress files by default"
            checked={preferences.compressByDefault}
            onCheckedChange={(compressByDefault) =>
              update({ compressByDefault })
            }
          />
        </SettingRow>

        <SettingRow
          label="Archive format"
          description="Used whenever download compression is enabled."
        >
          <div className="grid max-w-md grid-cols-2 gap-1.5">
            <ArchiveFormatButton
              active={preferences.archiveFormat === "zip"}
              description="Windows-friendly"
              format="zip"
              icon={Archive}
              label="ZIP"
              onSelect={(archiveFormat) => update({ archiveFormat })}
            />
            <ArchiveFormatButton
              active={preferences.archiveFormat === "gzip"}
              description="Single-file stream"
              format="gzip"
              icon={FileArchive}
              label="Gzip"
              onSelect={(archiveFormat) => update({ archiveFormat })}
            />
          </div>
        </SettingRow>
      </section>
    </div>
  )
})

const ArchiveFormatButton = React.memo(function ArchiveFormatButton({
  active,
  description,
  format,
  icon: Icon,
  label,
  onSelect,
}: {
  active: boolean
  description: string
  format: FileArchiveFormat
  icon: React.ComponentType<{ className?: string }>
  label: string
  onSelect: (format: FileArchiveFormat) => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "relative flex min-h-14 items-center gap-3 border px-3 text-left transition-[border-color,background-color,color] outline-none focus-visible:ring-2 focus-visible:ring-ring/45",
        active
          ? "border-primary/65 bg-primary/8 text-foreground"
          : "border-input bg-background text-muted-foreground hover:border-primary/35 hover:text-foreground"
      )}
      onClick={() => onSelect(format)}
    >
      <Icon className={cn("size-4", active && "text-primary")} />
      <span className="min-w-0">
        <span className="block text-xs font-medium">{label}</span>
        <span className="type-meta block text-muted-foreground">
          {description}
        </span>
      </span>
      {active ? (
        <span className="absolute top-1.5 right-1.5 grid size-3.5 place-items-center bg-primary text-primary-foreground">
          <Check className="size-2.5" aria-hidden="true" />
        </span>
      ) : null}
    </button>
  )
})

function SettingRow({
  children,
  description,
  label,
}: {
  children: React.ReactNode
  description: string
  label: string
}) {
  return (
    <div className="grid gap-3 border-b py-5 last:border-b-0 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center">
      <div>
        <p className="text-xs font-medium text-foreground">{label}</p>
        <p className="type-meta mt-1 text-muted-foreground sm:hidden">
          {description}
        </p>
      </div>
      <div className="min-w-0">
        {children}
        <p className="type-meta mt-1.5 hidden text-muted-foreground sm:block">
          {description}
        </p>
      </div>
    </div>
  )
}
