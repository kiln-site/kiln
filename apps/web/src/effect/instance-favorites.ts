import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect } from "effect"

import { Database, type DatabaseTransaction } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"
import { kilnFavorite, type InstanceFavorite } from "@/lib/instance-favorites"

interface InstanceFavoriteRow extends RowDataPacket {
  relay_id: string
  resource_id: string
  resource_kind: InstanceFavorite["kind"]
}

const addFavoriteSql = `INSERT INTO ${databaseTable("instance_favorite")}
   (user_id, relay_id, resource_kind, resource_id, created_at)
 VALUES (?, ?, ?, ?, ?)
 ON DUPLICATE KEY UPDATE created_at = created_at`

export const listInstanceFavoritesEffect = Effect.fn("instanceFavorites.list")(
  function* (userId: string) {
    const database = yield* Database
    const rows = yield* database.queryRows<InstanceFavoriteRow>(
      "instanceFavorites.list",
      `SELECT relay_id, resource_kind, resource_id
       FROM ${databaseTable("instance_favorite")}
      WHERE user_id = ?
      ORDER BY created_at`,
      [userId]
    )
    return rows.map((row): InstanceFavorite => ({
      id: row.resource_id,
      kind: row.resource_kind,
      relayId: row.relay_id,
    }))
  }
)

export const setInstanceFavoriteEffect = Effect.fn("instanceFavorites.set")(
  function* (userId: string, favorite: InstanceFavorite, starred: boolean) {
    const database = yield* Database
    if (!starred) {
      yield* database.execute(
        "instanceFavorites.remove",
        `DELETE FROM ${databaseTable("instance_favorite")}
          WHERE user_id = ? AND relay_id = ? AND resource_kind = ? AND resource_id = ?`,
        [userId, favorite.relayId, favorite.kind, favorite.id]
      )
      return
    }
    const now = yield* Clock.currentTimeMillis
    yield* database.execute("instanceFavorites.add", addFavoriteSql, [
      userId,
      favorite.relayId,
      favorite.kind,
      favorite.id,
      now,
    ])
  }
)

/**
 * Stars Kiln for someone becoming a platform administrator, in the
 * transaction that makes them one. They can unstar it like any favorite.
 */
export const starKilnForAdministratorEffect = Effect.fnUntraced(function* (
  transaction: DatabaseTransaction,
  userId: string
) {
  const now = yield* Clock.currentTimeMillis
  yield* transaction.execute(addFavoriteSql, [
    userId,
    kilnFavorite.relayId,
    kilnFavorite.kind,
    kilnFavorite.id,
    now,
  ])
})
