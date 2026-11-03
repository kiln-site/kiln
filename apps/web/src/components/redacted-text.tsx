import * as React from "react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

// Personal details such as an email address, hidden behind a mosaic until
// clicked so they stay private on a shared screen. The value isn't rendered
// until revealed. The mosaic comes from the component instance rather than the
// value, so it can't show a value's length or that two values match.

const mosaicColumnEm = 0.6
const mosaicHeightEm = 1.15
const mosaicMinColumns = 10
const mosaicColumnRange = 9
const mosaicMinTone = 18
const mosaicToneRange = 31
const mosaicBlockColumns = [1, 1, 2, 2, 3, 4]

export function RedactedText({
  className,
  label,
  value,
}: {
  className?: string
  label: string
  value: string
}) {
  // Revealing applies to this value only; a new one, such as a new owner's
  // email, starts hidden.
  const [revealedValue, setRevealedValue] = React.useState<string | null>(null)
  const revealed = revealedValue === value
  // useId rather than a random number so server and client render the same.
  const mosaicSeed = React.useId()
  const mosaicStyle = React.useMemo(
    () => redactedMosaicStyle(mosaicSeed),
    [mosaicSeed]
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "max-w-full min-w-0 cursor-pointer rounded-sm text-left break-all transition hover:text-foreground",
            className
          )}
          aria-label={revealed ? `${value}. Hide ${label}` : `Reveal ${label}`}
          aria-pressed={revealed}
          onClick={() => setRevealedValue(revealed ? null : value)}
        >
          {revealed ? (
            value
          ) : (
            // One line tall, like a value that fits on one line. Forced colors
            // and printing drop gradients, which would leave nothing to click.
            <span
              aria-hidden
              className="inline-block h-[1lh] max-w-full bg-left bg-no-repeat align-top [print-color-adjust:exact] forced-colors:text-[color:CanvasText] forced-colors:forced-color-adjust-none"
              style={mosaicStyle}
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {revealed ? `Click to hide ${label}` : `Click to reveal ${label}`}
      </TooltipContent>
    </Tooltip>
  )
}

// A single gradient of hard stops, so a mosaic costs one element however many
// blocks it has. Its tones follow currentColor, which fits every theme.
function redactedMosaicStyle(seed: string): React.CSSProperties {
  const nextInt = seededRandom(seed)
  const columns = mosaicMinColumns + nextInt(mosaicColumnRange)
  const stops: Array<string> = []

  let column = 0
  while (column < columns) {
    const blockColumns =
      mosaicBlockColumns[nextInt(mosaicBlockColumns.length)] ?? 1
    const end = Math.min(column + blockColumns, columns)
    const tone = mosaicMinTone + nextInt(mosaicToneRange)
    stops.push(
      `color-mix(in srgb, currentColor ${tone}%, transparent) ${column * mosaicColumnEm}em ${end * mosaicColumnEm}em`
    )
    column = end
  }

  const width = columns * mosaicColumnEm
  return {
    backgroundImage: `linear-gradient(90deg, ${stops.join(", ")})`,
    backgroundSize: `${width}em ${mosaicHeightEm}em`,
    backgroundPositionY: "center",
    width: `${width}em`,
  }
}

// FNV-1a to seed mulberry32.
function seededRandom(seed: string) {
  let state = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index)
    state = Math.imul(state, 0x01000193)
  }

  return (limit: number) => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) % limit
  }
}
