import * as React from "react"
import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "@workspace/ui/lib/utils"

/**
 * A stretch of the track to mark, such as values that won't fit. Values
 * past either end are taken to be that end.
 */
type SliderZone = { from: number; to: number }

type SliderProps = Omit<
  React.ComponentProps<typeof SliderPrimitive.Root<number>>,
  "onValueChange"
> & {
  "aria-label": string
  max: number
  min: number
  onValueChange?: (value: number) => void
  zones?: ReadonlyArray<SliderZone>
}

function Slider({
  "aria-label": label,
  className,
  max,
  min,
  onValueChange,
  zones = [],
  ...props
}: SliderProps) {
  const percent = (value: number) =>
    max > min
      ? `${((Math.min(Math.max(value, min), max) - min) / (max - min)) * 100}%`
      : "0%"
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn("relative w-full touch-none select-none", className)}
      max={max}
      min={min}
      thumbAlignment="edge"
      onValueChange={(value) => onValueChange?.(value)}
      {...props}
    >
      <SliderPrimitive.Control className="flex h-5 w-full items-center data-[disabled]:opacity-50">
        <SliderPrimitive.Track className="relative h-1.5 w-full bg-muted-foreground/20">
          {zones
            .filter((zone) => zone.from < max && zone.to > zone.from)
            .map((zone) => (
              <span
                key={`${zone.from}:${zone.to}`}
                aria-hidden="true"
                className="absolute inset-y-0 bg-destructive/35"
                style={{
                  left: percent(zone.from),
                  right: `calc(100% - ${percent(zone.to)})`,
                }}
              />
            ))}
          <SliderPrimitive.Indicator className="bg-primary" />
          <SliderPrimitive.Thumb
            aria-label={label}
            className="size-4 border-2 border-primary bg-background shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
export type { SliderZone }
