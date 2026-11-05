import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import {
  createManagedDatabaseRecordEffect,
  listManagedDatabaseRecordsEffect,
  loadManagedDatabaseCredentialEffect,
  rotateManagedDatabaseCredentialEffect,
} from "@/effect/managed-databases"
import { disposeAppRuntime } from "@/effect/runtime"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertRows } from "@/test/seed"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)
afterAll(() => disposeAppRuntime())

const now = Date.UTC(2026, 8, 1)
const relayOne = "r".repeat(43)

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
    it.effect("replaces the login it keeps for a database", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay(relayOne)
        yield* createManagedDatabaseRecordEffect({
          createdBy: "user-one",
          databaseId: "postgres-id",
          databaseName: "shop",
          engine: "postgres",
          name: "Shop",
          password: "the-old-password",
          relayId: relayOne,
          username: "shop_owner",
        })

        yield* rotateManagedDatabaseCredentialEffect(relayOne, "postgres-id", {
          password: "the-new-password",
          username: "store_admin",
        })

        const credential = yield* loadManagedDatabaseCredentialEffect(
          relayOne,
          "postgres-id"
        )
        assert.strictEqual(credential?.password, "the-new-password")
        assert.strictEqual(credential?.username, "store_admin")
      })
    )

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
  })
})
