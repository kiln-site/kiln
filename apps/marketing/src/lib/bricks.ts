import {
  type BrickV2,
  type BrickV2Catalog,
  type BrickV2DeployType,
  type BrickV2Kind,
  brickV2CatalogSchema,
  brickV2Schema,
} from "@workspace/contracts"

// Every Brick kiln.site lists, read from apps/bricks at build time: the
// official catalog's and the reviewed community ones. A file that fails the
// schema fails the build, as apps/bricks' tests do.
const brickFiles = import.meta.glob<unknown>(
  ["../../../bricks/bricks/*.json", "../../../bricks/community/**/*.json"],
  { eager: true, import: "default" }
)
const iconFiles = import.meta.glob<string>("../../../bricks/icons/*.svg", {
  eager: true,
  import: "default",
  query: "?url",
})

export type BrickTier = "official" | "community"

export interface ListedBrick {
  brick: BrickV2
  // The icon as a URL a mask can use, when it has one.
  iconUrl: string | undefined
  // Its path in the repository, from apps/bricks.
  path: string
  tier: BrickTier
}

export const repositoryUrl = "https://github.com/kiln-site/kiln"
const rawRoot = "https://raw.githubusercontent.com/kiln-site/kiln/main"
export const bricksFolderUrl = `${repositoryUrl}/tree/main/apps/bricks`
export const communityFolderUrl = `${bricksFolderUrl}/community`
export const officialCatalogUrl = `${rawRoot}/apps/bricks/catalog.json`
export const brickSchemaUrl = "https://kiln.site/bricks/schema.json"

export function rawBrickUrl(listed: ListedBrick): string {
  return `${rawRoot}/apps/bricks/${listed.path}`
}

export function sourceBrickUrl(listed: ListedBrick): string {
  return `${repositoryUrl}/blob/main/apps/bricks/${listed.path}`
}

const catalogFiles = import.meta.glob<unknown>("../../../bricks/catalog.json", {
  eager: true,
  import: "default",
})

export const officialCatalog: BrickV2Catalog = brickV2CatalogSchema.parse(
  catalogFiles["../../../bricks/catalog.json"]
)

// Where a Brick's icon can be drawn from: an official icon by its path in
// apps/bricks, or a link.
export function brickIconUrl(icon: string | undefined): string | undefined {
  if (!icon) return undefined
  if (icon.startsWith("../icons/")) {
    return iconFiles[`../../../bricks/icons/${icon.slice("../icons/".length)}`]
  }
  return /^https:\/\//iu.test(icon) ? icon : undefined
}

function listed(file: string, value: unknown): ListedBrick {
  const path = file.replace("../../../bricks/", "")
  const result = brickV2Schema.safeParse(value)
  if (!result.success) {
    throw new Error(`${path} isn't a valid Brick: ${result.error.message}`)
  }
  const brick = result.data
  return {
    brick,
    iconUrl: brickIconUrl(brick.icon),
    path,
    tier: path.startsWith("community/") ? "community" : "official",
  }
}

const byFile = new Map(
  Object.entries(brickFiles).map(([file, value]) => [
    file.replace("../../../bricks/", ""),
    listed(file, value),
  ])
)

// In the catalog's order.
export const officialBricks: ReadonlyArray<ListedBrick> =
  officialCatalog.bricks.flatMap((path) => {
    const brick = byFile.get(path)
    return brick ? [brick] : []
  })

export const communityBricks: ReadonlyArray<ListedBrick> = [...byFile.values()]
  .filter((brick) => brick.tier === "community")
  .sort((left, right) => left.brick.name.localeCompare(right.brick.name))

export const listedBricks: ReadonlyArray<ListedBrick> = [
  ...officialBricks,
  ...communityBricks,
]

export function findListedBrick(id: string): ListedBrick | undefined {
  return listedBricks.find((listed) => listed.brick.id === id)
}

export const brickKindLabels = {
  "game-server": "Game server",
  app: "App",
  database: "Database",
} as const satisfies Record<BrickV2Kind, string>

export const brickKindPluralLabels = {
  "game-server": "Game servers",
  app: "Apps",
  database: "Databases",
} as const satisfies Record<BrickV2Kind, string>

export const brickDeployLabels = {
  image: "Docker image",
  dockerfile: "Dockerfile",
  compose: "Docker Compose",
  static: "Static site",
} as const satisfies Record<BrickV2DeployType, string>

export function formatBrickJson(brick: unknown): string {
  return `${JSON.stringify(brick, null, 2)}\n`
}
