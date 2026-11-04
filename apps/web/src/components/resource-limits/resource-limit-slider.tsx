import * as React from "react"

import { Input } from "@workspace/ui/components/input"
import { Slider } from "@workspace/ui/components/slider"
import { cn } from "@workspace/ui/lib/utils"

import {
  AXIS_END,
  limitAxis,
  NO_LIMIT_POSITION,
  type LimitScale,
} from "@/lib/resource-limit-axis"
import type { ResourceLimitDraft } from "@/lib/resource-limits"

export type ResourceLimitUnit = LimitScale & {
  /** Whether the limit takes fractions, as GiB do; else whole units. */
  decimals: boolean
  label: string
  /** Shown units per stored unit, as percent per core. */
  scale: number
  /** What a screen reader says for the unit. */
  spoken: string
  unit: string
}

// How close, in slider positions, a drag has to come to the saved limit to
// land on it, so it can be found again whatever value it is.
const SAVED_LIMIT_PULL = 12

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
  const { decimals, label, min, scale, spoken } = unit
  const stored = Number(value.value)
  const current =
    value.limited && value.value.trim() !== "" && Number.isFinite(stored)
      ? stored * scale
      : null
  const axis = limitAxis(unit, { assignable, original })
  const limitTo = (shown: number) =>
    onChange({
      limited: true,
      value: String(Number((shown / scale).toFixed(4))),
    })
  const noLimit = () => onChange({ ...value, limited: false })
  const nudge = (up: boolean) => {
    if (!value.limited) {
      if (!up) limitTo(axis.largest)
      return
    }
    const stepped = axis.next(current ?? min, up)
    if (stepped > axis.max) noLimit()
    else limitTo(Math.max(stepped, min))
  }
  const sliderAt = !value.limited
    ? NO_LIMIT_POSITION
    : current === null
      ? 0
      : axis.position(current)
  const shown =
    current === null
      ? null
      : decimals
        ? Number(current.toFixed(2))
        : Math.round(current)
  const changed = value.limited ? current !== original : original !== null

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_5.5rem] items-start gap-x-3 gap-y-1 sm:grid-cols-[5rem_minmax(0,1fr)_5.5rem]">
      <div className="order-1 min-h-7 min-w-0">
        <span className="type-label flex h-7 items-center">{label}</span>
        {changed ? (
          <span className="type-meta block whitespace-nowrap text-muted-foreground tabular-nums">
            was {original === null ? "no limit" : formatValue(original, unit)}
          </span>
        ) : null}
      </div>
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
        value={Math.min(sliderAt, value.limited ? AXIS_END : NO_LIMIT_POSITION)}
        valueText={() =>
          !value.limited
            ? "No limit"
            : shown === null
              ? "Not set"
              : `${shown} ${spoken}`
        }
        zones={[
          ...(below !== null && below > min
            ? [{ from: 0, to: axis.position(below) }]
            : []),
          ...(assignable !== null && assignable < axis.max
            ? [{ from: axis.position(assignable), to: AXIS_END }]
            : []),
        ]}
        onValueChange={(next, reason) => {
          if (reason === "keyboard") {
            // A key moves one round value, and past the axis's end, or back
            // from it, to no limit and the largest limit.
            if (next <= 0) return limitTo(min)
            if (next >= NO_LIMIT_POSITION && next > sliderAt) return noLimit()
            return nudge(next > sliderAt)
          }
          if (next > (AXIS_END + NO_LIMIT_POSITION) / 2) return noLimit()
          if (
            original !== null &&
            Math.abs(next - axis.position(original)) <= SAVED_LIMIT_PULL
          ) {
            return limitTo(original)
          }
          limitTo(axis.valueAt(next))
        }}
      />
      <ResourceLimitInput
        disabled={disabled}
        invalid={invalid}
        shown={shown}
        unit={unit}
        value={value}
        onChange={onChange}
        onNudge={nudge}
      />
    </div>
  )
})

// The limit as a number to type, and to step with the arrow keys.
function ResourceLimitInput({
  disabled,
  invalid,
  onChange,
  onNudge,
  shown,
  unit: { decimals, label, scale, spoken, unit },
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
        inputMode={decimals ? "decimal" : "numeric"}
        value={
          !value.limited
            ? "No limit"
            : scale === 1 || shown === null
              ? value.value
              : String(shown)
        }
        onChange={(event) => {
          const typed = event.currentTarget.value.replace(
            decimals ? /[^\d.]/gu : /\D/gu,
            ""
          )
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

function formatValue(value: number, { decimals, unit }: ResourceLimitUnit) {
  const number = decimals ? Number(value.toFixed(2)) : Math.round(value)
  return unit === "%" ? `${number}%` : `${number} ${unit}`
}

function formatAxis(value: number, { unit }: ResourceLimitUnit): string {
  const number = Number(value.toFixed(value < 1 ? 2 : value < 10 ? 1 : 0))
  return unit === "%" ? `${number}%` : String(number)
}
