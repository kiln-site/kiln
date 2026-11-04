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
  Pickaxe,
  RefreshCw,
  RotateCcw,
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

import {
  IconImage,
  useIconUrl,
} from "@/components/icon-image"
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
  iconSubjectKey,
  type IconDetails,
  type IconOrigin,
  type IconSubject,
} from "@/lib/icons"
import { changeIcon } from "@/lib/icon-changes"
import { iconDetailsQueryOptions, queryKeys } from "@/lib/query-options"
import { readRelayFile, RelayTransferError } from "@/lib/relay-file-transfer"
import {
  detectIcon,
  fetchIconSource,
  fetchMinecraftHead,
  linkIconFile,
  readIconSourceFile,
  removeCustomIcon,
  saveCustomIcon,
} from "@/server/icons"

// Choosing an icon: upload a picture, copy one from the web, or, for an
// account, a Minecraft player's head; the browser shrinks these before
// they're saved. Game servers and apps can instead follow one of their own
// files, which Kiln keeps copying as it changes, and show what Kiln found
// for them, which their custom icon takes the place of.

type SourceKind = "files" | "link" | "minecraft" | "upload"

// What Save would keep: a picture the browser prepared, or a file to follow.
type Candidate =
  | { kind: "copy"; icon: PreparedIcon; origin: IconOrigin }
  | {
      kind: "link"
      path: string
      previewUrl: string
      service: string | undefined
    }

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
  /** For an account, the name the Minecraft tab starts with. */
  readonly minecraftUsername?: string
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
  const icon = children ?? (
    <IconImage
      key={iconSubjectKey(editor.subject)}
      fallback={editor.fallback}
      url={url}
    />
  )
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

function IconEditorDialog({
  fallback,
  files,
  fit,
  minecraftUsername,
  noun,
  onOpenChange,
  subject,
  title,
}: IconEditorProps & { onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient()
  const currentUrl = useIconUrl(subject)
  const details = useQuery(iconDetailsQueryOptions(subject))
  const [source, setSource] = React.useState<SourceKind>("upload")
  const [candidate, setCandidate] = React.useState<Candidate | null>(null)
  const [preparing, setPreparing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(
    () => () => {
      if (candidate) URL.revokeObjectURL(candidatePreview(candidate))
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
      else setCandidate({ kind: "copy", icon: prepared.icon, origin })
    },
    [fit]
  )

  // A file to follow is previewed as it is; Kiln reads and checks it
  // itself when it's saved.
  const preview = React.useCallback(
    async (path: string, service: string | undefined) => {
      if (subject.kind !== "server" && subject.kind !== "app") return
      if (!files) return
      setError(null)
      setPreparing(true)
      const loaded = await ensuringPromise(
        () =>
          recoverPromise(
            async () => ({
              blob: await readSourceFile(subject, files, path, service),
            }),
            (cause) => ({ error: errorMessage(cause, "Could not read that file") })
          ),
        () => setPreparing(false)
      )
      if ("error" in loaded) {
        setError(loaded.error)
        return
      }
      setCandidate({
        kind: "link",
        path,
        previewUrl: URL.createObjectURL(loaded.blob),
        service,
      })
    },
    [files, subject]
  )

  const save = useMutation({
    mutationFn: async () => {
      if (!candidate) return
      const chosen = candidate
      await changeIcon(queryClient, subject, async () =>
        chosen.kind === "link"
          ? linkIconFile({
              data: { path: chosen.path, service: chosen.service, subject },
            })
          : saveCustomIcon({
              data: {
                contentBase64: await blobToBase64(chosen.icon.blob),
                origin: chosen.origin,
                subject,
              },
            })
      )
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
      await changeIcon(queryClient, subject, () =>
        removeCustomIcon({ data: { subject } })
      )
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
  const previewUrl = candidate ? candidatePreview(candidate) : currentUrl
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
              minecraft={subject.kind === "user"}
              onChange={(next) => {
                setSource(next)
                setError(null)
              }}
              value={source}
            />
            {/* Every source shares one cell, so switching between them never
                resizes the dialog; the tallest sets the height. */}
            <div className="grid flex-1 *:col-start-1 *:row-start-1">
              <SourcePanel active={source === "upload"}>
                <UploadSource
                  disabled={busy}
                  onFile={(file) =>
                    void choose(async () => file, { type: "upload" })
                  }
                />
              </SourcePanel>
              <SourcePanel active={source === "link"}>
                <LinkSource
                  active={source === "link"}
                  disabled={busy}
                  onUrl={(url) =>
                    void choose(
                      async () => {
                        const fetched = await fetchIconSource({
                          data: { url },
                        })
                        return base64ToBlob(
                          fetched.contentBase64,
                          fetched.contentType
                        )
                      },
                      { type: "url", url }
                    )
                  }
                />
              </SourcePanel>
              {files &&
              (subject.kind === "server" || subject.kind === "app") ? (
                <SourcePanel active={source === "files"}>
                  <FilesSource
                    active={source === "files"}
                    disabled={busy}
                    files={files}
                    kind={subject.kind}
                    onFile={(path, service) => void preview(path, service)}
                  >
                    <DetectionStatus
                      details={details.data}
                      subject={subject}
                      onDetected={refresh}
                    />
                  </FilesSource>
                </SourcePanel>
              ) : null}
              {subject.kind === "user" ? (
                <SourcePanel active={source === "minecraft"}>
                  <MinecraftSource
                    active={source === "minecraft"}
                    defaultUsername={minecraftUsername ?? ""}
                    disabled={busy}
                    onUsername={(username) =>
                      void choose(
                        async () => {
                          const head = await fetchMinecraftHead({
                            data: { username },
                          })
                          return base64ToBlob(
                            head.contentBase64,
                            head.contentType
                          )
                        },
                        { type: "minecraft", username }
                      )
                    }
                  />
                </SourcePanel>
              ) : null}
            </div>
            {/* Room for one line is kept, so an error doesn't move anything. */}
            <p
              className="type-meta min-h-[1lh] truncate text-destructive"
              role="alert"
              title={error ?? undefined}
            >
              {error}
            </p>
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
              ) : noun === "picture" ? (
                <Trash2 />
              ) : (
                // Only Hearth's copy goes, never a file it came from.
                <RotateCcw />
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
  minecraft,
  onChange,
  value,
}: {
  files: boolean
  minecraft: boolean
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
    ...(minecraft
      ? [{ icon: Pickaxe, label: "Minecraft", value: "minecraft" as const }]
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

// A source's controls, kept in place but hidden and unreachable while
// another source is chosen.
function SourcePanel({
  active,
  children,
}: {
  active: boolean
  children: React.ReactNode
}) {
  return (
    <div
      aria-hidden={!active}
      className={cn("flex min-w-0 flex-col", !active && "invisible")}
      inert={!active}
    >
      {children}
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
        "flex min-h-32 flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-4 text-center transition-colors",
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
  active,
  disabled,
  onUrl,
}: {
  active: boolean
  disabled: boolean
  onUrl: (url: string) => void
}) {
  const [url, setUrl] = React.useState("")
  const input = useFocusWhenActive(active)
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
          ref={input}
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

function MinecraftSource({
  active,
  defaultUsername,
  disabled,
  onUsername,
}: {
  active: boolean
  defaultUsername: string
  disabled: boolean
  onUsername: (username: string) => void
}) {
  const [username, setUsername] = React.useState(defaultUsername)
  const input = useFocusWhenActive(active)
  const value = username.trim()
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (value) onUsername(value)
      }}
    >
      <label
        htmlFor="icon-minecraft"
        className="type-label text-muted-foreground"
      >
        Minecraft username
      </label>
      <div className="flex gap-2">
        <Input
          id="icon-minecraft"
          autoComplete="off"
          spellCheck={false}
          maxLength={16}
          placeholder="Notch"
          value={username}
          disabled={disabled}
          onChange={(event) => setUsername(event.target.value)}
          ref={input}
        />
        <Button type="submit" variant="outline" disabled={disabled || !value}>
          Get
        </Button>
      </div>
      <p className="type-meta text-muted-foreground">
        Uses that player's head. Kiln keeps a copy, so it stays if their skin
        changes.
      </p>
    </form>
  )
}

const APP_FILES = "__files__"

function FilesSource({
  active,
  children,
  disabled,
  files,
  kind,
  onFile,
}: {
  active: boolean
  /** Below the form, such as what Kiln found by itself. */
  children?: React.ReactNode
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
  const input = useFocusWhenActive(active)
  const value = path.trim()
  return (
    <form
      className="flex flex-1 flex-col gap-2"
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
          ref={input}
        />
        <Button type="submit" variant="outline" disabled={disabled || !value}>
          Load
        </Button>
      </div>
      {/* Two lines kept, whichever explanation shows. */}
      <p className="type-meta min-h-[2lh] text-muted-foreground">
        {inContainer
          ? "In the running container. The icon follows the file as it changes."
          : kind === "server"
            ? "In the server's folder, as in Files. The icon follows the file as it changes."
            : "In the app's folder, as in Files. The icon follows the file as it changes."}
      </p>
      {children ? <div className="mt-auto pt-1">{children}</div> : null}
    </form>
  )
}

// Focuses a source's field when its tab is chosen, not when the dialog
// opens on another one.
function useFocusWhenActive(active: boolean) {
  const input = React.useRef<HTMLInputElement>(null)
  const wasActive = React.useRef(active)
  React.useEffect(() => {
    if (active && !wasActive.current) input.current?.focus()
    wasActive.current = active
  }, [active])
  return input
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
      ? `Kiln checks ${SERVER_ICON_PATH} on its own`
      : "Kiln checks the app's domains on its own"
  return (
    <div className="flex items-center gap-2 border-t pt-2.5 text-[0.8125rem]">
      <p className="min-w-0 flex-1 truncate text-muted-foreground">
        <span className="text-foreground">
          {found ? `Found ${originLabel(found)}` : "Nothing found"}
        </span>
        {" · "}
        {detected ? `checked ${relativeTime(detected.checkedAt)}` : looksFor}
      </p>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="shrink-0"
        disabled={detect.isPending}
        title={found && details?.custom ? "Your own icon is shown instead" : looksFor}
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
    if (origin?.type === "file") {
      return details.custom.digest
        ? `Follows ${fileLabel(origin)}`
        : `${fileLabel(origin)} is gone, so the icon fell back`
    }
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
    case "minecraft":
      return `${origin.username}'s Minecraft head`
    case "file":
      return `in ${fileLabel(origin)}`
  }
}

function fileLabel(origin: Extract<IconOrigin, { type: "file" }>): string {
  return origin.service ? `${origin.service}: ${origin.path}` : origin.path
}

function candidatePreview(candidate: Candidate): string {
  return candidate.kind === "link"
    ? candidate.previewUrl
    : candidate.icon.previewUrl
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
