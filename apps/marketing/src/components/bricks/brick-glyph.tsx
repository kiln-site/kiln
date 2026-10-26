import * as React from "react"
import { Box } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"

import { BRICK_COLOR_PALETTE } from "@/components/brick-icon"

// A Brick's mark as Hearth draws it: the SVG as a mask in the Brick's colour,
// or a box when it has no icon.
export const BrickGlyph = React.memo(function BrickGlyph({
  className = "size-5",
  color,
  iconUrl,
  id,
}: {
  className?: string
  color: string | undefined
  iconUrl: string | undefined
  id: string
}) {
  const resolved = color ?? brickColorFor(id)
  if (!iconUrl) {
    return (
      <Box
        aria-hidden="true"
        className={cn("shrink-0", className)}
        style={{ color: resolved }}
      />
    )
  }
  const mask = `url("${iconUrl}")`
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block shrink-0 [mask-size:contain] [mask-position:center] [mask-repeat:no-repeat]",
        className
      )}
      style={{
        backgroundColor: resolved,
        maskImage: mask,
        WebkitMaskImage: mask,
      }}
    />
  )
})

// The colour Hearth picks for a Brick without one.
export function brickColorFor(id: string): string {
  let hash = 2_166_136_261
  for (const character of id.trim().toLowerCase()) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16_777_619)
  }
  return BRICK_COLOR_PALETTE[(hash >>> 0) % BRICK_COLOR_PALETTE.length]!
}

// The tile a Brick's mark sits on in lists and headers.
export function BrickTile({
  className,
  color,
  iconUrl,
  id,
  size = "md",
}: {
  className?: string
  color: string | undefined
  iconUrl: string | undefined
  id: string
  size?: "md" | "lg"
}) {
  const resolved = color ?? brickColorFor(id)
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center border",
        size === "lg" ? "size-16" : "size-11",
        className
      )}
      style={{
        backgroundColor: `color-mix(in oklab, ${resolved} 12%, transparent)`,
        borderColor: `color-mix(in oklab, ${resolved} 28%, transparent)`,
      }}
    >
      <BrickGlyph
        className={size === "lg" ? "size-8" : "size-5.5"}
        color={resolved}
        iconUrl={iconUrl}
        id={id}
      />
    </span>
  )
}
