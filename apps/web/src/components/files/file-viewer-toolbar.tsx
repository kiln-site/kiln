import * as React from "react"
import { Effect } from "effect"
import { Check, Copy, FileCode2, Folder, FolderTree } from "lucide-react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

import { EditorTooltip } from "@/components/files/editor-tooltip"

export const fileEditorHeaderClassName =
  "flex h-14 shrink-0 border-b md:h-auto md:min-h-14"
export const fileEditorHeaderContentClassName =
  "flex min-w-0 flex-1 items-center gap-2 px-2 sm:px-3 md:flex-wrap md:gap-x-3 md:gap-y-2 md:py-[7px]"

function formatName(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path
}

export async function copyToClipboard(value: string) {
  await Effect.runPromise(
    Effect.tryPromise({
      try: () => navigator.clipboard.writeText(value),
      catch: (cause) => cause,
    }).pipe(
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
            if (!copied) throw new Error("Could not copy to clipboard")
          },
          catch: (cause) => cause,
        })
      )
    )
  )
}

export function FileTreeRevealButton({ onClick }: { onClick: () => void }) {
  return (
    <div
      className="hidden shrink-0 self-stretch border-r md:flex"
      style={{ width: "var(--file-editor-gutter-width, 3rem)" }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="grid size-full place-items-center text-primary transition-colors outline-none hover:bg-accent/45 hover:text-primary focus-visible:bg-accent/55 focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:ring-inset"
            aria-label="Open file tree"
            onClick={onClick}
          >
            <FolderTree className="size-[17px]" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={7}>
          Open File Tree
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

function FilePathCopyButton({ path }: { path: string }) {
  const [copyState, setCopyState] = React.useState<"idle" | "copied">("idle")
  const resetTimer = React.useRef<number | null>(null)
  const fullFilePath = `/data/${path.replace(/^\/+/, "")}`

  React.useEffect(
    () => () => {
      if (resetTimer.current) window.clearTimeout(resetTimer.current)
    },
    []
  )

  async function handleCopy() {
    await copyToClipboard(fullFilePath)
    setCopyState("copied")
    if (resetTimer.current) window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 1800)
  }

  return (
    <EditorTooltip
      content={copyState === "copied" ? "File Path Copied" : "Copy File Path"}
    >
      <button
        type="button"
        className="group/path flex max-w-full items-center gap-1 font-mono text-[0.625rem] text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:outline-none sm:text-[0.6875rem]"
        aria-label={
          copyState === "copied"
            ? `Copied ${fullFilePath}`
            : `Copy ${fullFilePath}`
        }
        onClick={handleCopy}
      >
        <span className="truncate">{fullFilePath}</span>
        {copyState === "copied" ? (
          <Check className="size-3.5 shrink-0 text-primary" />
        ) : (
          <Copy className="size-3.5 shrink-0 opacity-65 transition-opacity group-hover/path:opacity-100" />
        )}
      </button>
    </EditorTooltip>
  )
}

export const FileToolbarIdentity = React.memo(function FileToolbarIdentity({
  path,
  pathIsCopyable = true,
  readOnly = false,
  directory = false,
}: {
  path: string
  pathIsCopyable?: boolean
  readOnly?: boolean
  directory?: boolean
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5 md:gap-3">
      {directory ? (
        <Folder className="size-5 shrink-0 text-primary" />
      ) : (
        <FileCode2 className="size-5 shrink-0 text-primary" />
      )}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex min-w-0 items-center gap-2.5">
          <p className="min-w-0 truncate text-sm font-semibold">
            {formatName(path)}
          </p>
          {readOnly ? (
            <span className="hidden shrink-0 border border-primary/20 bg-primary/8 px-2 py-0.5 font-mono text-[0.5625rem] tracking-wider text-primary sm:inline-flex">
              READ ONLY
            </span>
          ) : null}
        </div>
        {pathIsCopyable ? (
          <FilePathCopyButton key={path} path={path} />
        ) : (
          <p className="truncate font-mono text-[0.625rem] text-muted-foreground sm:text-[0.6875rem]">
            /data/{path}
          </p>
        )}
      </div>
    </div>
  )
})
