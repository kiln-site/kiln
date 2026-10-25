import type * as React from "react"

import { cn } from "@workspace/ui/lib/utils"

export function WorkspaceFrame({
  children,
  header,
  surfaceClassName,
}: {
  children: React.ReactNode
  header: React.ReactNode
  surfaceClassName?: string
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {header}
      <div
        data-slot="workspace-surface"
        className={cn(
          // Phones use the full width; the surface keeps its top edge.
          "relative isolate mx-2 mt-2 flex min-h-0 flex-1 overflow-hidden border border-border/80 bg-card/30 max-md:mx-0 max-md:border-x-0",
          surfaceClassName
        )}
      >
        {children}
      </div>
    </div>
  )
}
