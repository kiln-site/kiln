import { brickGame, type Brick, type BrickKind } from "@workspace/contracts"

// What the Brick browser shows differently for each kind of instance: the
// categories its Bricks sort into, and what a row says its Brick is.
// Everything else about browsing Bricks is the same for every kind.

/** The kinds of instance someone picks a Brick for. */
export type PickableBrickKind = Extract<BrickKind, "database" | "game-server">

export interface BrickKindPresentation {
  /** What the kind is called where someone chooses between kinds. */
  name: string
  /** The kind as the rest of Hearth knows it, for its icon and colour. */
  instanceKind: "database" | "server"
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

// Kiln has a viewer and dumps for the SQL engines; the others keep keys.
const keyValueTypes: ReadonlySet<string> = new Set(["redis", "valkey"])

/** Every kind someone can pick a Brick for, in the order they're offered. */
export const pickableBrickKinds: ReadonlyArray<PickableBrickKind> = [
  "game-server",
  "database",
]

export const brickKindPresentations: Record<
  PickableBrickKind,
  BrickKindPresentation
> = {
  database: {
    name: "Database",
    instanceKind: "database",
    categories: [
      { id: "sql", label: "SQL" },
      { id: "key-value", label: "Key-value" },
    ],
    category: (brick) =>
      keyValueTypes.has(brick.type ?? "") ? "key-value" : "sql",
    label: (brick) =>
      keyValueTypes.has(brick.type ?? "") ? "Key-value store" : "SQL database",
  },
  "game-server": {
    name: "Game Server",
    instanceKind: "server",
    categories: [
      { id: "minecraft", label: "Minecraft" },
      { id: "steam", label: "Steam" },
      { id: "other", label: "Other" },
    ],
    category: gameServerCategory,
    label: gameLabel,
  },
}
