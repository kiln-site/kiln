import * as React from "react"
import { GripVertical } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"

// Shared vertical resize grip for side panels (file tree, database tables) so
// every panel edge looks and responds the same.
export function PanelResizeHandle({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      className={cn(
        "group absolute inset-y-0 -right-1 z-40 w-2.5 cursor-col-resize touch-none items-center justify-center outline-none",
        className
      )}
      {...props}
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/80 transition-colors group-hover:bg-primary/55 group-focus-visible:bg-primary/75 group-data-[resizing=true]:bg-primary" />
      <span className="relative grid h-9 w-2.5 place-items-center overflow-hidden border border-primary/35 bg-background text-primary opacity-0 shadow-[0_0_14px_color-mix(in_oklch,var(--primary),transparent_70%)] transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[resizing=true]:opacity-100">
        <GripVertical className="size-2" />
      </span>
    </div>
  )
}
