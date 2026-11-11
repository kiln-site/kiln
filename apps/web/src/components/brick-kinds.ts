import { brickGame, type Brick, type BrickKind } from "@workspace/contracts"

// What the Brick browser shows differently for each kind of instance: the
// categories its Bricks sort into, and what a row says its Brick is.
// Everything else about browsing Bricks is the same for every kind.

/** The kinds of instance someone picks a Brick for. */
export type PickableBrickKind = Extract<BrickKind, "game-server">

export interface BrickKindPresentation {
  /** Offered after "All", in this order. */
  categories: ReadonlyArray<{ id: string; label: string }>
  /** Which of them a Brick is in. */
  category: (brick: Brick) => string
  /** What a row says its Brick is, after where it came from. */
  label: (brick: Brick) => string
}

function gameServerCategory(brick: Brick): string {
  const tags = new Set(
    (brick.metadata.tags ?? []).map((tag) => tag.toLowerCase())
  )
  const image = brick.deploy?.type === "image" ? brick.deploy.image : ""
  if (tags.has("steam") || image.toLowerCase().includes("steam")) {
    return "steam"
  }
  if (brick.type === "minecraft") return "minecraft"
  return "other"
}

function gameLabel(brick: Brick): string {
  const tags = new Set(brick.metadata.tags ?? [])
  const game = brickGame(brick)
  if (tags.has("java")) return `${game} - Java`
  if (tags.has("bedrock")) return `${game} - Bedrock`
  return game
}

export const brickKindPresentations: Record<
  PickableBrickKind,
  BrickKindPresentation
> = {
  "game-server": {
    categories: [
      { id: "minecraft", label: "Minecraft" },
      { id: "steam", label: "Steam" },
      { id: "other", label: "Other" },
    ],
    category: gameServerCategory,
    label: gameLabel,
  },
}
