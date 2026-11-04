import * as React from "react"

import { Input } from "@workspace/ui/components/input"
import { Slider } from "@workspace/ui/components/slider"
import { cn } from "@workspace/ui/lib/utils"

import {
  limitAxis,
  NO_LIMIT_POSITION,
  type LimitMove,
  type LimitScale,
} from "@/lib/resource-limit-axis"
import type { ResourceLimitDraft } from "@/lib/resource-limits"

export type ResourceLimitUnit = LimitScale & {
  label: string
  /** Shown units per stored unit, as percent per core. */
  scale: number
  /** What a screen reader says for the unit. */
  spoken: string
  unit: string
}

// One limit: its name, a slider, and the same value in a box to type into.
// Memoized, so dragging one slider renders only that row.
export const ResourceLimitSlider = React.memo(function ResourceLimitSlider({
  assignable,
  below,
  disabled,
  invalid,
  loading,
  onChange,
  original,
  unit,
  value,
}: {
  /** What the node can give, as the axis's end; null if unknown. */
  assignable: number | null
  /** A value the limit can't go under, shaded red, such as the files. */
  below: number | null
  disabled: boolean
  invalid: boolean
  /** Hides the slider until `assignable` arrives, so it doesn't jump. */
  loading: boolean
  onChange: (value: ResourceLimitDraft) => void
  /** The limit as saved, marked on the track; null for no limit. */
  original: number | null
  unit: ResourceLimitUnit
  value: ResourceLimitDraft
}) {
  const { label, min, scale, spoken } = unit
  const { current, shown } = limitValue(value, unit)
  const axis = limitAxis(unit, { assignable, original })
  const move = (to: LimitMove) => {
    if (to === "no-limit") onChange({ ...value, limited: false })
    else if (to !== null) {
      onChange({
        limited: true,
        value: String(Number((to / scale).toFixed(4))),
      })
    }
  }
  // A limit that isn't a number yet steps from the axis's start.
  const stepFrom = value.limited ? (current ?? min) : null
  const sliderAt = axis.sliderAt(value.limited, current)
  const changed = value.limited ? current !== original : original !== null

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_5.5rem] items-start gap-x-3 gap-y-1 sm:grid-cols-[5rem_minmax(0,1fr)_5.5rem]">
      <ResourceLimitName
        original={changed ? { value: original } : null}
        unit={unit}
      />
      <Slider
        aria-label={`${label} limit`}
        className={cn(
          "order-3 col-span-2 pt-1.5 transition-opacity sm:order-2 sm:col-span-1",
          loading && "opacity-0"
        )}
        disabled={disabled || loading}
        marks={[
          original === null ? NO_LIMIT_POSITION : axis.position(original),
        ]}
        max={NO_LIMIT_POSITION}
        min={0}
        step={1}
        ticks={[
          ...axis.ticks.map((tick) => ({
            label: formatAxis(tick.value, unit),
            value: tick.position,
          })),
          { label: "No limit", value: NO_LIMIT_POSITION },
        ]}
        value={sliderAt}
        valueText={() => spokenLimit(value.limited, shown, spoken)}
        zones={axis.zones(assignable, below)}
        onValueChange={(next, reason) =>
          move(
            axis.slide(next, {
              at: sliderAt,
              current: stepFrom,
              keyboard: reason === "keyboard",
            })
          )
        }
      />
      <ResourceLimitInput
        disabled={disabled}
        invalid={invalid}
        shown={shown}
        unit={unit}
        value={value}
        onChange={onChange}
        onNudge={(up) => move(axis.nudge(stepFrom, up))}
      />
    </div>
  )
})

// The limit's name, and what it was once changed.
function ResourceLimitName({
  original,
  unit,
}: {
  original: { value: number | null } | null
  unit: ResourceLimitUnit
}) {
  return (
    <div className="order-1 min-h-7 min-w-0">
      <span className="type-label flex h-7 items-center">{unit.label}</span>
      {original ? (
        <span className="type-meta block whitespace-nowrap text-muted-foreground tabular-nums">
          was{" "}
          {original.value === null
            ? "no limit"
            : formatValue(original.value, unit)}
        </span>
      ) : null}
    </div>
  )
}

// The limit as a number to type, and to step with the arrow keys.
function ResourceLimitInput({
  disabled,
  invalid,
  onChange,
  onNudge,
  shown,
  unit: { label, scale, spoken, unit },
  value,
}: {
  disabled: boolean
  invalid: boolean
  onChange: (value: ResourceLimitDraft) => void
  onNudge: (up: boolean) => void
  /** The limit in the units shown, when it's a number. */
  shown: number | null
  unit: ResourceLimitUnit
  value: ResourceLimitDraft
}) {
  // What's being typed, as typed: read back from the draft, a percent's
  // `12.` would lose its point before the `5` arrives.
  const [typing, setTyping] = React.useState<string | null>(null)
  return (
    <label className="relative order-2 sm:order-3">
      <Input
        aria-invalid={invalid || undefined}
        aria-label={`${label} limit in ${spoken}`}
        className={cn(
          "h-7 pl-2 text-right font-mono text-xs tabular-nums",
          value.limited ? "pr-9" : "pr-2"
        )}
        disabled={disabled}
        inputMode="decimal"
        value={
          typing ??
          (!value.limited
            ? "No limit"
            : scale === 1 || shown === null
              ? value.value
              : String(shown))
        }
        onBlur={() => setTyping(null)}
        onChange={(event) => {
          const typed = event.currentTarget.value.replace(/[^\d.]/gu, "")
          setTyping(typed)
          onChange({
            limited: true,
            value:
              typed === "" || scale === 1
                ? typed
                : String(Number(typed) / scale),
          })
        }}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
          event.preventDefault()
          setTyping(null)
          onNudge(event.key === "ArrowUp")
        }}
      />
      {value.limited ? (
        <span className="type-meta pointer-events-none absolute inset-y-0 right-2 flex items-center text-muted-foreground">
          {unit}
        </span>
      ) : null}
    </label>
  )
}

// The limit in the units shown, null while it isn't a number.
function limitValue(
  { limited, value }: ResourceLimitDraft,
  { scale }: ResourceLimitUnit
) {
  const stored = Number(value)
  if (!limited || value.trim() === "" || !Number.isFinite(stored)) {
    return { current: null, shown: null }
  }
  const current = stored * scale
  return { current, shown: Number(current.toFixed(2)) }
}

function spokenLimit(
  limited: boolean,
  shown: number | null,
  spoken: string
): string {
  if (!limited) return "No limit"
  return shown === null ? "Not set" : `${shown} ${spoken}`
}

function formatValue(value: number, { unit }: ResourceLimitUnit) {
  const number = Number(value.toFixed(2))
  return unit === "%" ? `${number}%` : `${number} ${unit}`
}

function formatAxis(value: number, { unit }: ResourceLimitUnit): string {
  const number = Number(value.toFixed(value < 1 ? 2 : value < 10 ? 1 : 0))
  return unit === "%" ? `${number}%` : String(number)
}
