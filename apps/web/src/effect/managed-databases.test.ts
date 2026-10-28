import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import {
  listManagedDatabaseRecordsEffect,
  managedDatabaseNameExistsEffect,
  renameManagedDatabaseRecordEffect,
} from "@/effect/managed-databases"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertRows } from "@/test/seed"

const now = Date.UTC(2026, 8, 1)
const relayOne = "r".repeat(43)
const relayTwo = "s".repeat(43)

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
            createdAt: new Date(now).toISOString(),
            createdBy: "user-one",
            databaseId: "postgres-id",
            databaseName: "db_postgres-id",
            engine: "postgres",
            name: "Postgres",
            relayId: relayOne,
          },
          {
            createdAt: new Date(now).toISOString(),
            createdBy: "user-one",
            databaseId: "redis-id",
            databaseName: "db_redis-id",
            engine: "redis",
            name: "Redis",
            relayId: relayOne,
          },
        ])
      })
    )

    it.effect("checks names within one Relay", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay(relayOne)
        yield* insertRelay(relayTwo)
        yield* insertManagedDatabase(relayOne, "primary-id", "Primary")

        assert.isTrue(
          yield* managedDatabaseNameExistsEffect(relayOne, "Primary")
        )
        assert.isFalse(
          yield* managedDatabaseNameExistsEffect(relayOne, "Other")
        )
        assert.isFalse(
          yield* managedDatabaseNameExistsEffect(relayTwo, "Primary")
        )
      })
    )

    it.effect("renames a database unless another on its Relay has the name", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay(relayOne)
        yield* insertRelay(relayTwo)
        yield* insertManagedDatabase(relayOne, "primary-id", "Primary")
        yield* insertManagedDatabase(relayOne, "replica-id", "Replica")
        yield* insertManagedDatabase(relayTwo, "elsewhere-id", "Elsewhere")

        const error = yield* Effect.flip(
          renameManagedDatabaseRecordEffect(relayOne, "replica-id", "Primary")
        )
        assert.match(error.message, /already exists/u)
        yield* renameManagedDatabaseRecordEffect(
          relayOne,
          "replica-id",
          "Elsewhere"
        )

        const names = (yield* listManagedDatabaseRecordsEffect()).map(
          (record) => [record.databaseId, record.name]
        )
        assert.deepStrictEqual(names.sort(([left], [right]) => left.localeCompare(right)), [
          ["elsewhere-id", "Elsewhere"],
          ["primary-id", "Primary"],
          ["replica-id", "Elsewhere"],
        ])
      })
    )

  })
})
