import * as React from "react"
import { HoverCard as HoverCardPrimitive } from "radix-ui"

import { cn } from "@workspace/ui/lib/utils"
import {
  floatingMotionClassName,
  floatingSurfaceClassName,
} from "@workspace/ui/lib/surface-styles"

function HoverCard({
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return <HoverCardPrimitive.Root data-slot="hover-card" {...props} />
}

function HoverCardTrigger({
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return (
    <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
  )
}

function HoverCardContent({
  className,
  children,
  align = "center",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal data-slot="hover-card-portal">
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          floatingSurfaceClassName,
          floatingMotionClassName,
          "type-body z-50 w-64 origin-(--radix-hover-card-content-transform-origin) rounded-lg p-2.5 ring-1 ring-accent-border/22 outline-hidden",
          className
        )}
        {...props}
      >
        {children}
        <HoverCardPrimitive.Arrow className="z-50 fill-[color-mix(in_oklab,var(--surface-overlay)_70%,transparent)] stroke-accent-border/30 [&>polygon]:[stroke-dasharray:0_30_36.1_0]" />
      </HoverCardPrimitive.Content>
    </HoverCardPrimitive.Portal>
  )
}

export { HoverCard, HoverCardTrigger, HoverCardContent }
