import {
  brickRevision,
  brickSourceLineage,
  type Brick,
} from "@workspace/contracts"

import { listBrickCatalogsEffect } from "@/effect/brick-catalogs"
import { runAppEffect } from "@/effect/runtime"
import { hydrateBrickCatalogIcons } from "@/lib/brick-catalog-source.server"
import { defaultBrickCatalog } from "@/server/brick-catalogs.server"

// The Bricks someone may install from: those of Kiln's own catalog, of the
// catalogs they added, and of the ones published to everyone. Whoever asks
// for one kind filters for it.

/** A Brick someone sees, and whether Kiln's own catalog holds it. */
export interface VisibleBrick {
  brick: Brick
  own: boolean
}

// Whose copy of a Brick someone is offered, when several catalogs hold
// it: the one that says what its newest revision is
// (`brick-revisions.server.ts`), so what is installed is what its
// instances are then offered.
const authority = { community: 1, personal: 2 } as const

/**
 * Every Brick in the catalogs someone sees, each once. One that several
 * catalogs hold, read at different times, is Kiln's own catalog's, then a
 * published catalog's, then one of their own, and the newest revision among
 * equals.
 */
export async function visibleBricks(
  userId: string
): Promise<Array<VisibleBrick>> {
  const [own, added] = await Promise.all([
    defaultBrickCatalog(),
    runAppEffect(
      "brickCatalogs.visible",
      listBrickCatalogsEffect(userId, false)
    ).then((records) =>
      Promise.all(
        records.flatMap((record) =>
          record.snapshot
            ? [
                hydrateBrickCatalogIcons(record.snapshot).then((catalog) => ({
                  bricks: catalog.bricks,
                  rank: authority[record.visibility],
                })),
              ]
            : []
        )
      )
    ),
  ])
  const seen = new Map<string, VisibleBrick & { rank: number }>()
  for (const brick of own?.bricks ?? []) {
    seen.set(brickSourceLineage(brick.source), { brick, own: true, rank: 0 })
  }
  for (const { bricks, rank } of added) {
    for (const brick of bricks) {
      const lineage = brickSourceLineage(brick.source)
      const held = seen.get(lineage)
      if (
        !held ||
        rank < held.rank ||
        (rank === held.rank && brickRevision(brick) > brickRevision(held.brick))
      ) {
        seen.set(lineage, { brick, own: false, rank })
      }
    }
  }
  return [...seen.values()].map(({ brick, own: kilns }) => ({
    brick,
    own: kilns,
  }))
}
