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

/**
 * Each catalog Brick at its newest revision, by its lineage. Several
 * catalogs may hold the same Brick, read at different times; the newest
 * revision any of them has is the Brick's. A sweep asks once a minute at
 * most.
 */
async function newestBricks(): Promise<ReadonlyMap<string, Brick>> {
  if (cached && Date.now() - cached.at < cacheMs) return cached.bricks
  const { defaultBrickCatalog } = await import("@/server/brick-catalogs.server")
  const [own, added] = await Promise.all([
    defaultBrickCatalog(),
    runAppEffect("brickCatalogs.all", listBrickCatalogsEffect("", true)),
  ])
  const bricks = new Map<string, Brick>()
  for (const catalog of [
    own,
    ...added.map((record) => record.snapshot ?? null),
  ]) {
    for (const brick of catalog?.bricks ?? []) {
      const lineage = brickSourceLineage(brick.source)
      const held = bricks.get(lineage)
      if (!held || brickRevision(brick) > brickRevision(held)) {
        bricks.set(lineage, brick)
      }
    }
  }
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
