import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { brickRecipeSchema, type DatabaseEngine } from "@workspace/contracts"
import { parse } from "yaml"

// The official database Bricks, read from the catalog Kiln ships, so tests
// create a database from what a real one is created from.
const bricksDirectory = resolve(
  import.meta.dirname,
  "../../../bricks/bricks"
)

/**
 * The Brick an engine's database is created from, as Hearth sends it with
 * a create: where it came from, and the recipe whole.
 */
export function databaseBrick(engine: DatabaseEngine) {
  return {
    recipe: `https://bricks.test/${engine}.yml`,
    recipeDefinition: brickRecipeSchema.parse(
      parse(readFileSync(resolve(bricksDirectory, `${engine}.yml`), "utf8"))
    ),
  }
}
