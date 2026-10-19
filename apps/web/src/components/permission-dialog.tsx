import { useRef, type ReactNode } from "react"

import {
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { cn } from "@workspace/ui/lib/utils"

/**
 * A dialog sized for the permission editor. Its height is fixed, so typing,
 * hovering suggestions, or adding entries never resizes or recenters it; the
 * editor's panes scroll inside.
 */
export function PermissionDialogContent({
  title,
  description,
  header,
  footer,
  children,
  className,
}: {
  title: ReactNode
  description: ReactNode
  /** Replaces the visible title block; the title stays for screen readers. */
  header?: ReactNode
  footer?: ReactNode
  children: ReactNode
  className?: string
}) {
  const headerRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  return (
    <DialogContent
      // Opening focuses the field marked for it, not the first button, which
      // could be an email that reveals itself on focus.
      initialFocus={() =>
        headerRef.current?.querySelector<HTMLElement>("[data-dialog-focus]") ??
        bodyRef.current?.querySelector<HTMLElement>("[data-dialog-focus]") ??
        true
      }
      className={cn(
        "flex h-[min(46rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden bg-[color-mix(in_oklab,var(--surface-overlay)_97%,transparent)] p-0 sm:max-w-6xl",
        className
      )}
    >
      <div ref={headerRef} className="shrink-0 border-b px-5 pt-4 pr-14 pb-3">
        <DialogTitle className={header ? "sr-only" : undefined}>
          {title}
        </DialogTitle>
        <DialogDescription className={header ? "sr-only" : "mt-1"}>
          {description}
        </DialogDescription>
        {header}
      </div>
      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
        {children}
      </div>
      {footer ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t bg-background/35 px-5 py-3">
          {footer}
        </div>
      ) : null}
    </DialogContent>
  )
}
