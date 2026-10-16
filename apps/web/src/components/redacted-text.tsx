import * as React from "react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

// Personal details such as an email address, blurred until clicked so they
// stay private on a shared screen. The blur covers stand-in characters, so
// the real value isn't in the page until revealed.

const redactedTextAlphabet = "abcdefghjkmnpqrstuvwxyz23456789"
const redactedDigitAlphabet = "0123456789"
const redactedSeparators = new Set(["@", ".", "-", "_", ":"])

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
  // email, starts blurred.
  const [revealedValue, setRevealedValue] = React.useState<string | null>(null)
  const revealed = revealedValue === value
  const redacted = React.useMemo(() => redactedPlaceholder(value), [value])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "min-w-0 cursor-pointer rounded-sm text-left break-all transition hover:text-foreground",
            !revealed && "blur-[3px] select-none",
            className
          )}
          aria-label={revealed ? `${value}. Hide ${label}` : `Reveal ${label}`}
          aria-pressed={revealed}
          onClick={() => setRevealedValue(revealed ? null : value)}
        >
          {revealed ? value : redacted}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {revealed ? `Click to hide ${label}` : `Click to reveal ${label}`}
      </TooltipContent>
    </Tooltip>
  )
}

function redactedPlaceholder(value: string): string {
  let state = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    state ^= value.charCodeAt(index)
    state = Math.imul(state, 0x01000193)
  }

  const nextCharacter = (alphabet: string) => {
    state = Math.imul(state ^ (state >>> 13), 0x85ebca6b)
    state = Math.imul(state ^ (state >>> 16), 0xc2b2ae35)
    return alphabet[Math.abs(state) % alphabet.length] ?? "x"
  }

  return Array.from(value, (character) => {
    if (redactedSeparators.has(character)) return character
    return nextCharacter(
      /\d/.test(character) ? redactedDigitAlphabet : redactedTextAlphabet
    )
  }).join("")
}
