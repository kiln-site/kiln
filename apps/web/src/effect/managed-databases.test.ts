import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import {
  deleteManagedDatabaseRecordEffect,
  listManagedDatabaseDirectoryEffect,
  listManagedDatabaseRecordsEffect,
  managedDatabaseNameExistsEffect,
} from "@/effect/managed-databases"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertGrant, insertRelay, insertRows, selectRows } from "@/test/seed"

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

const insertInvitation = (
  id: string,
  databaseId: string,
  row: Record<string, number | null> = {}
) =>
  insertRows("invitation", {
    id,
    token_hash: id.padEnd(64, "0"),
    email: `${id}@example.test`,
    relay_id: relayOne,
    database_id: databaseId,
    invited_by: "user-one",
    expires_at: now + 60_000,
    created_at: now,
    ...row,
  })

const insertPreset = (id: string, resourceId: string) =>
  insertRows("permission_preset", {
    id,
    relay_id: relayOne,
    resource_type: "database",
    resource_id: resourceId,
    name: id,
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

    it.effect("lists the navigation directory with import support", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay(relayOne)
        yield* insertManagedDatabase(relayOne, "valkey-id", "Valkey", "valkey")
        yield* insertManagedDatabase(relayOne, "redis-id", "Redis", "redis")
        yield* insertManagedDatabase(relayOne, "postgres-id", "Postgres")

        const directory = yield* listManagedDatabaseDirectoryEffect()

        assert.deepStrictEqual(directory, [
          {
            databaseId: "postgres-id",
            name: "Postgres",
            relayId: relayOne,
            supportsImportExport: true,
          },
          {
            databaseId: "redis-id",
            name: "Redis",
            relayId: relayOne,
            supportsImportExport: false,
          },
          {
            databaseId: "valkey-id",
            name: "Valkey",
            relayId: relayOne,
            supportsImportExport: false,
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

    it.effect(
      "removes the database with its grants, pending invitations, and presets",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* TestClock.setTime(now)
          yield* insertRelay(relayOne)
          yield* insertManagedDatabase(relayOne, "database-one", "One")
          yield* insertManagedDatabase(relayOne, "database-two", "Two")
          yield* insertGrant({
            id: "grant-one",
            relayId: relayOne,
            resourceId: "database-one",
            resourceType: "database",
            userId: "user-one",
          })
          yield* insertGrant({
            id: "grant-two",
            relayId: relayOne,
            resourceId: "database-two",
            resourceType: "database",
            userId: "user-one",
          })
          yield* insertGrant({
            id: "grant-instance",
            relayId: relayOne,
            resourceId: "database-one",
            resourceType: "instance",
            userId: "user-one",
          })
          yield* insertInvitation("pending", "database-one")
          yield* insertInvitation("accepted", "database-one", {
            accepted_at: now - 1_000,
          })
          yield* insertInvitation("revoked", "database-one", {
            revoked_at: now - 1_000,
          })
          yield* insertInvitation("expired", "database-one", {
            expires_at: now,
          })
          yield* insertInvitation("other-database", "database-two")
          yield* insertPreset("preset-one", "database-one")
          yield* insertPreset("preset-two", "database-two")

          yield* deleteManagedDatabaseRecordEffect(relayOne, "database-one")

          const ids = <T extends Record<string, unknown>>(
            rows: ReadonlyArray<T>,
            key: keyof T
          ) => rows.map((row) => row[key])
          assert.sameMembers(
            ids(
              yield* selectRows<{ database_id: string }>("database"),
              "database_id"
            ),
            ["database-two"]
          )
          assert.sameMembers(
            ids(yield* selectRows<{ id: string }>("access_grant"), "id"),
            ["grant-two", "grant-instance"]
          )
          assert.sameMembers(
            ids(yield* selectRows<{ id: string }>("invitation"), "id"),
            ["accepted", "revoked", "expired", "other-database"]
          )
          assert.sameMembers(
            ids(yield* selectRows<{ id: string }>("permission_preset"), "id"),
            ["preset-two"]
          )
        })
    )
  })
})
