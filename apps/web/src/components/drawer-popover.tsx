import * as React from "react"

import {
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
} from "@workspace/ui/components/drawer"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { useIsMobile } from "@workspace/ui/hooks/use-mobile"

// Whether the surrounding popover opens as a phone drawer, its trigger, and a
// callback for when its surface has finished closing; set by DrawerPopover,
// read by its trigger, its content, and what it shows.
const DrawerPopoverSurfaceContext = React.createContext<{
  closed: () => void
  drawer: boolean
  triggerRef: React.RefObject<HTMLElement | null>
}>({ closed: () => undefined, drawer: false, triggerRef: { current: null } })

/**
 * A popover that opens as a bottom drawer on phones. Use with
 * DrawerPopoverTrigger and DrawerPopoverContent.
 */
export function DrawerPopover({
  children,
  onOpenChange,
  open,
}: {
  children: React.ReactNode
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const isMobile = useIsMobile()
  const [drawer, setDrawer] = React.useState(isMobile)
  // Swap between popover and drawer only while closed, so rotating a phone
  // past the breakpoint keeps an open popover and what's in it. A closing one
  // waits until its surface has finished closing and handed focus back, even
  // if the breakpoint changes mid-close.
  const [closing, setClosing] = React.useState(false)
  const [wasOpen, setWasOpen] = React.useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    setClosing(!open)
  }
  const closed = React.useCallback(() => setClosing(false), [])
  const triggerRef = React.useRef<HTMLElement | null>(null)
  const refocusTrigger = React.useRef(false)
  React.useLayoutEffect(() => {
    if (open || closing || drawer === isMobile) return
    // Swapping rebuilds the trigger; keep focus on it if it had focus.
    const active = document.activeElement
    refocusTrigger.current =
      active !== null && triggerRef.current?.contains(active) === true
    setDrawer(isMobile)
  }, [closing, drawer, isMobile, open])
  React.useLayoutEffect(() => {
    if (!refocusTrigger.current) return
    refocusTrigger.current = false
    triggerRef.current?.focus({ preventScroll: true })
  }, [drawer])
  // In case a surface closes without reporting it.
  React.useEffect(() => {
    if (!closing) return
    const timeout = window.setTimeout(closed, 1000)
    return () => window.clearTimeout(timeout)
  }, [closed, closing])
  const surface = React.useMemo(
    () => ({ closed, drawer, triggerRef }),
    [closed, drawer]
  )
  const Root = drawer ? Drawer : Popover
  return (
    <DrawerPopoverSurfaceContext.Provider value={surface}>
      <Root open={open} onOpenChange={onOpenChange}>
        {children}
      </Root>
    </DrawerPopoverSurfaceContext.Provider>
  )
}

export function DrawerPopoverTrigger({
  ref,
  ...props
}: React.ComponentProps<typeof PopoverTrigger>) {
  const { drawer, triggerRef } = React.useContext(DrawerPopoverSurfaceContext)
  const setTrigger = React.useCallback(
    (node: HTMLButtonElement | null) => {
      triggerRef.current = node
      if (typeof ref === "function") ref(node)
      else if (ref) ref.current = node
    },
    [ref, triggerRef]
  )
  return drawer ? (
    <DrawerTrigger ref={setTrigger} {...props} />
  ) : (
    <PopoverTrigger ref={setTrigger} {...props} />
  )
}

/**
 * The popover's content on desktop. On phones the drawer ignores the popover's
 * placement and sizing, and `title` names it for screen readers.
 */
export function DrawerPopoverContent({
  children,
  onCloseAutoFocus,
  title,
  ...props
}: React.ComponentProps<typeof PopoverContent> & { title: string }) {
  const { closed, drawer } = React.useContext(DrawerPopoverSurfaceContext)
  // Runs once the surface has unmounted, just before focus returns to the
  // trigger unless the caller prevents it.
  const handleCloseAutoFocus = React.useCallback(
    (event: Event) => {
      onCloseAutoFocus?.(event)
      closed()
    },
    [closed, onCloseAutoFocus]
  )
  if (!drawer) {
    return (
      <PopoverContent onCloseAutoFocus={handleCloseAutoFocus} {...props}>
        {children}
      </PopoverContent>
    )
  }
  return (
    <DrawerContent onCloseAutoFocus={handleCloseAutoFocus}>
      <DrawerTitle className="sr-only">{title}</DrawerTitle>
      {children}
    </DrawerContent>
  )
}

/** Whether the surrounding DrawerPopover opens as a phone drawer. */
export function useDrawerPopoverIsDrawer() {
  return React.useContext(DrawerPopoverSurfaceContext).drawer
}
