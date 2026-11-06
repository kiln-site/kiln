import * as React from "react"
import { Link, type LinkProps } from "@tanstack/react-router"
import { FolderOpen, Trash2 } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import { formatBytes } from "@/lib/format-bytes"

// What an App's and a Relay's volume tables have in common, so a volume
// reads and opens the same from both.

/**
 * Where a row's files open. Plain, since rows carry it and the router's own
 * types are too deep for a table's to hold.
 */
export interface VolumeLink {
  params: Readonly<Record<string, string>>
  search?: Readonly<Record<string, string>>
  to: string
}

/** A short fact beside a volume's name, such as who owns it. */
export const VolumeTag = React.forwardRef<
  HTMLSpanElement,
  React.ComponentPropsWithoutRef<"span">
>(function VolumeTag({ className, ...props }, ref) {
  return (
    <span
      ref={ref}
      className={cn(
        "flex min-w-0 shrink items-center gap-1 border bg-muted/30 px-1.5 py-0.5 text-[11px] whitespace-nowrap text-muted-foreground [&_svg]:size-3 [&_svg]:shrink-0",
        className
      )}
      {...props}
    />
  )
})

export function VolumeSize({ sizeBytes }: { sizeBytes: number | null }) {
  return sizeBytes === null ? (
    <span
      className="type-meta text-muted-foreground"
      title="Docker hasn't measured it yet"
    >
      —
    </span>
  ) : (
    <span className="type-meta tabular-nums">{formatBytes(sizeBytes)}</span>
  )
}

const volumeActionClassName = "text-muted-foreground hover:text-primary-ink"

/** A row action that does something here. */
export function VolumeAction({
  children,
  className,
  label,
  onClick,
  onWarm,
  tooltip,
}: {
  children: React.ReactNode
  className?: string
  label: string
  onClick: () => void
  // Loads what it opens, ahead of the click.
  onWarm?: () => void
  tooltip: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className={cn(volumeActionClassName, className)}
          size="icon-sm"
          type="button"
          variant="ghost"
          onClick={onClick}
          onFocus={onWarm}
          onPointerEnter={onWarm}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

/** A row action that goes somewhere else. */
export function VolumeActionLink({
  children,
  label,
  link,
  tooltip,
}: {
  children: React.ReactNode
  label: string
  link: VolumeLink
  tooltip: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          asChild
          className={volumeActionClassName}
          size="icon-sm"
          variant="ghost"
        >
          <Link aria-label={label} {...(link as LinkProps)}>
            {children}
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

/** A row action that can't be used, and says why. */
export function VolumeActionDisabled({
  children,
  label,
  tooltip,
}: {
  children: React.ReactNode
  label: string
  tooltip: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button gets no pointer events; its wrapper keeps the
            tooltip that says why. */}
        <span tabIndex={0} className="rounded-md outline-none">
          <Button
            aria-label={label}
            disabled
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

/** Deleting: red while it can be done, grey with why when it can't. */
export function VolumeDeleteAction({
  blocked,
  label,
  onClick,
  onWarm,
  tooltip,
}: {
  blocked: string | null
  label: string
  onClick: () => void
  onWarm?: () => void
  tooltip: string
}) {
  return blocked ? (
    <VolumeActionDisabled label={label} tooltip={blocked}>
      <Trash2 />
    </VolumeActionDisabled>
  ) : (
    <VolumeAction
      className="text-destructive hover:bg-destructive/10 hover:text-destructive light:hover:bg-destructive/20"
      label={label}
      tooltip={tooltip}
      onClick={onClick}
      onWarm={onWarm}
    >
      <Trash2 />
    </VolumeAction>
  )
}

/** An action a row doesn't have, holding its place so every row's line up. */
export const VolumeActionGap = () => (
  <span aria-hidden="true" className="size-7" />
)

/** The width of a table's column of four row actions. */
export const VOLUME_ACTIONS_WIDTH = "8.75rem"

/**
 * Opens what a row holds in Files. Null `link` says why it can't, in
 * `unavailable`; a row with nothing to open keeps its place.
 */
export function VolumeFilesButton({
  label,
  link,
  unavailable,
}: {
  label: string
  link: VolumeLink | null
  unavailable?: string | null
}) {
  if (link) {
    return (
      <VolumeActionLink label={label} link={link} tooltip="View files">
        <FolderOpen />
      </VolumeActionLink>
    )
  }
  if (unavailable) {
    return (
      <VolumeActionDisabled label={label} tooltip={unavailable}>
        <FolderOpen />
      </VolumeActionDisabled>
    )
  }
  return <VolumeActionGap />
}
