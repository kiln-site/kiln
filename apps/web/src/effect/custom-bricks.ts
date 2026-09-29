import { createHash, randomUUID } from "node:crypto"

import { brickSchema, type Brick } from "@workspace/contracts"
import { Clock, Effect, Result } from "effect"
import type { RowDataPacket } from "mysql2/promise"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

interface CustomBrickRow extends RowDataPacket {
  recipe: unknown
}

export const listCustomBricksEffect = Effect.fn("customBricks.list")(function* (
  userId: string
) {
  const database = yield* Database
  const rows = yield* database.queryRows<CustomBrickRow>(
    "customBricks.list",
    `SELECT recipe
         FROM ${databaseTable("custom_brick")}
        WHERE owner_user_id = ?
        ORDER BY updated_at DESC`,
    [userId]
  )

  return rows.flatMap((row) => {
    const value = decodeJson(row.recipe)
    const parsed = brickSchema.safeParse(value)
    return parsed.success ? [parsed.data] : []
  })
})

export const saveCustomBrickEffect = Effect.fn("customBricks.save")(function* (
  userId: string,
  brick: Brick
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const sourceHash = createHash("sha256").update(brick.source).digest("hex")
  yield* database.execute(
    "customBricks.save",
    `INSERT INTO ${databaseTable("custom_brick")}
         (id, owner_user_id, source_hash, source, recipe, created_at,
          updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         source = VALUES(source),
         recipe = VALUES(recipe),
         updated_at = VALUES(updated_at)`,
    [
      randomUUID(),
      userId,
      sourceHash,
      brick.source,
      JSON.stringify(brick),
      now,
      now,
    ]
  )
  return brick
})

function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  return Result.getOrElse(
    Result.try(() => JSON.parse(value) as unknown),
    () => null
  )
}
