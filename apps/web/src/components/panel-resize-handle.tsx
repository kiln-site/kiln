import * as React from "react"
import { GripHorizontal, GripVertical } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"

// Shared resize grip for panels (file tree, database tables, query results) so
// every panel edge looks and responds the same. "vertical" sits on a panel's
// right edge; "horizontal" sits on its bottom edge.
export function PanelResizeHandle({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<"div"> & { orientation?: "horizontal" | "vertical" }) {
  const vertical = orientation === "vertical"
  const Grip = vertical ? GripVertical : GripHorizontal
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={orientation}
      className={cn(
        "group absolute z-40 touch-none items-center justify-center outline-none",
        vertical
          ? "inset-y-0 -right-1 w-2.5 cursor-col-resize"
          : "inset-x-0 -bottom-1 h-2.5 cursor-row-resize",
        className
      )}
      {...props}
    >
      <span
        className={cn(
          "absolute bg-border/80 transition-colors group-hover:bg-primary/55 group-focus-visible:bg-primary/75 group-data-[resizing=true]:bg-primary",
          vertical
            ? "inset-y-0 left-1/2 w-px -translate-x-1/2"
            : "inset-x-0 top-1/2 h-px -translate-y-1/2"
        )}
      />
      <span
        className={cn(
          "relative grid place-items-center overflow-hidden border border-primary/35 bg-background text-primary opacity-0 shadow-[0_0_14px_color-mix(in_oklch,var(--primary),transparent_70%)] transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[resizing=true]:opacity-100",
          vertical ? "h-9 w-2.5" : "h-2.5 w-9"
        )}
      >
        <Grip className="size-2" />
      </span>
    </div>
  )
}
