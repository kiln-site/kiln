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
  /** Values to tick on the track, such as where it started. */
  marks?: ReadonlyArray<number>
  max: number
  min: number
  onValueChange?: (value: number) => void
  zones?: ReadonlyArray<SliderZone>
}

function Slider({
  "aria-label": label,
  className,
  marks = [],
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
      className={cn("group relative w-full touch-none select-none", className)}
      max={max}
      min={min}
      thumbAlignment="edge"
      onValueChange={(value) => onValueChange?.(value)}
      {...props}
    >
      <SliderPrimitive.Control className="flex h-5 w-full cursor-pointer items-center data-[disabled]:cursor-default">
        <SliderPrimitive.Track className="relative h-1 w-full bg-muted-foreground/20">
          {zones
            .filter((zone) => zone.from < max && zone.to > zone.from)
            .map((zone) => (
              <span
                key={`${zone.from}:${zone.to}`}
                aria-hidden="true"
                className="absolute inset-y-0 bg-destructive/45"
                style={{
                  left: percent(zone.from),
                  right: `calc(100% - ${percent(zone.to)})`,
                }}
              />
            ))}
          <SliderPrimitive.Indicator className="bg-primary group-data-[disabled]:bg-transparent" />
          {marks
            .filter((mark) => mark >= min && mark <= max)
            .map((mark) => (
              <span
                key={mark}
                aria-hidden="true"
                className="absolute -top-1 h-3 w-px -translate-x-1/2 bg-foreground/45"
                style={{ left: percent(mark) }}
              />
            ))}
          <SliderPrimitive.Thumb
            aria-label={label}
            className="size-3.5 border-2 border-background bg-primary shadow-sm ring-1 ring-primary outline-none group-data-[disabled]:hidden focus-visible:ring-2 focus-visible:ring-ring/60"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
export type { SliderZone }
