import { expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import { migrations } from "@/migrations"
import { describeMysql, testDatabaseClient } from "@/test/database"

import { applyMigrations } from "./migrations"

const migrationIds = migrations.map((migration) => migration.id)

describeMysql("database migrations", () => {
  // Drops and rebuilds tables, so it gets a database of its own.
  layer(testDatabaseClient(`${process.env.DB_NAME}_migrations`))((it) => {
    const dropAllTables = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const tables = yield* sql<{ name: string }>`
            SELECT table_name AS name FROM information_schema.tables
            WHERE table_schema = DATABASE()
          `
          yield* sql`SET FOREIGN_KEY_CHECKS = 0`
          for (const table of tables) yield* sql`DROP TABLE ${sql(table.name)}`
          yield* sql`SET FOREIGN_KEY_CHECKS = 1`
        })
      )
    })

    const ledger = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ id: number }>`
        SELECT id FROM kiln_schema_migration ORDER BY id
      `
      return rows.map((row) => row.id)
    })

    it.effect(
      "builds the schema on an empty database, and once only",
      () =>
        Effect.gen(function* () {
          yield* dropAllTables
          yield* applyMigrations(migrations)
          expect(yield* ledger).toEqual(migrationIds)

          // Every start applies migrations; a built schema stays as it is.
          yield* applyMigrations(migrations)
          expect(yield* ledger).toEqual(migrationIds)
        }),
      // Building every table takes a while.
      120_000
    )

    it.effect(
      "queues each App deploy a request still asked for, once",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* dropAllTables
          // As a Hearth that kept App deploy requests left them.
          yield* applyMigrations(
            migrations.filter((migration) => migration.id <= 49)
          )
          yield* sql`SET FOREIGN_KEY_CHECKS = 0`
          yield* sql`INSERT INTO kiln_app_deployment_request
              (app_id, relay_id, push, poll, image_update, requested_at)
            VALUES (${"a".repeat(40)}, ${"r".repeat(43)}, 1, 0, 0, 5),
                   (${"b".repeat(40)}, ${"r".repeat(43)}, 0, 0, 1, 6)`
          yield* sql`SET FOREIGN_KEY_CHECKS = 1`

          yield* applyMigrations(migrations)
          const queued = yield* sql<{
            input: unknown
            queue_key: string
            state: string
          }>`
            SELECT input, queue_key, state FROM kiln_operation
             WHERE kind = 'app.deploy' ORDER BY queue_key
          `
          expect(
            queued.map((row) => ({
              ...row,
              input:
                typeof row.input === "string"
                  ? JSON.parse(row.input)
                  : row.input,
            }))
          ).toEqual([
            {
              input: {
                appId: "a".repeat(40),
                relayId: "r".repeat(43),
                requestedBy: null,
                trigger: "push",
              },
              queue_key: `${"r".repeat(43)}/${"a".repeat(40)}`,
              state: "waiting",
            },
            {
              input: {
                appId: "b".repeat(40),
                relayId: "r".repeat(43),
                requestedBy: null,
                trigger: "update",
              },
              queue_key: `${"r".repeat(43)}/${"b".repeat(40)}`,
              state: "waiting",
            },
          ])
          const [left] = yield* sql<{ count: number }>`
            SELECT COUNT(*) AS count FROM information_schema.tables
             WHERE table_schema = DATABASE()
               AND table_name = 'kiln_app_deployment_request'
          `
          expect(Number(left?.count)).toBe(0)
        }),
      120_000
    )
  })
})
