"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@workspace/ui/lib/utils"
import {
  floatingMotionClassName,
  floatingSurfaceClassName,
} from "@workspace/ui/lib/surface-styles"

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

// Safari on macOS doesn't match :focus-visible when focus comes from outside
// the page, so there the last input decides, as Base UI's tooltips do.
const isMacSafari =
  typeof navigator !== "undefined" &&
  navigator.platform.toLowerCase().startsWith("mac") &&
  navigator.maxTouchPoints <= 1 &&
  CSS.supports("-webkit-backdrop-filter:none")
let lastInputWasKeyboard = true
if (isMacSafari) {
  window.addEventListener(
    "keydown",
    () => {
      lastInputWasKeyboard = true
    },
    true
  )
  window.addEventListener(
    "pointerdown",
    () => {
      lastInputWasKeyboard = false
    },
    true
  )
}

function isKeyboardFocus(event: React.FocusEvent<HTMLElement>) {
  if (isMacSafari && !event.relatedTarget) return lastInputWasKeyboard
  return event.currentTarget.matches(":focus-visible")
}

function TooltipTrigger({
  onFocus,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      onFocus={(event) => {
        onFocus?.(event)
        // Radix opens on any focus, so a dialog or menu handing focus back to
        // its trigger after a click left the tooltip stuck open. Only keyboard
        // focus should open it.
        if (!isKeyboardFocus(event)) {
          event.preventDefault()
        }
      }}
      {...props}
    />
  )
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          floatingSurfaceClassName,
          floatingMotionClassName,
          "type-label z-50 inline-flex w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin) items-center gap-1.5 rounded-md px-2.5 py-1.5 ring-1 ring-accent-border/22 has-data-[slot=kbd]:pr-1.5 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 fill-[color-mix(in_oklab,var(--surface-overlay)_70%,transparent)] stroke-accent-border/30 [&>polygon]:[stroke-dasharray:0_30_36.1_0]" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
