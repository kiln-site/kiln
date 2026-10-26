import * as React from "react"
import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "@workspace/ui/lib/utils"

/**
 * A stretch of the track to mark, such as values that won't fit. Values
 * past either end are taken to be that end.
 */
type SliderZone = { from: number; to: number }

/** A notch on the track, with a label on the axis under it. */
type SliderTick = { label?: string; value: number }

type SliderProps = Omit<
  React.ComponentProps<typeof SliderPrimitive.Root<number>>,
  "onValueChange"
> & {
  "aria-label": string
  /** Values to mark on the track, such as where it started. */
  marks?: ReadonlyArray<number>
  max: number
  min: number
  /** With what moved it: "keyboard", "drag", "track-press", and so on. */
  onValueChange?: (value: number, reason: string) => void
  ticks?: ReadonlyArray<SliderTick>
  /** What a screen reader says for a value, when the number isn't it. */
  valueText?: (value: number) => string
  zones?: ReadonlyArray<SliderZone>
}

function Slider({
  "aria-label": label,
  className,
  marks = [],
  max,
  min,
  onValueChange,
  ticks = [],
  valueText,
  zones = [],
  ...props
}: SliderProps) {
  const fraction = (value: number) =>
    max > min ? (Math.min(Math.max(value, min), max) - min) / (max - min) : 0
  const percent = (value: number) => `${fraction(value) * 100}%`
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn(
        "group relative w-full touch-none px-1.5 select-none",
        className
      )}
      max={max}
      min={min}
      onValueChange={(value, details) => onValueChange?.(value, details.reason)}
      {...props}
    >
      <SliderPrimitive.Control className="flex h-4 w-full cursor-pointer items-center data-[disabled]:cursor-default">
        <SliderPrimitive.Track className="relative h-1 w-full bg-muted-foreground/20">
          <SliderPrimitive.Indicator className="bg-primary" />
          {zones
            .filter((zone) => zone.from < max && zone.to > zone.from)
            .map((zone) => (
              <span
                key={`${zone.from}:${zone.to}`}
                aria-hidden="true"
                className="absolute inset-y-0 bg-destructive/70"
                style={{
                  left: percent(zone.from),
                  right: `calc(100% - ${percent(zone.to)})`,
                }}
              />
            ))}
          {ticks.map((tick) => (
            <span
              key={tick.value}
              aria-hidden="true"
              className="absolute top-full h-1 w-px -translate-x-1/2 bg-muted-foreground/45"
              style={{ left: percent(tick.value) }}
            />
          ))}
          {marks.map((mark) => (
            <span
              key={mark}
              aria-hidden="true"
              className="absolute -top-1 h-3 w-0.5 -translate-x-1/2 bg-foreground/55"
              style={{ left: percent(mark) }}
            />
          ))}
          <SliderPrimitive.Thumb
            aria-label={label}
            getAriaValueText={
              valueText ? (_formatted, value) => valueText(value) : undefined
            }
            className="size-3.5 border-2 border-background bg-primary shadow-sm ring-1 ring-primary outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
      {ticks.some((tick) => tick.label) ? (
        <div aria-hidden="true" className="relative mt-1 h-3.5">
          {ticks.map((tick) =>
            tick.label ? (
              <span
                key={tick.value}
                className={cn(
                  "absolute top-0 font-mono text-[0.625rem] leading-none whitespace-nowrap text-muted-foreground tabular-nums",
                  fraction(tick.value) < 0.04
                    ? "translate-x-0"
                    : fraction(tick.value) > 0.96
                      ? "-translate-x-full"
                      : "-translate-x-1/2"
                )}
                style={{ left: percent(tick.value) }}
              >
                {tick.label}
              </span>
            ) : null
          )}
        </div>
      ) : null}
    </SliderPrimitive.Root>
  )
}

export { Slider }
export type { SliderTick, SliderZone }
