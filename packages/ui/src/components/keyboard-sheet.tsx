"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cn } from "@workspace/ui/lib/utils"

// A phone replacement for a searchable popover. The panel sits at the bottom
// of the visible screen, directly above the on-screen keyboard, so a search
// field placed last stays next to the keys. Long lists keep their top edge in
// place and only grow down when the keyboard closes; the strip above stays
// free to tap the sheet closed.

function KeyboardSheet({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="keyboard-sheet" {...props} />
}

function KeyboardSheetTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return (
    <DialogPrimitive.Trigger data-slot="keyboard-sheet-trigger" {...props} />
  )
}

function KeyboardSheetContent({
  children,
  className,
  title,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  /** Read by screen readers when the sheet opens. */
  title: string
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        data-slot="keyboard-sheet-overlay"
        className="fixed inset-0 z-50 bg-black/55 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
      />
      {/* Follows the visible part of the screen, which shrinks while the
          keyboard is open. Taps on its empty top area reach the overlay. */}
      <div
        ref={followVisualViewport}
        data-slot="keyboard-sheet-frame"
        className="pointer-events-none fixed inset-x-0 top-0 z-50 flex h-dvh flex-col justify-end px-2 pt-[max(calc(env(safe-area-inset-top)+1rem),14dvh)] pb-[calc(env(safe-area-inset-bottom)+0.5rem)] data-[keyboard=open]:pb-2"
      >
        <DialogPrimitive.Content
          data-slot="keyboard-sheet-content"
          aria-describedby={undefined}
          className={cn(
            "pointer-events-auto mx-auto flex max-h-full min-h-0 w-full max-w-lg flex-col overflow-hidden rounded-xl border border-accent-border/22 bg-[color-mix(in_oklab,var(--surface-overlay)_86%,transparent)] text-popover-foreground shadow-2xl ring-1 shadow-black/55 ring-accent-border/18 backdrop-blur-xl outline-none data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-bottom-4 data-closed:animate-out data-closed:fade-out-0 data-closed:slide-out-to-bottom-4",
            className
          )}
          {...props}
        >
          <DialogPrimitive.Title className="sr-only">
            {title}
          </DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </div>
    </DialogPrimitive.Portal>
  )
}

// Writes the visual viewport's box onto the frame without rendering React.
// The frame mounts and unmounts with the open sheet, so this is a ref callback.
function followVisualViewport(frame: HTMLDivElement | null) {
  const viewport = window.visualViewport
  if (!frame || !viewport) return
  let request: number | null = null
  const update = () => {
    request = null
    // Pinch zoom also shrinks the visual viewport; only follow the keyboard.
    if (viewport.scale > 1.01) return
    frame.style.top = `${viewport.offsetTop}px`
    frame.style.height = `${viewport.height}px`
    frame.dataset.keyboard =
      window.innerHeight - viewport.height > 80 ? "open" : "closed"
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

export { KeyboardSheet, KeyboardSheetContent, KeyboardSheetTrigger }
