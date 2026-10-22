"use client"

import * as React from "react"
import { Drawer as DrawerPrimitive } from "vaul"

import { cn } from "@workspace/ui/lib/utils"

// Vaul's own keyboard handling leaves the drawer behind the iOS keyboard;
// DrawerContent follows the visible screen instead.
function Drawer({
  repositionInputs = false,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  return (
    <DrawerPrimitive.Root
      data-slot="drawer"
      repositionInputs={repositionInputs}
      {...props}
    />
  )
}

function DrawerTrigger({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Trigger>) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />
}

function DrawerPortal({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Portal>) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />
}

function DrawerClose({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />
}

// Vaul fades the overlay and slides the content itself.
function DrawerOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Overlay>) {
  return (
    <DrawerPrimitive.Overlay
      data-slot="drawer-overlay"
      className={cn("fixed inset-0 z-50 bg-black/55", className)}
      {...props}
    />
  )
}

function DrawerContent({
  className,
  children,
  onOpenAutoFocus,
  ref,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Content>) {
  // Vaul merges refs without passing on a ref callback's cleanup, so React
  // never runs it; stop following the keyboard here when the node goes away.
  const stopFollowing = React.useRef<(() => void) | undefined>(undefined)
  const contentRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      stopFollowing.current?.()
      stopFollowing.current = node ? followKeyboard(node) : undefined
      if (typeof ref === "function") ref(node)
      else if (ref) ref.current = node
    },
    [ref]
  )

  return (
    <DrawerPortal>
      <DrawerOverlay />
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        className={cn(
          "group/drawer-content fixed z-50 flex h-auto flex-col border-accent-border/22 bg-[color-mix(in_oklab,var(--surface-overlay)_92%,transparent)] text-popover-foreground shadow-2xl shadow-black/55 backdrop-blur-xl outline-none",
          "data-[vaul-drawer-direction=bottom]:inset-x-0 data-[vaul-drawer-direction=bottom]:bottom-0 data-[vaul-drawer-direction=bottom]:max-h-[75dvh] data-[vaul-drawer-direction=bottom]:rounded-t-xl data-[vaul-drawer-direction=bottom]:border-t",
          "data-[vaul-drawer-direction=top]:inset-x-0 data-[vaul-drawer-direction=top]:top-0 data-[vaul-drawer-direction=top]:max-h-[86dvh] data-[vaul-drawer-direction=top]:rounded-b-xl data-[vaul-drawer-direction=top]:border-b",
          "data-[vaul-drawer-direction=left]:inset-y-0 data-[vaul-drawer-direction=left]:left-0 data-[vaul-drawer-direction=left]:w-3/4 data-[vaul-drawer-direction=left]:border-r data-[vaul-drawer-direction=left]:sm:max-w-sm",
          "data-[vaul-drawer-direction=right]:inset-y-0 data-[vaul-drawer-direction=right]:right-0 data-[vaul-drawer-direction=right]:w-3/4 data-[vaul-drawer-direction=right]:border-l data-[vaul-drawer-direction=right]:sm:max-w-sm",
          className
        )}
        {...props}
        ref={contentRef}
        onOpenAutoFocus={(event) => {
          onOpenAutoFocus?.(event)
          if (event.defaultPrevented) return
          // Vaul leaves focus on the trigger behind the drawer. Focus the
          // drawer itself so keyboard and screen reader users land in it,
          // without focusing a field that would open a phone's keyboard.
          event.preventDefault()
          if (event.target instanceof HTMLElement) {
            event.target.focus({ preventScroll: true })
          }
        }}
      >
        <div
          aria-hidden="true"
          className="mx-auto mt-2.5 mb-1 hidden h-1.5 w-12 shrink-0 rounded-full bg-muted-foreground/35 group-data-[vaul-drawer-direction=bottom]/drawer-content:block"
        />
        {children}
      </DrawerPrimitive.Content>
    </DrawerPortal>
  )
}

// Keeps a bottom drawer inside the part of the screen the on-screen keyboard
// leaves visible: its bottom sits on the keyboard and its top stays on screen.
// Writes styles directly so the keyboard doesn't render React. Returns a
// cleanup.
function followKeyboard(content: HTMLDivElement) {
  const viewport = window.visualViewport
  if (!viewport) return undefined
  let request: number | null = null
  const update = () => {
    request = null
    if (content.dataset.vaulDrawerDirection !== "bottom") return
    // Pinch zoom also shrinks the visible area; only follow the keyboard.
    if (viewport.scale > 1.01) return
    // Fixed elements sit on the layout viewport; the overlay covers all of it.
    const overlay = document.querySelector('[data-slot="drawer-overlay"]')
    const screenBottom =
      overlay?.getBoundingClientRect().bottom ??
      document.documentElement.clientHeight
    const visibleBottom = viewport.offsetTop + viewport.height
    const below = Math.max(0, Math.round(screenBottom - visibleBottom))
    content.style.bottom = below > 0 ? `${below}px` : ""
    // Safari may scroll the page up to reveal the focused field instead, so
    // always fit the visible height to keep the drawer's top on screen.
    content.style.maxHeight = `min(75dvh, ${Math.round(viewport.height - 16)}px)`
  }
  const schedule = () => {
    request ??= requestAnimationFrame(update)
  }
  update()
  viewport.addEventListener("resize", schedule)
  viewport.addEventListener("scroll", schedule)
  return () => {
    viewport.removeEventListener("resize", schedule)
    viewport.removeEventListener("scroll", schedule)
    if (request !== null) cancelAnimationFrame(request)
  }
}

function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-header"
      className={cn("flex flex-col gap-0.5 p-4", className)}
      {...props}
    />
  )
}

function DrawerFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  )
}

function DrawerTitle({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn("type-section-title text-foreground", className)}
      {...props}
    />
  )
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn("type-support text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerOverlay,
  DrawerPortal,
  DrawerTitle,
  DrawerTrigger,
}
