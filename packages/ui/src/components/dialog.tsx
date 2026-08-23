"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { XIcon } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

const nestedFloatingSelector = [
  "[data-slot=select-content]",
  "[data-slot=popover-content]",
  "[data-slot=combobox-content]",
  "[data-radix-popper-content-wrapper]",
].join(",")

function Dialog({ onOpenChange, ...props }: DialogPrimitive.Root.Props) {
  return (
    <DialogPrimitive.Root
      data-slot="dialog"
      {...props}
      onOpenChange={(open, eventDetails) => {
        if (!open && shouldKeepDialogOpen(eventDetails)) {
          eventDetails.cancel()
          return
        }
        onOpenChange?.(open, eventDetails)
      }}
    />
  )
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/55 duration-150 supports-backdrop-filter:backdrop-blur-[2px] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  disableOpenAnimation = false,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  disableOpenAnimation?: boolean
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal>
      <DialogOverlay
        className={
          disableOpenAnimation
            ? "data-open:animate-none! data-open:duration-0!"
            : undefined
        }
      />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "type-body fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-5 overflow-y-auto rounded-xl border border-accent-border/25 bg-[color-mix(in_oklab,var(--surface-overlay)_70%,transparent)] p-5 text-popover-foreground shadow-2xl shadow-black/55 backdrop-blur-xl duration-150 outline-none sm:max-w-lg data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          disableOpenAnimation &&
            "data-open:animate-none! data-open:duration-0!",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="absolute top-3 right-3 text-muted-foreground hover:text-foreground"
              />
            }
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5 pr-8", className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-5 -mb-5 flex flex-col-reverse gap-2 rounded-b-xl border-t border-border/70 bg-background/35 px-5 py-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("type-dialog-title text-foreground", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("type-support text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}

function shouldKeepDialogOpen(
  eventDetails: DialogPrimitive.Root.ChangeEventDetails
): boolean {
  if (
    eventDetails.reason !== "outside-press" &&
    eventDetails.reason !== "focus-out" &&
    eventDetails.reason !== "escape-key"
  ) {
    return false
  }
  if (eventDetails.reason === "outside-press") {
    const path =
      typeof eventDetails.event.composedPath === "function"
        ? eventDetails.event.composedPath()
        : []
    if (
      path.some(
        (node) =>
          node instanceof Element && node.matches(nestedFloatingSelector)
      )
    ) {
      return true
    }
  }
  return document.querySelector(nestedFloatingSelector) !== null
}
