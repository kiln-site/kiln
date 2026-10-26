import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Result } from "effect"
import {
  Check,
  FolderOpen,
  ImageUp,
  Link2,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Trash2,
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
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { showToast } from "@workspace/ui/components/sonner"
import { cn } from "@workspace/ui/lib/utils"

import { markSmallIcon, useIconUrl } from "@/components/icon-image"
import { ensuringPromise, recoverPromise } from "@/effect/promise"
import {
  base64ToBlob,
  blobToBase64,
  prepareIconImage,
  type IconFit,
  type PreparedIcon,
} from "@/lib/icon-image"
import {
  ICON_SOURCE_MAX_BYTES,
  SERVER_ICON_PATH,
  type IconDetails,
  type IconOrigin,
  type IconSubject,
} from "@/lib/icons"
import { iconDetailsQueryOptions, queryKeys } from "@/lib/query-options"
import { readRelayFile, RelayTransferError } from "@/lib/relay-file-transfer"
import {
  detectIcon,
  fetchIconSource,
  readIconSourceFile,
  removeCustomIcon,
  saveCustomIcon,
} from "@/server/icons"

// Choosing an icon: upload a picture, copy one from the web, or, for game
// servers and apps, copy a file from their files or containers. The browser
// shrinks what's chosen before it's saved. Game servers and apps also show
// what Kiln found for them, which their custom icon takes the place of.

type SourceKind = "files" | "link" | "upload"

/** A game server's or app's files, to copy an icon from. */
export interface IconFileSource {
  /** The root's ID for the Files tab: a server's ID, or `app:<appId>`. */
  readonly rootId: string
  /** An app's Compose services, whose containers an icon can come from. */
  readonly services?: ReadonlyArray<string>
}

export interface IconEditorProps {
  /** The kind's own icon, shown while there's no other. */
  readonly fallback: React.ReactNode
  readonly files?: IconFileSource
  readonly fit: IconFit
  /** Lowercase, as "game server" or "picture". */
  readonly noun: string
  readonly subject: IconSubject
  readonly title: string
}

/**
 * An icon that opens its editor when clicked, like a profile picture, for
 * those who may change it.
 */
export function EditableIcon({
  canEdit,
  children,
  className,
  editor,
}: {
  canEdit: boolean
  /** Drawn in place of the icon, as an account's avatar is. */
  children?: React.ReactNode
  className?: string
  editor: IconEditorProps
}) {
  const [open, setOpen] = React.useState(false)
  const url = useIconUrl(editor.subject)
  const icon = children ?? <IconPreview fallback={editor.fallback} url={url} />
  if (!canEdit) {
    return <span className={cn(iconFrameClassName, className)}>{icon}</span>
  }
  return (
    <>
      <button
        type="button"
        aria-label={`Change ${editor.noun === "picture" ? "picture" : `${editor.noun} icon`}`}
        className={cn(
          iconFrameClassName,
          "group/icon cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          className
        )}
        onClick={() => setOpen(true)}
      >
        {icon}
        <span className="pointer-events-none absolute inset-0 grid place-items-center rounded-[inherit] bg-background/70 opacity-0 backdrop-blur-[1px] transition-opacity group-hover/icon:opacity-100 group-focus-visible/icon:opacity-100">
          <Pencil className="size-4! text-foreground" />
        </span>
        <span className="pointer-events-none absolute -right-1 -bottom-1 grid size-5 place-items-center rounded-full border bg-card text-muted-foreground shadow-sm transition-colors group-hover/icon:text-foreground">
          <Pencil className="size-2.5!" />
        </span>
      </button>
      {open ? <IconEditorDialog {...editor} onOpenChange={setOpen} /> : null}
    </>
  )
}

const iconFrameClassName =
  "relative grid size-16 shrink-0 place-items-center rounded-xl border border-border/70 bg-background/60 text-muted-foreground [&_svg]:size-7"

function IconPreview({
  fallback,
  url,
}: {
  fallback: React.ReactNode
  url: string | null
}) {
  const [failed, setFailed] = React.useState<string | null>(null)
  if (!url || failed === url) return <>{fallback}</>
  return (
    <img
      alt=""
      className="size-full rounded-[inherit] object-contain data-[small]:[image-rendering:pixelated]"
      decoding="async"
      draggable={false}
      onError={() => setFailed(url)}
      onLoad={markSmallIcon}
      src={url}
    />
  )
}

function IconEditorDialog({
  fallback,
  files,
  fit,
  noun,
  onOpenChange,
  subject,
  title,
}: IconEditorProps & { onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient()
  const currentUrl = useIconUrl(subject)
  const details = useQuery(iconDetailsQueryOptions(subject))
  const [source, setSource] = React.useState<SourceKind>("upload")
  const [candidate, setCandidate] = React.useState<{
    icon: PreparedIcon
    origin: IconOrigin
  } | null>(null)
  const [preparing, setPreparing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(
    () => () => {
      if (candidate) URL.revokeObjectURL(candidate.icon.previewUrl)
    },
    [candidate]
  )

  const refresh = React.useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.icons.index }),
        queryClient.invalidateQueries({ queryKey: queryKeys.icons.details }),
      ]),
    [queryClient]
  )

  const choose = React.useCallback(
    async (load: () => Promise<Blob>, origin: IconOrigin) => {
      setError(null)
      setPreparing(true)
      const prepared = await ensuringPromise(
        () =>
          recoverPromise(
            async () => ({ icon: await prepareIconImage(await load(), fit) }),
            (cause) => ({ error: errorMessage(cause, "Could not use that image") })
          ),
        () => setPreparing(false)
      )
      if ("error" in prepared) setError(prepared.error)
      else setCandidate({ icon: prepared.icon, origin })
    },
    [fit]
  )

  const save = useMutation({
    mutationFn: async () => {
      if (!candidate) return
      await saveCustomIcon({
        data: {
          contentBase64: await blobToBase64(candidate.icon.blob),
          origin: candidate.origin,
          subject,
        },
      })
      await refresh()
    },
    onSuccess: () => {
      showToast({
        message: noun === "picture" ? "Picture updated" : "Icon updated",
        type: "success",
      })
      onOpenChange(false)
    },
    onError: (cause) =>
      setError(errorMessage(cause, "Could not save the icon")),
  })

  const remove = useMutation({
    mutationFn: async () => {
      await removeCustomIcon({ data: { subject } })
      await refresh()
    },
    onSuccess: () => {
      showToast({
        message: noun === "picture" ? "Picture removed" : "Custom icon removed",
        type: "success",
      })
      onOpenChange(false)
    },
    onError: (cause) =>
      setError(errorMessage(cause, "Could not remove the icon")),
  })

  const busy = preparing || save.isPending || remove.isPending
  const previewUrl = candidate?.icon.previewUrl ?? currentUrl
  const hasCustom = Boolean(details.data?.custom)
  const detectable = subject.kind === "server" || subject.kind === "app"

  const onPaste = (event: React.ClipboardEvent) => {
    const file = Array.from(event.clipboardData.files).find((item) =>
      item.type.startsWith("image/")
    )
    if (!file || busy) return
    event.preventDefault()
    setSource("upload")
    void choose(async () => file, { type: "upload" })
  }

  return (
    <Dialog open onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-xl" onPaste={onPaste}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {noun === "picture"
              ? "Shown beside your name across Kiln."
              : `Shown wherever this ${noun} appears in Kiln.`}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <div className="flex flex-col items-center gap-3 sm:items-stretch">
            <div className="relative grid aspect-square w-36 place-items-center overflow-hidden rounded-2xl border bg-[conic-gradient(var(--muted)_25%,transparent_0_50%,var(--muted)_0_75%,transparent_0)] bg-[length:14px_14px] text-muted-foreground [&_svg]:size-12">
              {previewUrl ? (
                <img
                  alt=""
                  className={cn(
                    "size-full object-contain",
                    fit === "cover" && "object-cover"
                  )}
                  src={previewUrl}
                />
              ) : (
                fallback
              )}
              {preparing ? (
                <span className="absolute inset-0 grid place-items-center bg-background/60">
                  <LoaderCircle className="size-5! animate-spin" />
                </span>
              ) : null}
            </div>
            <ListPreview fallback={fallback} fit={fit} url={previewUrl} />
            <p className="type-meta text-center text-muted-foreground sm:text-left">
              {candidate
                ? "Not saved yet"
                : currentSourceLabel(details.data, noun)}
            </p>
          </div>

          <div className="flex min-w-0 flex-col gap-3">
            <SourceTabs
              files={Boolean(files)}
              onChange={(next) => {
                setSource(next)
                setError(null)
              }}
              value={source}
            />
            {source === "upload" ? (
              <UploadSource
                disabled={busy}
                onFile={(file) =>
                  void choose(async () => file, { type: "upload" })
                }
              />
            ) : source === "link" ? (
              <LinkSource
                disabled={busy}
                onUrl={(url) =>
                  void choose(
                    async () => {
                      const fetched = await fetchIconSource({ data: { url } })
                      return base64ToBlob(
                        fetched.contentBase64,
                        fetched.contentType
                      )
                    },
                    { type: "url", url }
                  )
                }
              />
            ) : files &&
              (subject.kind === "server" || subject.kind === "app") ? (
              <FilesSource
                disabled={busy}
                files={files}
                kind={subject.kind}
                onFile={(path, service) =>
                  void choose(
                    () => readSourceFile(subject, files, path, service),
                    service
                      ? { type: "file", path, service }
                      : { type: "file", path }
                  )
                }
              />
            ) : null}
            {error ? (
              <p className="type-meta text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            {detectable ? (
              <DetectionStatus
                details={details.data}
                subject={subject}
                onDetected={refresh}
              />
            ) : null}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {hasCustom ? (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={busy}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Trash2 />
              )}
              {noun === "picture"
                ? "Remove picture"
                : detectable
                  ? "Use detected icon"
                  : "Use default icon"}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!candidate || busy}
              onClick={() => save.mutate()}
            >
              {save.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Check />
              )}
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// How the icon looks at the sizes lists draw it.
function ListPreview({
  fallback,
  fit,
  url,
}: {
  fallback: React.ReactNode
  fit: IconFit
  url: string | null
}) {
  return (
    <div className="flex items-center justify-center gap-2 sm:justify-start">
      {(["size-8", "size-6"] as const).map((size) => (
        <span
          key={size}
          className={cn(
            "grid shrink-0 place-items-center overflow-hidden rounded-md border border-border/70 bg-background/35 text-muted-foreground [&_svg]:size-4",
            size
          )}
        >
          {url ? (
            <img
              alt=""
              className={cn(
                "size-full object-contain",
                fit === "cover" && "object-cover"
              )}
              src={url}
            />
          ) : (
            fallback
          )}
        </span>
      ))}
      <span className="type-meta text-muted-foreground">In lists</span>
    </div>
  )
}

function SourceTabs({
  files,
  onChange,
  value,
}: {
  files: boolean
  onChange: (value: SourceKind) => void
  value: SourceKind
}) {
  const tabs: ReadonlyArray<{
    icon: typeof ImageUp
    label: string
    value: SourceKind
  }> = [
    { icon: ImageUp, label: "Upload", value: "upload" },
    { icon: Link2, label: "Link", value: "link" },
    ...(files
      ? [{ icon: FolderOpen, label: "Files", value: "files" as const }]
      : []),
  ]
  return (
    <div
      role="tablist"
      aria-label="Where the icon comes from"
      className="grid auto-cols-fr grid-flow-col gap-1 rounded-lg border bg-muted/40 p-1"
    >
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={value === tab.value}
          className={cn(
            "type-control-sm flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5",
            value === tab.value && "bg-background text-foreground shadow-xs"
          )}
          onClick={() => onChange(tab.value)}
        >
          <tab.icon />
          {tab.label}
        </button>
      ))}
    </div>
  )
}

function UploadSource({
  disabled,
  onFile,
}: {
  disabled: boolean
  onFile: (file: File) => void
}) {
  const input = React.useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = React.useState(false)
  return (
    <div
      className={cn(
        "flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-4 text-center transition-colors",
        dragging ? "border-primary bg-primary/5" : "bg-background/40"
      )}
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        const file = event.dataTransfer.files[0]
        if (file && !disabled) onFile(file)
      }}
    >
      <ImageUp className="size-5 text-muted-foreground" />
      <p className="text-[0.8125rem] text-muted-foreground">
        Drop an image, paste one, or
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        Choose a file
      </Button>
      <p className="type-meta text-muted-foreground/80">
        PNG, JPEG, GIF, WebP, SVG, or ICO
      </p>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,.ico"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ""
          if (file) onFile(file)
        }}
      />
    </div>
  )
}

function LinkSource({
  disabled,
  onUrl,
}: {
  disabled: boolean
  onUrl: (url: string) => void
}) {
  const [url, setUrl] = React.useState("")
  const value = url.trim()
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (value) onUrl(value)
      }}
    >
      <label htmlFor="icon-url" className="type-label text-muted-foreground">
        Image address
      </label>
      <div className="flex gap-2">
        <Input
          id="icon-url"
          type="url"
          inputMode="url"
          placeholder="https://example.com/logo.png"
          value={url}
          disabled={disabled}
          onChange={(event) => setUrl(event.target.value)}
          autoFocus
        />
        <Button type="submit" variant="outline" disabled={disabled || !value}>
          Get
        </Button>
      </div>
      <p className="type-meta text-muted-foreground">
        Kiln copies the image, so it keeps working if the link changes.
      </p>
    </form>
  )
}

const APP_FILES = "__files__"

function FilesSource({
  disabled,
  files,
  kind,
  onFile,
}: {
  disabled: boolean
  files: IconFileSource
  kind: "app" | "server"
  onFile: (path: string, service: string | undefined) => void
}) {
  const services = files.services ?? []
  const [service, setService] = React.useState(APP_FILES)
  const inContainer = service !== APP_FILES
  const [path, setPath] = React.useState(
    kind === "server" ? SERVER_ICON_PATH : ""
  )
  const value = path.trim()
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (value) onFile(value, inContainer ? service : undefined)
      }}
    >
      {services.length ? (
        <div className="flex flex-col gap-1.5">
          <span className="type-label text-muted-foreground">From</span>
          <Select
            value={service}
            onValueChange={(next) => {
              setService(next)
              setPath("")
            }}
            disabled={disabled}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={APP_FILES}>App files</SelectItem>
              {services.map((name) => (
                <SelectItem key={name} value={name}>
                  {name} container
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <label htmlFor="icon-path" className="type-label text-muted-foreground">
        {inContainer ? "Path in the container" : "Path"}
      </label>
      <div className="flex gap-2">
        <Input
          id="icon-path"
          className="font-mono text-xs"
          placeholder={
            inContainer
              ? "/app/public/favicon.png"
              : kind === "server"
                ? SERVER_ICON_PATH
                : "public/logo.png"
          }
          value={path}
          disabled={disabled}
          onChange={(event) => setPath(event.target.value)}
        />
        <Button type="submit" variant="outline" disabled={disabled || !value}>
          Load
        </Button>
      </div>
      <p className="type-meta text-muted-foreground">
        {inContainer
          ? "Read from the running container. Kiln keeps a copy."
          : kind === "server"
            ? "Relative to the server's folder, as in Files. Kiln keeps a copy."
            : "Relative to the app's folder, as in Files. Kiln keeps a copy."}
      </p>
    </form>
  )
}

// A file under the root comes straight from the Relay to this page; one
// inside a container, or from a Relay this page can't reach directly, comes
// through Hearth.
async function readSourceFile(
  subject: IconSubject & { kind: "app" | "server" },
  files: IconFileSource,
  path: string,
  service: string | undefined
): Promise<Blob> {
  if (!service) {
    const direct = await recoverPromise(
      () =>
        readRelayFile({
          instanceId: files.rootId,
          maxBytes: ICON_SOURCE_MAX_BYTES,
          path: path.replace(/^\/+/u, ""),
          relayId: subject.relayId,
        }),
      (cause) => cause
    )
    if (direct instanceof Blob) return direct
    if (
      !(direct instanceof RelayTransferError) ||
      direct.reason !== "unavailable"
    ) {
      throw direct
    }
  }
  const read = await readIconSourceFile({ data: { path, service, subject } })
  return base64ToBlob(read.contentBase64, read.contentType)
}

function DetectionStatus({
  details,
  onDetected,
  subject,
}: {
  details: IconDetails | undefined
  onDetected: () => Promise<unknown>
  subject: IconSubject
}) {
  const detect = useMutation({
    mutationFn: async () => {
      await detectIcon({ data: { subject } })
      await onDetected()
    },
    onError: (cause) =>
      showToast({
        message: errorMessage(cause, "Could not check for an icon"),
        type: "error",
      }),
  })
  const detected = details?.detected
  const found = detected?.digest ? detected.origin : null
  const looksFor =
    subject.kind === "server"
      ? `${SERVER_ICON_PATH} in the server's folder`
      : "an icon on the app's first domain"
  return (
    <div className="mt-auto flex items-start gap-3 rounded-lg border bg-muted/25 px-3 py-2.5">
      <div className="min-w-0 flex-1 text-[0.8125rem]">
        <p className="font-medium">
          {found ? `Found ${originLabel(found)}` : "Nothing found yet"}
        </p>
        <p className="type-meta mt-0.5 text-muted-foreground">
          Kiln looks for {looksFor}
          {details?.custom && found ? "; your icon is shown instead" : ""}.
          {detected ? ` Checked ${relativeTime(detected.checkedAt)}.` : ""}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={detect.isPending}
        onClick={() => detect.mutate()}
      >
        <RefreshCw className={cn(detect.isPending && "animate-spin")} />
        Check now
      </Button>
    </div>
  )
}

function currentSourceLabel(details: IconDetails | undefined, noun: string) {
  if (!details) return ""
  if (details.custom) {
    const origin = details.custom.origin
    return origin && origin.type !== "upload"
      ? `Custom, from ${originLabel(origin)}`
      : noun === "picture"
        ? "Your picture"
        : "Custom icon"
  }
  if (details.detected?.digest && details.detected.origin) {
    return `Found ${originLabel(details.detected.origin)}`
  }
  return noun === "picture" ? "No picture yet" : "Default icon"
}

function originLabel(origin: IconOrigin): string {
  switch (origin.type) {
    case "upload":
      return "an upload"
    case "url":
    case "site":
      return `on ${hostOf(origin.url)}`
    case "file":
      return origin.service
        ? `in ${origin.service}: ${origin.path}`
        : `in ${origin.path}`
  }
}

function hostOf(url: string): string {
  return Result.try(() => new URL(url).host).pipe(Result.getOrElse(() => url))
}

function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback
}
