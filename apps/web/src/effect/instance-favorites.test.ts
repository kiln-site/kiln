import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import {
  listInstanceFavoritesEffect,
  setInstanceFavoriteEffect,
} from "@/effect/instance-favorites"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertUser } from "@/test/seed"

const server = { id: "inst-a", kind: "server", relayId: "relay-a" } as const
const database = { id: "db-a", kind: "database", relayId: "relay-a" } as const

describeMysql("instance favorites", () => {
  layer(TestDatabase)((it) => {
    it.effect("keeps each user's favorites to themselves", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertUser("user-a")
        yield* insertUser("user-b")

        yield* setInstanceFavoriteEffect("user-a", server, true)
        yield* setInstanceFavoriteEffect("user-a", server, true)
        yield* setInstanceFavoriteEffect("user-a", database, true)
        yield* setInstanceFavoriteEffect("user-b", database, true)

        assert.deepStrictEqual(yield* listInstanceFavoritesEffect("user-a"), [
          server,
          database,
        ])
        assert.deepStrictEqual(yield* listInstanceFavoritesEffect("user-b"), [
          database,
        ])

        yield* setInstanceFavoriteEffect("user-a", database, false)
        assert.deepStrictEqual(yield* listInstanceFavoritesEffect("user-a"), [
          server,
        ])
        assert.deepStrictEqual(yield* listInstanceFavoritesEffect("user-b"), [
          database,
        ])
      })
    )
  })
})
