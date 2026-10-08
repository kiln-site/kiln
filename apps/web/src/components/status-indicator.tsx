import * as React from "react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import type { IdentityStatusPresentation } from "@/components/identity-name"

export const StatusIndicator = React.memo(function StatusIndicator({
  status,
}: {
  status: IdentityStatusPresentation
}) {
  const tone = statusToneClasses[status.tone]
  const indicator = (
    <span
      aria-label={status.detail ?? status.label}
      className={cn(
        "type-label inline-flex items-center gap-1.5 whitespace-nowrap",
        tone.text
      )}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          tone.dot,
          status.pulse && "animate-pulse"
        )}
      />
      <span className="hidden sm:inline">{status.label}</span>
    </span>
  )
  if (!status.detail) return indicator
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="cursor-default outline-none">
          {indicator}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        <span className="max-w-64 text-muted-foreground">{status.detail}</span>
      </TooltipContent>
    </Tooltip>
  )
})

const statusToneClasses: Record<
  IdentityStatusPresentation["tone"],
  { dot: string; text: string }
> = {
  danger: { dot: "bg-destructive", text: "text-destructive" },
  info: { dot: "bg-sky-400", text: "text-sky-300" },
  neutral: {
    dot: "bg-muted-foreground/50",
    text: "text-muted-foreground",
  },
  success: { dot: "bg-emerald-400", text: "text-emerald-300" },
  warning: { dot: "bg-amber-400", text: "text-amber-300" },
}
