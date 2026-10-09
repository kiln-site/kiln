import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { queryKeys } from "@/lib/query-options"
import { Effect } from "effect"
import {
  Archive,
  Download,
  FileDown,
  Gauge,
  LoaderCircle,
  TriangleAlert,
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
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@workspace/ui/components/input-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { showToast } from "@workspace/ui/components/sonner"
import { Switch } from "@workspace/ui/components/switch"

import {
  fileDownloadArchiveSuffix,
  fileDownloadName,
  readFileDownloadPreferences,
  writeFileDownloadPreferences,
} from "@/lib/file-download-preferences"
import type { FileArchiveFormat } from "@/lib/file-download-preferences"
import {
  downloadRelayFile,
  inspectRelayFileDownload,
  isValidRelayDownloadName,
} from "@/lib/relay-file-transfer"
import type { RelayFileDownloadPreview } from "@/lib/relay-file-transfer"
import type { FileWorkspaceInstance } from "@/lib/relay-selectors"

interface FileDownloadDialogProps {
  instance: FileWorkspaceInstance
  onOpenChange: (open: boolean) => void
  open: boolean
  path: string
}

export const FileDownloadDialog = React.memo(function FileDownloadDialog({
  instance,
  onOpenChange,
  open,
  path,
}: FileDownloadDialogProps) {
  const preferences = React.useMemo(
    () => readFileDownloadPreferences(),
    [open, path]
  )
  const [archiveFormat, setArchiveFormat] = React.useState<FileArchiveFormat>(
    preferences.archiveFormat
  )
  const [compressed, setCompressed] = React.useState(
    preferences.compressByDefault
  )
  const [downloadBaseName, setDownloadBaseName] = React.useState(
    () => path.split("/").filter(Boolean).at(-1) || "download"
  )
  const [skipDialog, setSkipDialog] = React.useState(false)
  const automaticDownload = React.useRef<string | null>(null)
  const compressionId = React.useId()
  const skipDialogId = React.useId()
  const previewQuery = useQuery({
    queryKey: [
      ...queryKeys.relay.tree(instance.relayId, instance.id).slice(0, -1),
      "download-preview",
      path,
    ],
    queryFn: ({ signal }) =>
      inspectRelayFileDownload({
        instanceId: instance.id,
        path,
        relayId: instance.relayId,
        signal,
      }),
    enabled: open && preferences.confirmBeforeDownload,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  const download = useMutation({
    mutationFn: ({
      archiveFormat,
      compressed,
      name,
      automatic,
    }: {
      archiveFormat: FileArchiveFormat
      compressed: boolean
      name: string
      automatic: boolean
      skipDialog?: boolean
    }) =>
      Effect.runPromise(
        startRelayDownload({
          archiveFormat,
          compressed,
          instanceId: instance.id,
          name,
          path,
          preflight: automatic,
          relayId: instance.relayId,
        })
      ),
    onSuccess: (_, variables) => {
      if (variables.skipDialog)
        writeFileDownloadPreferences({ confirmBeforeDownload: false })
      onOpenChange(false)
      showDownloadRequestedToast(variables.name)
    },
    onError: (cause, variables) => {
      if (!variables.automatic) return
      onOpenChange(false)
      showToast({
        type: "error",
        message: "Download could not start",
        description: downloadErrorMessage(cause),
      })
    },
  })
  React.useEffect(() => {
    if (!open) {
      automaticDownload.current = null
      return
    }
    if (preferences.confirmBeforeDownload) return
    const key = `${instance.id}:${path}`
    if (automaticDownload.current === key) return
    automaticDownload.current = key
    download.mutate({
      archiveFormat: preferences.archiveFormat,
      compressed: preferences.compressByDefault,
      name: fileDownloadName(
        path.split("/").filter(Boolean).at(-1) || "download",
        preferences.compressByDefault,
        preferences.archiveFormat
      ),
      automatic: true,
    })
  }, [download.mutate, instance.id, open, path, preferences])
  const preview = previewQuery.data ?? null
  const downloading = download.isPending
  const downloadError = download.error
    ? downloadErrorMessage(download.error)
    : null
  const archiveSuffix = compressed
    ? fileDownloadArchiveSuffix(archiveFormat)
    : ""
  const downloadName = fileDownloadName(
    downloadBaseName,
    compressed,
    archiveFormat
  )
  const invalidName =
    !isValidRelayDownloadName(downloadBaseName) ||
    !isValidRelayDownloadName(downloadName)
  const compressedSize = preview
    ? archiveFormat === "zip"
      ? preview.zipSizeEstimate
      : preview.gzipSizeEstimate
    : 0
  const outputSize = preview ? (compressed ? compressedSize : preview.size) : 0
  const savings =
    preview && compressed && preview.size > 0
      ? Math.min(
          99,
          Math.max(0, Math.round((1 - outputSize / preview.size) * 100))
        )
      : 0

  const changeCompression = React.useCallback(
    (nextCompressed: boolean) => {
      setCompressed(nextCompressed)
      download.reset()
    },
    [download.reset]
  )

  const changeArchiveFormat = React.useCallback(
    (value: string) => {
      const nextFormat: FileArchiveFormat = value === "gzip" ? "gzip" : "zip"
      setArchiveFormat(nextFormat)
      download.reset()
    },
    [download.reset]
  )

  const changeDownloadBaseName = React.useCallback(
    (name: string) => {
      setDownloadBaseName(name)
      download.reset()
    },
    [download.reset]
  )

  const startDownload = () => {
    if (!preview || invalidName || downloading) return
    download.mutate({
      archiveFormat,
      compressed,
      name: downloadName,
      automatic: false,
      skipDialog,
    })
  }

  if (open && !preferences.confirmBeforeDownload) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:max-w-md"
        showCloseButton={!downloading}
      >
        <DialogHeader className="border-b border-border/70 px-4 pt-4 pb-3">
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 shrink-0 place-items-center border border-primary/30 bg-primary/10 text-primary">
              <FileDown className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-lg">Download file</DialogTitle>
              <DialogDescription className="mt-0.5 truncate font-mono">
                /data/{path}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {previewQuery.isPending ? (
          <div className="grid min-h-40 place-items-center px-5 py-8 text-center">
            <div>
              <LoaderCircle className="mx-auto size-5 animate-spin text-primary" />
              <p className="mt-3 text-xs font-medium">Inspecting file</p>
              <p className="type-meta mt-1 text-muted-foreground">
                Estimating transfer size at the Relay.
              </p>
            </div>
          </div>
        ) : previewQuery.isError ? (
          <div className="grid min-h-40 place-items-center px-5 py-8 text-center">
            <div className="max-w-sm">
              <TriangleAlert className="mx-auto size-5 text-destructive" />
              <p className="mt-3 text-xs font-semibold">Download unavailable</p>
              <p className="type-support mt-1 text-muted-foreground">
                {downloadErrorMessage(previewQuery.error)}
              </p>
            </div>
          </div>
        ) : preview ? (
          <DownloadOptions
            archiveFormat={archiveFormat}
            archiveSuffix={archiveSuffix}
            compressed={compressed}
            compressionId={compressionId}
            downloadBaseName={downloadBaseName}
            downloadError={downloadError}
            downloading={downloading}
            invalidName={invalidName}
            onArchiveFormatChange={changeArchiveFormat}
            onCompressionChange={changeCompression}
            onDownloadBaseNameChange={changeDownloadBaseName}
            onSkipDialogChange={setSkipDialog}
            outputSize={outputSize}
            preview={preview}
            savings={savings}
            skipDialog={skipDialog}
            skipDialogId={skipDialogId}
          />
        ) : null}

        <DialogFooter className="m-0 rounded-none px-4 py-3">
          <Button
            type="button"
            variant="outline"
            disabled={downloading}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!preview || invalidName || downloading}
            onClick={() => void startDownload()}
          >
            {downloading ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Download />
            )}
            {downloading ? "Starting…" : "Download"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

const DownloadOptions = React.memo(function DownloadOptions({
  archiveFormat,
  archiveSuffix,
  compressed,
  compressionId,
  downloadBaseName,
  downloadError,
  downloading,
  invalidName,
  onArchiveFormatChange,
  onCompressionChange,
  onDownloadBaseNameChange,
  onSkipDialogChange,
  outputSize,
  preview,
  savings,
  skipDialog,
  skipDialogId,
}: {
  archiveFormat: FileArchiveFormat
  archiveSuffix: string
  compressed: boolean
  compressionId: string
  downloadBaseName: string
  downloadError: string | null
  downloading: boolean
  invalidName: boolean
  onArchiveFormatChange: (value: string) => void
  onCompressionChange: (compressed: boolean) => void
  onDownloadBaseNameChange: (name: string) => void
  onSkipDialogChange: (skip: boolean) => void
  outputSize: number
  preview: RelayFileDownloadPreview
  savings: number
  skipDialog: boolean
  skipDialogId: string
}) {
  return (
    <div className="space-y-3 px-4 py-4">
      <div className="grid grid-cols-2 border border-border/75 bg-background/25">
        <DownloadMetric
          icon={<Gauge />}
          label="Original"
          value={formatBytes(preview.size)}
        />
        <DownloadMetric
          accent={compressed}
          icon={<Archive />}
          label={compressed ? "Estimated" : "Download"}
          value={formatBytes(outputSize)}
          detail={compressed && savings > 0 ? `${savings}% smaller` : null}
        />
      </div>

      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-foreground">Save as</span>
        <InputGroup>
          <InputGroupInput
            autoComplete="off"
            value={downloadBaseName}
            aria-invalid={invalidName}
            maxLength={255 - archiveSuffix.length}
            spellCheck={false}
            className="font-mono text-sm"
            onChange={(event) => onDownloadBaseNameChange(event.target.value)}
          />
          {archiveSuffix ? (
            <InputGroupAddon align="inline-end" className="font-mono text-xs">
              {archiveSuffix}
            </InputGroupAddon>
          ) : null}
        </InputGroup>
        {invalidName ? (
          <span className="type-meta text-destructive">
            Use a file name without slashes or control characters.
          </span>
        ) : null}
      </label>

      <div className="flex items-center gap-3 border border-border/75 bg-muted/10 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <label
            htmlFor={compressionId}
            className="text-xs font-medium text-foreground"
          >
            Compress download
          </label>
          <p className="type-meta mt-0.5 text-muted-foreground">
            {preview.recommendedCompression
              ? "This file should compress well."
              : "This file may not shrink much."}
          </p>
        </div>
        {compressed ? (
          <Select
            value={archiveFormat}
            disabled={downloading}
            onValueChange={onArchiveFormatChange}
          >
            <SelectTrigger
              aria-label="Archive format"
              className="h-7 gap-1.5 bg-input/18 px-2 text-xs [&_svg]:size-3.5"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="min-w-(--radix-select-trigger-width)">
              <SelectItem value="zip">ZIP</SelectItem>
              <SelectItem value="gzip">Gzip</SelectItem>
            </SelectContent>
          </Select>
        ) : null}
        <Switch
          id={compressionId}
          checked={compressed}
          disabled={downloading}
          onCheckedChange={onCompressionChange}
        />
      </div>

      <label
        htmlFor={skipDialogId}
        className="type-support flex cursor-pointer items-center gap-2 text-muted-foreground"
      >
        <input
          id={skipDialogId}
          type="checkbox"
          checked={skipDialog}
          disabled={downloading}
          className="size-3.5 accent-primary"
          onChange={(event) => onSkipDialogChange(event.target.checked)}
        />
        Don&apos;t show this again
      </label>

      {downloadError ? (
        <p
          role="alert"
          className="flex items-start gap-2 text-xs leading-5 text-destructive"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          {downloadError}
        </p>
      ) : null}
    </div>
  )
})

function startRelayDownload({
  archiveFormat,
  compressed,
  instanceId,
  name,
  path,
  preflight = false,
  relayId,
}: {
  archiveFormat: FileArchiveFormat
  compressed: boolean
  instanceId: string
  name: string
  path: string
  preflight?: boolean
  relayId: string
}) {
  return Effect.tryPromise({
    try: async () => {
      if (preflight) {
        await inspectRelayFileDownload({ instanceId, path, relayId })
      }
      await downloadRelayFile({
        compression: compressed ? archiveFormat : "none",
        instanceId,
        name,
        path,
        relayId,
      })
    },
    catch: (cause) => cause,
  })
}

function showDownloadRequestedToast(name: string) {
  showToast({
    type: "info",
    message: "Download requested",
    description: `${name} was handed to your browser. Check its downloads for status.`,
  })
}

function downloadErrorMessage(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : "The Relay could not start this download."
}

function DownloadMetric({
  accent = false,
  detail,
  icon,
  label,
  value,
}: {
  accent?: boolean
  detail?: string | null
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 border-l border-border/75 px-3 py-2.5 first:border-l-0">
      <span
        className={`grid size-7 shrink-0 place-items-center border [&_svg]:size-3 ${accent ? "border-primary/35 bg-primary/10 text-primary" : "border-border/70 bg-card text-muted-foreground"}`}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="type-technical-label block text-muted-foreground">
          {label}
        </span>
        <span className="block truncate text-xs font-semibold text-foreground">
          {value}
        </span>
        {detail ? (
          <span className="type-meta block text-primary">{detail}</span>
        ) : null}
      </span>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KiB", "MiB", "GiB", "TiB"]
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[index]}`
}
