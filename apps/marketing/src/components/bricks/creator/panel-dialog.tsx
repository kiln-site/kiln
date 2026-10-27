import * as React from "react"
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
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@workspace/ui/components/drawer"
import { useIsMobile } from "@workspace/ui/hooks/use-mobile"
import { cn } from "@workspace/ui/lib/utils"

// Whether the host still shows its dialog; false while it animates out.
export const PanelOpenContext = React.createContext(true)

// The dialog each part of a Brick opens in: a dialog on desktop, a bottom
// drawer on phones. Changes apply as they're made, so the preview follows
// along and Done only closes it.
export function PanelDialog({
  children,
  className,
  description,
  footer,
  icon: Icon,
  onClose,
  title,
}: {
  children: React.ReactNode
  className?: string
  description?: React.ReactNode
  footer?: React.ReactNode
  icon?: LucideIcon
  onClose: () => void
  title: React.ReactNode
}) {
  const open = React.useContext(PanelOpenContext)
  const mobile = useIsMobile()
  const heading = (
    <span className="flex items-center gap-2.5">
      {Icon ? (
        <span className="grid size-7 shrink-0 place-items-center border border-border bg-background text-primary-ink">
          <Icon className="size-3.5" />
        </span>
      ) : null}
      <span className="min-w-0 truncate">{title}</span>
    </span>
  )

  if (mobile) {
    return (
      <Drawer open={open} onOpenChange={(next) => !next && onClose()}>
        <DrawerContent>
          <DrawerHeader className="pb-3 text-left">
            <DrawerTitle>{heading}</DrawerTitle>
            {description ? (
              <DrawerDescription>{description}</DrawerDescription>
            ) : null}
          </DrawerHeader>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-2">
            {children}
          </div>
          <DrawerFooter className="flex-row items-center border-t border-border/70 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {footer}
            <Button onClick={onClose} className="ml-auto">
              Done
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className={cn("gap-4 sm:max-w-xl", className)}>
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
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
      <div className="flex h-7 items-center justify-between gap-3">
        <h3 className="type-card-title">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  )
}
