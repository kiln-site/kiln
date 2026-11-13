import {
  brickRevision,
  brickSourceLineage,
  type Brick,
} from "@workspace/contracts"

import { listBrickCatalogsEffect } from "@/effect/brick-catalogs"
import { listCustomBricksEffect } from "@/effect/custom-bricks"
import { runAppEffect } from "@/effect/runtime"
import { hasPlatformPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
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

/**
 * The Bricks someone saved from links of their own, in no catalog, while
 * they may still use them. Only they see them.
 */
export async function customBricksOf(
  user: AuthenticatedUser
): Promise<Array<Brick>> {
  return hasPlatformPermission(user, "platform.bricks.add-custom")
    ? runAppEffect("customBricks.list", listCustomBricksEffect(user.id))
    : []
}

/**
 * Every Brick someone may install from: those of the catalogs they see,
 * then the ones they saved from links of their own. A link to a Brick a
 * catalog already holds is that catalog's Brick.
 */
export async function installableBricks(
  user: AuthenticatedUser
): Promise<Array<VisibleBrick>> {
  const [listed, custom] = await Promise.all([
    visibleBricks(user.id),
    customBricksOf(user),
  ])
  const sources = new Set(listed.map(({ brick }) => brick.source))
  return [
    ...listed,
    ...custom
      .filter((brick) => !sources.has(brick.source))
      .map((brick) => ({ brick, own: false })),
  ]
}
