import * as React from "react"
import { Box } from "lucide-react"

const BRICK_COLOR_PALETTE = [
  "#e67e7e",
  "#dc895c",
  "#c49528",
  "#6aa54f",
  "#3e9e83",
  "#4b98b0",
  "#5f83cb",
  "#7763a3",
  "#a45c90",
] as const

export interface BrickIconPresentation {
  color?: string | undefined
  iconSvg?: string | undefined
  id: string
}

export interface BrickIconDefinition extends BrickIconPresentation {
  source: string
}

type BrickIconProps = BrickIconPresentation & {
  "aria-hidden"?: boolean | "false" | "true"
  className?: string
  style?: React.CSSProperties
}

export const BrickIcon = React.memo(function BrickIcon({
  color,
  className,
  iconSvg,
  id,
  style,
  ...props
}: BrickIconProps) {
  const resolvedColor = color ?? (iconSvg ? deterministicBrickColor(id) : null)
  if (!iconSvg) {
    return (
      <Box
        aria-hidden={props["aria-hidden"]}
        className={className}
        style={{ ...style, ...(resolvedColor ? { color: resolvedColor } : {}) }}
      />
    )
  }
  const mask = `url("data:image/svg+xml,${encodeURIComponent(iconSvg)}")`
  return (
    <span
      aria-hidden={props["aria-hidden"]}
      className={className}
      style={{
        backgroundColor: resolvedColor ?? "currentColor",
        display: "inline-block",
        maskImage: mask,
        maskPosition: "center",
        maskRepeat: "no-repeat",
        maskSize: "contain",
        WebkitMaskImage: mask,
        WebkitMaskPosition: "center",
        WebkitMaskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
        ...style,
      }}
    />
  )
})

export function deterministicBrickColor(id: string): string {
  let hash = 2_166_136_261
  for (const character of id.trim().toLowerCase()) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16_777_619)
  }
  return BRICK_COLOR_PALETTE[(hash >>> 0) % BRICK_COLOR_PALETTE.length]!
}

export function brickIconPresentation(
  bricks: ReadonlyArray<BrickIconDefinition>,
  input: {
    brickId?: string
    brickSource?: string
    implementation: string
  }
): BrickIconPresentation {
  const fallbackId = input.brickId ?? input.implementation
  const normalizedId = fallbackId.trim().toLowerCase()
  const brick =
    bricks.find(
      (candidate) =>
        input.brickSource !== undefined &&
        candidate.source === input.brickSource
    ) ?? bricks.find((candidate) => candidate.id.toLowerCase() === normalizedId)
  return {
    id: brick?.id ?? fallbackId,
    ...(brick?.color ? { color: brick.color } : {}),
    ...(brick?.iconSvg ? { iconSvg: brick.iconSvg } : {}),
  }
}
