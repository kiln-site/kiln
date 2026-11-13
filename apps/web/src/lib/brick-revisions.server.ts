import {
  brickRevision,
  brickSourceLineage,
  type Brick,
} from "@workspace/contracts"

import { listBrickCatalogsEffect } from "@/effect/brick-catalogs"
import { runAppEffect } from "@/effect/runtime"

// The newest revision of each Brick in the catalogs Hearth has: what an
// instance installed from an older one is offered, and what installing it
// takes. An instance follows the Brick it was installed from, which it
// finds by where that Brick comes from (`brickSourceLineage`), not by
// which catalog holds it or the commit a catalog was read at.

const cacheMs = 60_000
let cached: { at: number; bricks: Map<string, Brick> } | undefined

// Whose copy of a Brick says what its newest revision is, when several
// catalogs hold it: Kiln's own catalog, then one published to everyone,
// then one somebody added for themselves. Adding a newer copy of a catalog
// for oneself never moves what everyone else's instances are offered.
const authority = { own: 0, community: 1, personal: 2 } as const

/**
 * Each catalog Brick at its newest revision, by its lineage. Several
 * catalogs may hold the same Brick, read at different times; the Brick's is
 * the newest revision among the copies with the most say (`authority`). A
 * sweep asks once a minute at most.
 */
async function newestBricks(): Promise<ReadonlyMap<string, Brick>> {
  if (cached && Date.now() - cached.at < cacheMs) return cached.bricks
  const { defaultBrickCatalog } = await import("@/server/brick-catalogs.server")
  const [own, added] = await Promise.all([
    defaultBrickCatalog(),
    runAppEffect("brickCatalogs.all", listBrickCatalogsEffect("", true)),
  ])
  const held = new Map<string, { brick: Brick; rank: number }>()
  for (const catalog of [
    { bricks: own?.bricks ?? [], rank: authority.own },
    ...added.map((record) => ({
      bricks: record.snapshot?.bricks ?? [],
      rank: authority[record.visibility],
    })),
  ]) {
    for (const brick of catalog.bricks) {
      const lineage = brickSourceLineage(brick.source)
      const current = held.get(lineage)
      if (
        !current ||
        catalog.rank < current.rank ||
        (catalog.rank === current.rank &&
          brickRevision(brick) > brickRevision(current.brick))
      ) {
        held.set(lineage, { brick, rank: catalog.rank })
      }
    }
  }
  const bricks = new Map(
    [...held].map(([lineage, { brick }]) => [lineage, brick])
  )
  cached = { at: Date.now(), bricks }
  return bricks
}

/**
 * The newest revision of the Brick an instance was installed from at
 * `source`, as its Relay takes it, and where it is read from now. Null when
 * no catalog has the Brick, as for one installed from a link of its own.
 */
export async function newestBrickRevision(source: string) {
  const brick = (await newestBricks()).get(brickSourceLineage(source))
  if (!brick) return null
  const { iconSvg: _iconSvg, source: current, ...definition } = brick
  return {
    definition,
    name: brick.metadata.name,
    revision: brickRevision(brick),
    source: current,
  }
}
