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
// such as Save, to the toolbar.
export function CodeDocumentPanel({
  actions,
  content,
  edit,
  languagePath,
  noun,
  onShare,
  sourceUrl,
  title,
}: {
  // Toolbar buttons from the page, before the panel's own.
  actions?: React.ReactNode
  content: string
  edit?: {
    // The saved content, which changes are marked against.
    original: string
    placeholder?: string
    onChange: (content: string) => void
  }
  languagePath: string
  // Lowercase, as in "Copy recipe".
  noun: string
  onShare?: (content: string) => Promise<string>
  sourceUrl?: string | null
  title: string
}) {
  const [copyState, setCopyState] = React.useState<FeedbackState>("idle")
  const [shareState, setShareState] = React.useState<FeedbackState>("idle")
  const [wrapLines, setWrapLines] = React.useState(!edit)
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

  return (
    <section className="flex h-[min(72dvh,42rem)] min-h-80 min-w-0 flex-col overflow-hidden bg-card">
      <div className="flex min-h-14 shrink-0 items-center gap-2 border-b px-3 py-2 pr-12 sm:gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <FileCode2 className="size-5 shrink-0 text-primary" />
          <p className="truncate text-sm font-semibold">{title}</p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {actions}
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
                    aria-label={`View ${noun} URL`}
                  >
                    <ExternalLink />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">View {noun} URL</TooltipContent>
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
                onClick={() => setWrapLines((current) => !current)}
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
