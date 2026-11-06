import * as React from "react"
import { Effect } from "effect"
import {
  Check,
  Copy,
  ExternalLink,
  FileCode2,
  LoaderCircle,
  Share2,
  TriangleAlert,
  WrapText,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"
import { loadSyntaxCodeEditorModule } from "@/lib/syntax-editor-module-preload"

const SyntaxCodeEditor = React.lazy(async () => {
  const module = await loadSyntaxCodeEditorModule()
  return { default: module.SyntaxCodeEditor }
})

const ignoreEditorChange = () => undefined
const ignoreSearchOpenChange = () => undefined

type FeedbackState = "idle" | "pending" | "success" | "error"

// A code document in a dialog: a Brick recipe to read, or an app's
// Dockerfile or Compose file to edit. Editing adds the page's own actions,
// such as Save, in a footer below the document.
export function CodeDocumentPanel({
  className,
  content,
  edit,
  cursorAt,
  footer,
  languagePath,
  noun,
  onShare,
  sourceLabel,
  sourceUrl,
  title,
  wrapPreference,
}: {
  className?: string
  content: string
  // Where the cursor opens, such as at a definition being looked for.
  cursorAt?: number | undefined
  edit?: {
    // The saved content, which changes are marked against.
    original: string
    placeholder?: string
    onChange: (content: string) => void
  }
  // Buttons from the page, below the document.
  footer?: React.ReactNode
  languagePath: string
  // Lowercase, as in "Copy recipe".
  noun: string
  onShare?: (content: string) => Promise<string>
  // What the source link says; "View <noun> URL" when left out.
  sourceLabel?: string
  sourceUrl?: string | null
  title: string
  // Keeps line wrapping between visits, for documents that want it to.
  wrapPreference?: { read: () => boolean; write: (wrapLines: boolean) => void }
}) {
  const [copyState, setCopyState] = React.useState<FeedbackState>("idle")
  const [shareState, setShareState] = React.useState<FeedbackState>("idle")
  const [wrapLines, setWrapLines] = React.useState(
    () => wrapPreference?.read() ?? !edit
  )
  const copyResetTimer = React.useRef<number | null>(null)
  const shareResetTimer = React.useRef<number | null>(null)

  React.useEffect(
    () => () => {
      if (copyResetTimer.current) window.clearTimeout(copyResetTimer.current)
      if (shareResetTimer.current) window.clearTimeout(shareResetTimer.current)
    },
    []
  )

  async function copyContents() {
    setCopyState("pending")
    const copied = await copyText(content)
    setCopyState(copied ? "success" : "error")
    if (copyResetTimer.current) window.clearTimeout(copyResetTimer.current)
    copyResetTimer.current = window.setTimeout(() => setCopyState("idle"), 1800)
  }

  async function shareContents() {
    if (!onShare) return
    setShareState("pending")
    const shared = await Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          const url = await onShare(content)
          const copied = await copyText(url)
          if (!copied) throw new Error("Could not copy the share URL")
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.match({
          onFailure: () => false,
          onSuccess: () => true,
        })
      )
    )
    setShareState(shared ? "success" : "error")
    if (shareResetTimer.current) window.clearTimeout(shareResetTimer.current)
    shareResetTimer.current = window.setTimeout(
      () => setShareState("idle"),
      2800
    )
  }

  function toggleWrapLines() {
    setWrapLines(!wrapLines)
    wrapPreference?.write(!wrapLines)
  }

  return (
    <section
      className={cn(
        "flex h-[min(72dvh,42rem)] min-h-80 min-w-0 flex-col overflow-hidden bg-card",
        className
      )}
    >
      <div className="flex min-h-14 shrink-0 items-center gap-2 border-b px-3 py-2 pr-12 sm:gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <FileCode2 className="size-5 shrink-0 text-primary-ink" />
          <p className="truncate text-sm font-semibold">{title}</p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {onShare ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant={
                    shareState === "success"
                      ? "secondary"
                      : shareState === "error"
                        ? "destructive"
                        : "ghost"
                  }
                  disabled={shareState === "pending"}
                  aria-label={`Share ${noun} and copy link`}
                  onClick={() => void shareContents()}
                >
                  {shareState === "pending" ? (
                    <LoaderCircle className="animate-spin" />
                  ) : shareState === "success" ? (
                    <Check />
                  ) : shareState === "error" ? (
                    <TriangleAlert />
                  ) : (
                    <Share2 />
                  )}
                  <span className="hidden sm:inline">
                    {shareState === "pending"
                      ? "Sharing"
                      : shareState === "success"
                        ? "Link copied"
                        : shareState === "error"
                          ? "Try again"
                          : "Share"}
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {shareState === "success"
                  ? "Share link copied"
                  : shareState === "error"
                    ? `Could not share ${noun}`
                    : `Share ${noun}`}
              </TooltipContent>
            </Tooltip>
          ) : null}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant={
                  copyState === "success"
                    ? "secondary"
                    : copyState === "error"
                      ? "destructive"
                      : "ghost"
                }
                disabled={copyState === "pending"}
                aria-label={`Copy ${noun}`}
                onClick={() => void copyContents()}
              >
                {copyState === "success" ? <Check /> : <Copy />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {copyState === "success"
                ? `${capitalized(noun)} copied`
                : copyState === "error"
                  ? `Could not copy ${noun}`
                  : `Copy ${noun}`}
            </TooltipContent>
          </Tooltip>

          {sourceUrl ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild size="icon-sm" variant="ghost">
                  <a
                    href={sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={sourceLabel ?? `View ${noun} URL`}
                  >
                    <ExternalLink />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {sourceLabel ?? `View ${noun} URL`}
              </TooltipContent>
            </Tooltip>
          ) : null}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant={wrapLines ? "secondary" : "ghost"}
                aria-label={
                  wrapLines ? "Disable line wrapping" : "Enable line wrapping"
                }
                aria-pressed={wrapLines}
                onClick={toggleWrapLines}
              >
                <WrapText />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {wrapLines ? "Disable line wrapping" : "Enable line wrapping"}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <React.Suspense fallback={<CodeViewerLoadingState />}>
          <SyntaxCodeEditor
            ariaLabel={edit ? `Edit ${title}` : `View ${title}`}
            disabled={false}
            fontSize={edit ? 13 : 12}
            cursorAt={cursorAt}
            onChange={edit?.onChange ?? ignoreEditorChange}
            onSearchOpenChange={ignoreSearchOpenChange}
            originalValue={edit?.original ?? content}
            path={languagePath}
            placeholder={edit?.placeholder}
            redactSensitive={false}
            readOnly={!edit}
            searchOpen={false}
            searchQuery=""
            showChanges={false}
            value={content}
            wrapLines={wrapLines}
          />
        </React.Suspense>
      </div>

      {footer ? (
        <div className="flex shrink-0 justify-end gap-2 border-t px-3 py-2">
          {footer}
        </div>
      ) : null}
    </section>
  )
}

function CodeViewerLoadingState() {
  return (
    <div
      className="flex h-full min-h-0 min-w-0 bg-card"
      aria-label="Opening the editor"
      aria-busy="true"
    >
      <div
        className="w-12 shrink-0 border-r border-border/80 bg-muted/10"
        aria-hidden="true"
      />
      <div className="grid min-w-0 flex-1 place-items-center text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" />
      </div>
    </div>
  )
}

async function copyText(value: string) {
  return Effect.runPromise(
    Effect.tryPromise({
      try: () => navigator.clipboard.writeText(value),
      catch: (cause) => cause,
    }).pipe(
      Effect.as(true),
      Effect.catch(() =>
        Effect.try({
          try: () => {
            const textarea = document.createElement("textarea")
            textarea.value = value
            textarea.style.position = "fixed"
            textarea.style.opacity = "0"
            document.body.append(textarea)
            textarea.select()
            const copied = document.execCommand("copy")
            textarea.remove()
            return copied
          },
          catch: () => false,
        })
      )
    )
  )
}

function capitalized(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`
}
