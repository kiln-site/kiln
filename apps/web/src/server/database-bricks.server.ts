import {
  databaseBrickProblem,
  databaseEngineSchema,
  type Brick,
  type BrickRecipe,
  type DatabaseEngine,
} from "@workspace/contracts"

import { defaultBrickCatalog } from "@/server/brick-catalogs.server"

// The Bricks a database is created from: the database Bricks of Kiln's own
// catalog, each of a type Kiln has the login, dumps and viewer for, run the
// way that type needs. Another catalog's aren't offered or accepted yet:
// what Kiln does to a database relies on how these ones run it, which is
// more than a recipe can be checked for. The Relay checks what it can.

/** Every database Brick a database may be created from. */
export async function databaseBricks(): Promise<Array<Brick>> {
  const catalog = await defaultBrickCatalog()
  return (catalog?.bricks ?? []).filter(
    (brick) => databaseBrickProblem(brick) === null
  )
}

/**
 * The database Brick at a source, as its Relay takes it, and the engine it
 * runs, which is its type.
 */
export async function requiredDatabaseBrick(
  source: string
): Promise<{ definition: BrickRecipe; engine: DatabaseEngine }> {
  const brick = (await databaseBricks()).find(
    (candidate) => candidate.source === source
  )
  if (!brick) {
    throw new Error("This isn't one of Kiln's database Bricks")
  }
  const { iconSvg: _iconSvg, source: _source, ...definition } = brick
  return { definition, engine: databaseEngineSchema.parse(brick.type) }
}
