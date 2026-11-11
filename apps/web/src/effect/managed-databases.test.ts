import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import { listManagedDatabaseRecordsEffect } from "@/effect/managed-databases"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertRows } from "@/test/seed"

const now = Date.UTC(2026, 8, 1)
const relayOne = "1".repeat(12)

const insertManagedDatabase = (
  relayId: string,
  databaseId: string,
  name: string,
  engine = "postgres"
) =>
  insertRows("database", {
    database_id: databaseId,
    relay_id: relayId,
    name,
    engine,
    // As one made before databases ran Bricks is left: its engine's.
    brick_id: engine,
    image: engine === "redis" ? "redis:8" : "postgres:17",
    internal_port: engine === "redis" ? 6379 : 5432,
    database_name: `db_${databaseId}`,
    username: `user_${databaseId}`,
    password_ciphertext: "password-ciphertext",
    created_by: "user-one",
    created_at: now,
    updated_at: now,
  })

describeMysql("managed database persistence", () => {
  layer(TestDatabase)((it) => {
    it.effect("lists metadata without credentials", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay(relayOne)
        yield* insertManagedDatabase(relayOne, "redis-id", "Redis", "redis")
        yield* insertManagedDatabase(relayOne, "postgres-id", "Postgres")

        const records = yield* listManagedDatabaseRecordsEffect()

        assert.deepStrictEqual(records, [
          {
            brickId: "postgres",
            createdAt: new Date(now).toISOString(),
            createdBy: "user-one",
            databaseId: "postgres-id",
            databaseName: "db_postgres-id",
            engine: "postgres",
            image: "postgres:17",
            internalPort: 5432,
            name: "Postgres",
            relayId: relayOne,
          },
          {
            brickId: "redis",
            createdAt: new Date(now).toISOString(),
            createdBy: "user-one",
            databaseId: "redis-id",
            databaseName: "db_redis-id",
            engine: "redis",
            image: "redis:8",
            internalPort: 6379,
            name: "Redis",
            relayId: relayOne,
          },
        ])
      })
    )
  })
})
