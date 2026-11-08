import * as MysqlClient from "@effect/sql-mysql2/MysqlClient"
import { Cause, Clock, Effect, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { isSqlError } from "effect/sql/SqlError"

import { databaseTableName } from "@/lib/database-config"
import { migrations } from "@/migrations"

import { databaseClientConfig } from "./database"
import { MigrationError } from "./errors"
import {
  dropMigrationSnapshot,
  restoreMigrationSnapshot,
  takeMigrationSnapshot,
} from "./migration-snapshot"

export interface Migration {
  readonly id: number
  readonly name: string
  // MySQL commits DDL immediately, so a migration can stop partway. Each
  // one must be safe to run again after a crash.
  readonly run: Effect.Effect<void, unknown, SqlClient.SqlClient>
}

// Runs migrations before Hearth serves requests. Effect's Migrator records
// pending migrations before running them, which MySQL's implicit DDL commits
// would leave marked as applied after a failure, so Kiln records each
// migration only once it finishes.
export function migrateDatabase(): Promise<void> {
  return Effect.runPromise(
    applyMigrations(migrations).pipe(
      Effect.provide(MysqlClient.layer(databaseClientConfig(2))),
      // MySQL can still be starting alongside Hearth.
      Effect.retry({
        schedule: Schedule.spaced("2 seconds"),
        times: 30,
        while: (error) =>
          isSqlError(error) && error.reason._tag === "ConnectionError",
      })
    )
  )
}

export const applyMigrations = Effect.fn("database.migrate")(function* (
  pending: ReadonlyArray<Migration>
) {
  const sql = yield* SqlClient.SqlClient
  const ledger = databaseTableName("schema_migration")
  yield* validateOrder(pending)
  yield* sql`
    CREATE TABLE IF NOT EXISTS ${sql(ledger)} (
      id INT UNSIGNED NOT NULL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at BIGINT NOT NULL
    )
  `
  yield* lockMigrations(ledger)
  // A start that stopped while migrating, or while restoring, left its
  // snapshot: put the database back as it was before that update first.
  if (yield* restoreMigrationSnapshot()) {
    yield* Effect.logWarning(
      "Restored the database from before an update that didn't finish"
    )
  }
  const rows = yield* sql<{ id: number }>`SELECT id FROM ${sql(ledger)}`
  const applied = new Set(rows.map((row) => row.id))
  const due = pending.filter((migration) => !applied.has(migration.id))
  if (due.length === 0) return
  // A new database has nothing to lose.
  const snapshot = applied.size > 0
  if (snapshot) yield* takeMigrationSnapshot()
  yield* runMigrations(ledger, due).pipe(
    // A failed migration puts back the database it started from, so the
    // release Hearth rolls back to runs on it. Interrupted, as when the
    // process stops, the next start restores it.
    Effect.catchCause((cause) =>
      !snapshot || Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : restoreMigrationSnapshot().pipe(
            Effect.andThen(
              Effect.logError(
                "A migration failed; restored the database from before this update"
              )
            ),
            Effect.andThen(Effect.failCause(cause))
          )
    )
  )
  if (snapshot) yield* dropMigrationSnapshot()
}, Effect.scoped)

const runMigrations = Effect.fnUntraced(function* (
  ledger: string,
  due: ReadonlyArray<Migration>
) {
  const sql = yield* SqlClient.SqlClient
  for (const migration of due) {
    yield* migration.run.pipe(
      Effect.mapError(
        (cause) =>
          new MigrationError({
            message: `Migration ${migration.id}_${migration.name} failed`,
            cause,
          })
      ),
      Effect.withSpan(`database.migrate.${migration.id}_${migration.name}`)
    )
    const appliedAt = yield* Clock.currentTimeMillis
    yield* sql`
      INSERT INTO ${sql(ledger)} ${sql.insert({
        id: migration.id,
        name: migration.name,
        applied_at: appliedAt,
      })}
    `
    yield* Effect.log(`Applied migration ${migration.id}_${migration.name}`)
  }
})

function validateOrder(pending: ReadonlyArray<Migration>) {
  const ordered = pending.every(
    (migration, index) =>
      Number.isInteger(migration.id) &&
      migration.id > (pending[index - 1]?.id ?? 0)
  )
  return ordered
    ? Effect.void
    : Effect.fail(
        new MigrationError({
          message: "Migration ids must be unique and in ascending order",
        })
      )
}

// Lock names are limited to 64 characters.
const lockName = "LEFT(SHA2(CONCAT(DATABASE(), '.', ?), 256), 64)"

// Serializes Hearth processes that start together. The lock belongs to one
// reserved connection and is released when the scope closes.
const lockMigrations = Effect.fnUntraced(function* (ledger: string) {
  const sql = yield* SqlClient.SqlClient
  const connection = yield* sql.reserve
  const [row] = yield* connection.execute(
    `SELECT GET_LOCK(${lockName}, 60) AS acquired`,
    [ledger],
    undefined
  )
  if (row?.acquired !== 1) {
    return yield* new MigrationError({
      message: "Timed out waiting for another Hearth to finish migrating",
    })
  }
  yield* Effect.addFinalizer(() =>
    connection
      .execute(`SELECT RELEASE_LOCK(${lockName})`, [ledger], undefined)
      .pipe(Effect.ignore)
  )
})
