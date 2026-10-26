import type * as React from "react"
import type { LucideIcon } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { cn } from "@workspace/ui/lib/utils"

// The dialog each part of a Brick opens in. Changes apply as they're made,
// so the preview follows along and Done only closes it.
export function PanelDialog({
  children,
  className,
  description,
  footer,
  icon: Icon,
  onClose,
  open,
  title,
}: {
  children: React.ReactNode
  className?: string
  description?: React.ReactNode
  footer?: React.ReactNode
  icon?: LucideIcon
  onClose: () => void
  open: boolean
  title: React.ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className={cn("gap-4 sm:max-w-xl", className)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            {Icon ? (
              <span className="grid size-8 place-items-center border border-border bg-background text-primary-ink">
                <Icon className="size-4" />
              </span>
            ) : null}
            {title}
          </DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-4">{children}</div>
        <DialogFooter className="items-center">
          {footer}
          <Button onClick={onClose} className="sm:ml-auto">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// A titled group inside a dialog.
export function DialogGroup({
  action,
  children,
  title,
}: {
  action?: React.ReactNode
  children: React.ReactNode
  title: string
}) {
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="type-technical-label text-muted-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  )
}
