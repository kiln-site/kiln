import * as React from "react"
import { Effect } from "effect"
import {
  Archive,
  ArrowDownToLine,
  Check,
  Clock3,
  Copy,
  Database,
  FileArchive,
  PackageOpen,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { showToast } from "@workspace/ui/components/sonner"

import { HearthMark } from "@/components/hearth-mark"
import type { getBackupDownloadShare } from "@/server/backup-downloads"

type DownloadShare = NonNullable<
  Awaited<ReturnType<typeof getBackupDownloadShare>>
>

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

export const BackupDownloadPage = React.memo(function BackupDownloadPage({
  downloadId,
  share,
}: {
  downloadId: string
  share: DownloadShare | null
}) {
  const filenameRef = React.useRef<HTMLHeadingElement>(null)

  React.useLayoutEffect(() => {
    const heading = filenameRef.current
    if (!heading) return
    const fitFilename = () => {
      heading.style.removeProperty("font-size")
      const availableWidth = heading.clientWidth
      const naturalWidth = heading.scrollWidth
      if (naturalWidth <= availableWidth || availableWidth === 0) return
      const defaultFontSize = Number.parseFloat(
        window.getComputedStyle(heading).fontSize
      )
      const fittedFontSize = Math.max(
        11,
        defaultFontSize * (availableWidth / naturalWidth)
      )
      heading.style.fontSize = `${fittedFontSize}px`
    }
    const observer = new ResizeObserver(fitFilename)
    observer.observe(heading)
    fitFilename()
    return () => observer.disconnect()
  }, [share?.filename])

  if (!share) return <UnavailableDownload />

  const TypeIcon = artifactIcon(share.artifactKind)
  const directPath = `/downloads/${encodeURIComponent(downloadId)}?direct=true`
  const downloadTarget = `kiln-backup-download-${downloadId}`

  return (
    <main className="relative grid h-dvh place-items-center-safe overflow-y-auto bg-background px-4 py-8 text-foreground sm:px-6">
      <div className="pointer-events-none fixed inset-0 bg-[image:var(--ambient-grid)] [mask-image:radial-gradient(ellipse_75%_70%_at_50%_42%,black,transparent)] bg-[size:56px_56px] opacity-70" />
      <div className="pointer-events-none fixed top-[8%] left-1/2 size-[32rem] -translate-x-1/2 rounded-full bg-primary/5 blur-[150px]" />

      <div className="relative w-full max-w-lg">
        <div className="mb-5 flex flex-col items-center text-center">
          <a
            className="group -m-2 flex min-w-24 flex-col items-center rounded-xl p-2 text-center outline-none focus-visible:ring-2 focus-visible:ring-ring"
            href={share.homeUrl}
            aria-label="Go to Kiln"
          >
            <HearthMark className="size-9 rounded-xl" />
            <span className="mt-2 px-4 py-1 font-heading text-lg font-semibold tracking-[-0.035em] transition-colors group-hover:text-primary">
              Kiln
            </span>
          </a>
        </div>

        <section className="overflow-hidden rounded-2xl border border-border/75 bg-card/70 shadow-2xl shadow-black/20 backdrop-blur-md">
          <div className="p-5 sm:p-6">
            <div className="flex min-w-0 items-center gap-4">
              <div className="grid size-12 shrink-0 place-items-center rounded-xl border bg-background/70 text-primary">
                <TypeIcon className="size-5" strokeWidth={1.7} />
              </div>
              <div className="min-w-0 flex-1">
                <h1
                  ref={filenameRef}
                  className="truncate font-heading text-xl font-semibold tracking-[-0.035em] sm:text-2xl"
                  title={share.filename}
                >
                  {share.filename}
                </h1>
              </div>
            </div>

            <dl className="mt-5 grid grid-cols-3 overflow-hidden rounded-xl border">
              <DownloadFact label="Size" value={formatBytes(share.bytes)} />
              <DownloadFact
                label="Type"
                value={artifactLabel(share.artifactKind)}
              />
              <DownloadFact label="Source" value={share.sourceName} />
            </dl>

            <div className="mt-4 flex items-center gap-3 px-1">
              <div className="type-label grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 font-heading font-bold text-primary">
                {initials(share.sharedBy)}
              </div>
              <div className="min-w-0">
                <p className="type-technical-label text-muted-foreground">
                  Shared by
                </p>
                <p className="type-card-title truncate">{share.sharedBy}</p>
              </div>
              <div className="type-meta ml-auto flex items-center gap-1.5 text-right text-muted-foreground">
                <Clock3 className="size-3 shrink-0" />
                Expires: {dateFormatter.format(new Date(share.expiresAt))}
              </div>
            </div>

            <CopyDirectDownloadButton downloadUrl={share.downloadUrl} />
          </div>

          <footer className="border-t border-border/75 bg-muted/10 p-4 sm:px-6 sm:py-5">
            <Button className="h-12 w-full px-5 text-sm" asChild>
              <a href={directPath} target={downloadTarget}>
                <span className="flex items-center gap-2.5">
                  <ArrowDownToLine /> Download {formatBytes(share.bytes)}
                </span>
              </a>
            </Button>
            <iframe
              className="hidden"
              name={downloadTarget}
              sandbox="allow-downloads"
              title="Backup download target"
            />
          </footer>
        </section>
      </div>
    </main>
  )
})

const CopyDirectDownloadButton = React.memo(function CopyDirectDownloadButton({
  downloadUrl,
}: {
  downloadUrl: string
}) {
  const [copied, setCopied] = React.useState(false)

  const copyRawUrl = React.useCallback(
    () =>
      Effect.runPromise(
        Effect.tryPromise({
          try: () => navigator.clipboard.writeText(downloadUrl),
          catch: (cause) => cause,
        }).pipe(
          Effect.match({
            onFailure: () => {
              showToast({
                message: "Could not copy the direct URL",
                type: "error",
              })
            },
            onSuccess: () => {
              setCopied(true)
              showToast({
                message: "Direct download URL copied",
                type: "success",
              })
              window.setTimeout(() => setCopied(false), 1_500)
            },
          })
        )
      ),
    [downloadUrl]
  )

  return (
    <Button
      className="mt-4 h-9 w-full"
      type="button"
      variant="outline"
      onClick={() => void copyRawUrl()}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? "Direct URL copied" : "Copy direct download URL"}
    </Button>
  )
})

function UnavailableDownload() {
  return (
    <main className="relative grid h-dvh place-items-center overflow-hidden bg-background px-6">
      <div className="pointer-events-none absolute inset-0 bg-[image:var(--ambient-grid)] [mask-image:radial-gradient(ellipse_70%_70%_at_50%_45%,black,transparent)] bg-[size:56px_56px]" />
      <section className="relative w-full max-w-md rounded-2xl border bg-card/60 p-8 text-center shadow-2xl shadow-black/15 backdrop-blur-sm">
        <div className="mx-auto grid size-12 place-items-center rounded-xl border bg-background text-muted-foreground">
          <PackageOpen className="size-5" />
        </div>
        <h1 className="mt-6 font-heading text-2xl font-semibold tracking-[-0.04em]">
          Download unavailable
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          This download ID is invalid or its signed link has expired. Ask the
          person who shared it to create a new link.
        </p>
      </section>
    </main>
  )
}

function DownloadFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-border/75 p-3 not-first:border-l">
      <dt className="type-technical-label text-muted-foreground">{label}</dt>
      <dd className="mt-1.5 truncate text-xs font-semibold" title={value}>
        {value}
      </dd>
    </div>
  )
}

function artifactIcon(kind: DownloadShare["artifactKind"]) {
  if (kind === "database_dump") return Database
  if (kind === "platform_bundle") return FileArchive
  return Archive
}

function artifactLabel(kind: DownloadShare["artifactKind"]): string {
  if (kind === "database_dump") return "Database backup"
  if (kind === "platform_bundle") return "Kiln bundle"
  return "ZIP archive"
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "Unknown size"
  if (bytes < 1024) return `${bytes.toLocaleString()} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = units[0]
  for (const candidate of units.slice(1)) {
    if (value < 1024) break
    value /= 1024
    unit = candidate
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`
}

function initials(value: string): string {
  return value
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => Array.from(part)[0] ?? "")
    .join("")
    .toUpperCase()
}
