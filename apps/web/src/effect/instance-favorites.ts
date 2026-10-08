import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect } from "effect"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"
import type { InstanceFavorite } from "@/lib/instance-favorites"

interface InstanceFavoriteRow extends RowDataPacket {
  relay_id: string
  resource_id: string
  resource_kind: InstanceFavorite["kind"]
}

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
    yield* database.execute(
      "instanceFavorites.add",
      `INSERT INTO ${databaseTable("instance_favorite")}
         (user_id, relay_id, resource_kind, resource_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE created_at = created_at`,
      [userId, favorite.relayId, favorite.kind, favorite.id, now]
    )
  }
)
