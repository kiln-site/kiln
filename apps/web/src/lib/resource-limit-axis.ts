// The scale a resource limit's slider runs on: logarithmic from the smallest
// useful limit to the most the node can give, since 256 MiB to 1 GiB matters
// as much as 16 to 64 GiB, with one last stop past its end for no limit.

/** Where the axis ends, in slider positions. */
export const AXIS_END = 1000
/** The stop for no limit; anything past halfway to it snaps there. */
export const NO_LIMIT_POSITION = 1260

// How close, in slider positions, a drag has to come to the saved limit to
// land on it, so it can be found again whatever value it is.
const SAVED_LIMIT_PULL = 12

/** Where a move leaves the limit: a value, no limit, or where it was. */
export type LimitMove = number | "no-limit" | null

export type LimitScale = {
  /** The axis's end when what the node can give isn't known. */
  fallbackMax: number
  min: number
  /** The round values near one, which the slider and arrow keys land on. */
  step: (value: number) => number
}

export type LimitAxis = {
  max: number
  /** One round value up or down; `current` is null for no limit. */
  nudge: (current: number | null, up: boolean) => LimitMove
  position: (value: number) => number
  /** Where the slider sits for a limit, held to the axis if past its end. */
  sliderAt: (limited: boolean, current: number | null) => number
  /** Where the slider moving to `next` takes the limit. */
  slide: (
    next: number,
    from: { at: number; current: number | null; keyboard: boolean }
  ) => LimitMove
  ticks: ReadonlyArray<{ position: number; value: number }>
  /** The stretches to shade: under `below`, and past what the node can give. */
  zones: (
    assignable: number | null,
    below: number | null
  ) => ReadonlyArray<{ from: number; to: number }>
}

export function limitAxis(
  { fallbackMax, min, step }: LimitScale,
  input: { assignable: number | null; original: number | null }
): LimitAxis {
  // The axis ends at what the node can give, or further when the saved limit
  // already does. A value typed past it doesn't move it: the axis stays
  // still under the slider, and the box says what's wrong.
  const max = Math.max(
    input.assignable ?? fallbackMax,
    input.original ?? 0,
    min * 2
  )
  const span = Math.log(max / min)
  const position = (value: number) =>
    (AXIS_END * Math.log(Math.max(value, min) / min)) / span
  const valueAt = (at: number) => {
    const value = min * Math.exp((Math.min(at, AXIS_END) / AXIS_END) * span)
    const size = step(value)
    const near = Math.round(value / size) * size
    return rounded(near > max ? Math.floor(value / size) * size : near)
  }
  const nudge = (current: number | null, up: boolean): LimitMove => {
    // Past the axis's end is no limit, and back from it the largest limit.
    if (current === null) {
      return up ? null : rounded(Math.floor(max / step(max)) * step(max))
    }
    // Going down from a tier's first value takes the tier below.
    const size = step(up ? current : current * (1 - 1e-9))
    const stepped = rounded(
      up
        ? Math.floor(current / size + 1e-9) * size + size
        : Math.ceil(current / size - 1e-9) * size - size
    )
    return stepped > max ? "no-limit" : Math.max(stepped, min)
  }
  return {
    max,
    nudge,
    position,
    slide: (next, { at, current, keyboard }) => {
      if (keyboard) {
        if (next <= 0) return min
        if (next >= NO_LIMIT_POSITION && next > at) return "no-limit"
        return nudge(current, next > at)
      }
      if (next > (AXIS_END + NO_LIMIT_POSITION) / 2) return "no-limit"
      const saved = input.original
      return saved !== null &&
        Math.abs(next - position(saved)) <= SAVED_LIMIT_PULL
        ? saved
        : valueAt(next)
    },
    sliderAt: (limited, current) => {
      if (!limited) return NO_LIMIT_POSITION
      return current === null ? 0 : Math.min(position(current), AXIS_END)
    },
    ticks: axisTicks(min, max).map((value) => ({
      position: position(value),
      value,
    })),
    zones: (assignable, below) => [
      ...(below !== null && below > min
        ? [{ from: 0, to: position(below) }]
        : []),
      ...(assignable !== null && assignable < max
        ? [{ from: position(assignable), to: AXIS_END }]
        : []),
    ],
  }
}

// Round values along a log axis: 1, 2, and 5 of each power of ten, or only
// the powers when that's too many, with both ends, dropping any too close
// to a neighbour to label.
function axisTicks(min: number, max: number): Array<number> {
  const candidates: Array<number> = []
  for (
    let exponent = Math.floor(Math.log10(min));
    10 ** exponent <= max;
    exponent += 1
  ) {
    for (const factor of [1, 2, 5]) {
      const value = Number((factor * 10 ** exponent).toPrecision(3))
      if (value > min && value < max) candidates.push(value)
    }
  }
  const round =
    candidates.length > 4
      ? candidates.filter((value) => Number.isInteger(Math.log10(value)))
      : candidates
  const span = Math.log(max / min)
  const ticks = [min]
  for (const value of [...round, max]) {
    const previous = ticks[ticks.length - 1] ?? min
    if (Math.log(value / previous) / span >= 0.12) ticks.push(value)
    else if (value === max) ticks[ticks.length - 1] = max
  }
  return ticks
}

function rounded(value: number): number {
  return Number(value.toFixed(4))
}
