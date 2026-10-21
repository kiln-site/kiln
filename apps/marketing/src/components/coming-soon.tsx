import * as React from "react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

// Shows a link that isn't open yet: dimmed, out of reach, and saying
// "Coming soon" on hover, focus, or tap. Without `soon` it's the link as is,
// so the link stays written once and comes back by flipping its flag.
export function ComingSoon({
  children,
  className,
  label,
  soon,
}: {
  children: React.ReactNode
  className?: string
  // What the link is, for screen readers, for example "Docs".
  label: string
  soon: boolean
}) {
  const [open, setOpen] = React.useState(false)
  if (!soon) return children

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <span
          role="link"
          aria-disabled="true"
          aria-label={`${label}, coming soon`}
          tabIndex={0}
          className={cn(
            "inline-flex cursor-not-allowed opacity-45 outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            className
          )}
          // Touch has no hover, so a tap shows it. The tooltip closes on its
          // own click unless this one is marked handled.
          onClick={(event) => {
            event.preventDefault()
            setOpen(true)
          }}
        >
          <span inert className="contents">
            {children}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        Coming soon
      </TooltipContent>
    </Tooltip>
  )
}
