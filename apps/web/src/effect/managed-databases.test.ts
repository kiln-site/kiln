import { assert, describe, layer } from "@effect/vitest"
import { Effect, Layer } from "effect"
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise"

import { Database } from "./database"
import {
  deleteManagedDatabaseRecordEffect,
  listManagedDatabaseDirectoryEffect,
  listManagedDatabaseRecordsEffect,
  managedDatabaseNameExistsEffect,
} from "./managed-databases"

const emptyResult: ResultSetHeader = {
  affectedRows: 0,
  changedRows: 0,
  constructor: { name: "ResultSetHeader" },
  fieldCount: 0,
  info: "",
  insertId: 0,
  serverStatus: 0,
  warningStatus: 0,
}

const statements: Array<{
  sql: string
  values: ReadonlyArray<unknown>
}> = []
const queries: Array<{
  operation: string
  sql: string
  values: ReadonlyArray<unknown>
}> = []
const directoryRows: Array<{
  database_id: string
  engine: string
  name: string
  relay_id: string
}> = []

const databaseLayer = Layer.succeed(Database)({
  execute: () => Effect.die("Unexpected standalone database write"),
  queryRows: <TRow extends RowDataPacket>(
    operation: string,
    sql: string,
    values?: Array<boolean | Buffer | Date | null | number | string>
  ) =>
    Effect.sync(() => {
      queries.push({ operation, sql, values: values ?? [] })
      return (operation === "managed_databases_directory"
        ? directoryRows
        : []) as unknown as ReadonlyArray<TRow>
    }),
  transaction: (_operation, run) =>
    run({
      execute: (sql, values) =>
        Effect.sync(() => {
          statements.push({ sql, values: values ?? [] })
          return emptyResult
        }),
      queryRows: () => Effect.succeed([]),
    }),
})

describe("managed database persistence", () => {
  layer(databaseLayer)((it) => {
    it.effect("lists metadata without loading encrypted passwords", () =>
      Effect.gen(function* () {
        queries.length = 0

        yield* listManagedDatabaseRecordsEffect()

        assert.strictEqual(queries.length, 1)
        assert.notInclude(queries[0]?.sql, "password_ciphertext")
        assert.notInclude(queries[0]?.sql, "username")
      })
    )

    it.effect(
      "loads only the fields needed by global database navigation",
      () =>
        Effect.gen(function* () {
          queries.length = 0
          directoryRows.splice(
            0,
            directoryRows.length,
            {
              database_id: "postgres-id",
              engine: "postgres",
              name: "Postgres",
              relay_id: "relay-one",
            },
            {
              database_id: "redis-id",
              engine: "redis",
              name: "Redis",
              relay_id: "relay-one",
            },
            {
              database_id: "valkey-id",
              engine: "valkey",
              name: "Valkey",
              relay_id: "relay-one",
            }
          )

          const directory = yield* listManagedDatabaseDirectoryEffect()

          assert.strictEqual(queries.length, 1)
          assert.include(queries[0]?.sql, "database_id, relay_id, name")
          assert.include(queries[0]?.sql, "engine")
          assert.notInclude(queries[0]?.sql, "password_ciphertext")
          assert.deepEqual(
            directory.map(({ name, supportsImportExport }) => ({
              name,
              supportsImportExport,
            })),
            [
              { name: "Postgres", supportsImportExport: true },
              { name: "Redis", supportsImportExport: false },
              { name: "Valkey", supportsImportExport: false },
            ]
          )
        })
    )

    it.effect("checks a Relay-scoped name before provisioning", () =>
      Effect.gen(function* () {
        queries.length = 0

        const exists = yield* managedDatabaseNameExistsEffect(
          "relay-one",
          "Primary"
        )

        assert.isFalse(exists)
        assert.strictEqual(
          queries[0]?.operation,
          "managed_database_name_exists"
        )
        assert.include(queries[0]?.sql, "WHERE relay_id = ? AND name = ?")
        assert.deepEqual(queries[0]?.values, ["relay-one", "Primary"])
      })
    )

    it.effect(
      "removes grants, pending invitations, credentials, and resource presets",
      () =>
        Effect.gen(function* () {
          statements.length = 0

          yield* deleteManagedDatabaseRecordEffect("relay-one", "database-one")

          assert.strictEqual(statements.length, 4)
          assert.include(statements[0]?.sql, "database_id = ?")
          assert.include(statements[0]?.sql, "accepted_at IS NULL")
          assert.include(statements[0]?.sql, "revoked_at IS NULL")
          assert.include(
            statements[0]?.sql,
            "expires_at > CURRENT_TIMESTAMP(3)"
          )
          assert.deepEqual(statements[0]?.values, ["relay-one", "database-one"])
          assert.include(statements[1]?.sql, "database_id = ?")
          assert.deepEqual(statements[1]?.values, ["relay-one", "database-one"])
          assert.include(statements[2]?.sql, "DELETE FROM")
          assert.include(statements[2]?.sql, "resource_type = 'database'")
          assert.deepEqual(statements[2]?.values, ["relay-one", "database-one"])
          assert.include(statements[3]?.sql, "permission_preset")
          assert.include(statements[3]?.sql, "resource_type = 'database'")
          assert.deepEqual(statements[3]?.values, ["relay-one", "database-one"])
        })
    )
  })
})
