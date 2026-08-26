import * as React from "react"
import { LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

export function FileWorkspaceLoadingState({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="max-w-xs" role="status" aria-live="polite">
      <div className="mx-auto mb-4 grid size-11 place-items-center rounded-xl border bg-muted/20 text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin text-primary" />
      </div>
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        {description}
      </p>
    </div>
  )
}

export function FileTreeLoadingPanel({
  collapsed,
  width,
}: {
  collapsed: boolean
  width: number | null
}) {
  if (collapsed) {
    return (
      <div
        className="hidden w-0 shrink-0 md:block"
        data-file-tree-loading-panel
        aria-hidden="true"
      />
    )
  }

  return (
    <div
      className="hidden h-full min-h-0 w-[var(--file-tree-width)] max-w-[45%] min-w-56 shrink-0 flex-col border-r border-border/80 bg-card md:flex md:[--file-tree-width:17.5rem] xl:max-w-[30rem] xl:[--file-tree-width:19rem]"
      style={
        width
          ? ({ "--file-tree-width": `${width}px` } as React.CSSProperties)
          : undefined
      }
      data-file-tree-loading-panel
      aria-hidden="true"
    >
      <div className="h-14 shrink-0 border-b" />
      <div className="min-h-0 flex-1 space-y-2 overflow-hidden px-3 py-3">
        {Array.from({ length: 48 }, (_, index) => (
          <div
            key={index}
            className="h-4 animate-pulse bg-muted/25"
            style={{ width: `${58 + ((index * 13) % 31)}%` }}
          />
        ))}
      </div>
    </div>
  )
}

export function FileTreeErrorPanel({
  collapsed,
  message,
  onRetry,
  retrying,
  width,
}: {
  collapsed: boolean
  message: string
  onRetry: () => void
  retrying: boolean
  width: number | null
}) {
  if (collapsed) {
    return (
      <div
        className="hidden w-0 shrink-0 md:block"
        data-file-tree-error-panel
        aria-hidden="true"
      />
    )
  }

  return (
    <aside
      className="hidden h-full min-h-0 w-[var(--file-tree-width)] max-w-[45%] min-w-56 shrink-0 flex-col border-r border-border/80 bg-card md:flex md:[--file-tree-width:17.5rem] xl:max-w-[30rem] xl:[--file-tree-width:19rem]"
      style={
        width
          ? ({ "--file-tree-width": `${width}px` } as React.CSSProperties)
          : undefined
      }
      data-file-tree-error-panel
      aria-label="File tree unavailable"
    >
      <div className="flex h-14 shrink-0 items-center justify-end border-b px-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={retrying ? "Retrying files" : "Refresh files"}
              disabled={retrying}
              onClick={onRetry}
            >
              <RefreshCw
                className={`size-[18px]${retrying ? " animate-spin" : ""}`}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {retrying ? "Retrying Files" : "Retry Loading Files"}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="grid min-h-0 flex-1 place-items-center px-5 text-center">
        <div className="max-w-52">
          <TriangleAlert className="mx-auto size-5 text-destructive" />
          <p className="mt-3 text-sm font-semibold">Could not load files</p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {message}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-4"
            disabled={retrying}
            onClick={onRetry}
          >
            <RefreshCw className={retrying ? "animate-spin" : undefined} />
            {retrying ? "Retrying…" : "Retry"}
          </Button>
        </div>
      </div>
    </aside>
  )
}
