// The scale a resource limit's slider runs on: logarithmic from the smallest
// useful limit to the most the node can give, since 256 MiB to 1 GiB matters
// as much as 16 to 64 GiB, with one last stop past its end for no limit.

/** Where the axis ends, in slider positions. */
export const AXIS_END = 1000
/** The stop for no limit; anything past halfway to it snaps there. */
export const NO_LIMIT_POSITION = 1260

export type LimitScale = {
  /** The axis's end when what the node can give isn't known. */
  fallbackMax: number
  min: number
  /** The round values near one, which the slider and arrow keys land on. */
  step: (value: number) => number
}

export type LimitAxis = {
  max: number
  /** The value the keyboard lands on coming back from no limit. */
  largest: number
  /** The next round value up or down from one. */
  next: (value: number, up: boolean) => number
  position: (value: number) => number
  ticks: ReadonlyArray<{ position: number; value: number }>
  valueAt: (position: number) => number
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
  return {
    largest: rounded(Math.floor(max / step(max)) * step(max)),
    max,
    next: (value, up) => {
      // Going down from a tier's first value takes the tier below.
      const size = step(up ? value : value * (1 - 1e-9))
      return rounded(
        up
          ? Math.floor(value / size + 1e-9) * size + size
          : Math.ceil(value / size - 1e-9) * size - size
      )
    },
    position,
    ticks: axisTicks(min, max).map((value) => ({
      position: position(value),
      value,
    })),
    valueAt: (at) => {
      const value = min * Math.exp((Math.min(at, AXIS_END) / AXIS_END) * span)
      const size = step(value)
      const near = Math.round(value / size) * size
      return rounded(near > max ? Math.floor(value / size) * size : near)
    },
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
