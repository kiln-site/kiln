import * as React from "react"

import {
  DrawerPopover,
  DrawerPopoverContent,
  DrawerPopoverTrigger,
  useDrawerPopoverIsDrawer,
} from "@/components/drawer-popover"

// A small editor that opens from a chip or tile: a popover on desktop, a
// bottom drawer on phones. It keeps its own open state.
export function CreatorPopover({
  align = "start",
  children,
  className,
  onOpenChange,
  title,
  trigger,
}: {
  align?: "start" | "center" | "end"
  children: React.ReactNode
  className?: string
  onOpenChange?: (open: boolean) => void
  // Names the phone drawer for screen readers.
  title: string
  trigger: React.ReactElement
}) {
  const [open, setOpen] = React.useState(false)
  const change = React.useCallback(
    (next: boolean) => {
      setOpen(next)
      onOpenChange?.(next)
    },
    [onOpenChange]
  )
  return (
    <DrawerPopover open={open} onOpenChange={change}>
      <DrawerPopoverTrigger asChild>{trigger}</DrawerPopoverTrigger>
      <DrawerPopoverContent
        align={align}
        className={className}
        sideOffset={6}
        title={title}
      >
        <Body>{children}</Body>
      </DrawerPopoverContent>
    </DrawerPopover>
  )
}

function Body({ children }: { children: React.ReactNode }) {
  const drawer = useDrawerPopoverIsDrawer()
  if (!drawer) return children
  return (
    <div className="flex min-h-0 flex-col overflow-y-auto px-4 pt-1 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
      {children}
    </div>
  )
}

// Whether the surrounding CreatorPopover is open as a phone drawer, so a
// field inside can skip grabbing focus and raising the keyboard.
export const useCreatorPopoverIsDrawer = useDrawerPopoverIsDrawer
