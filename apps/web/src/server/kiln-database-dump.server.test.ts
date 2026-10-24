import { createHash } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect, Exit, Fiber, Pull, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { createConnection } from "mysql2/promise"
import { SqlClient } from "effect/sql"

import {
  importKilnDatabaseSql,
  kilnDatabaseDump,
} from "@/server/kiln-database-dump.server"
import {
  databaseConnectionConfig,
  databaseTableName,
} from "@/lib/database-config"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertBackup, insertUser } from "@/test/seed"

const kiln = { installationId: "installation-one", now: Date.now() }

// More rows than the connection buffers, so an export is still reading
// them when it's stopped.
const insertManyRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe("DROP TABLE IF EXISTS dump_many")
  yield* sql.unsafe(
    "CREATE TABLE dump_many (id INT PRIMARY KEY, pad VARCHAR(255))"
  )
  for (let batch = 0; batch < 20; batch += 1) {
    const values = Array.from(
      { length: 5_000 },
      (_, row) => `(${batch * 5_000 + row}, REPEAT('x', 200))`
    )
    yield* sql.unsafe(
      `INSERT INTO dump_many (id, pad) VALUES ${values.join(",")}`
    )
  }
})

// An export's connection holds the only read-only transaction.
const exportTransactions = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ id: number }>`
    SELECT trx_mysql_thread_id AS id FROM information_schema.INNODB_TRX
    WHERE trx_is_read_only = 1`
)

const killExport = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [exporting] = yield* exportTransactions
  assert.isDefined(exporting)
  yield* sql.unsafe(`KILL ${Number(exporting?.id)}`)
})

// Waits on the real clock, which MySQL keeps.
function waitFor(milliseconds: number) {
  return Effect.promise(
    () => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
  )
}

// Reads the rest of an export: "failed" when it errors, which it must do
// without having written its seal.
function readToEnd(reader: ReadableStreamDefaultReader<string>) {
  return Effect.promise(async () => {
    let rest = ""
    for (;;) {
      const chunk = await reader.read().then(
        (result) => result,
        (error: unknown) => ({ error })
      )
      if ("error" in chunk) {
        return rest.includes("-- Kiln export sha256") ? "sealed" : "failed"
      }
      if (chunk.done) return "finished"
      rest += chunk.value
    }
  })
}

// Seals an altered export again, as only someone rewriting it would.
function reseal(dump: string) {
  const body = dump.slice(0, dump.lastIndexOf("-- Kiln export sha256 "))
  return `${body}-- Kiln export sha256 ${createHash("sha256").update(body, "utf8").digest("hex")}\n`
}

// The backup an import needs to come back to.
const insertRecentKilnBackup = insertBackup("kiln-backup", {
  target_kind: "platform",
  target_id: kiln.installationId,
  artifact_kind: "platform_bundle",
  created_at: kiln.now - 60_000,
})

// Values that a dump must carry exactly: the largest unsigned BIGINT,
// decimals, JSON, bytes that aren't text, millisecond times, text that needs
// escaping, NULL, and a column with an expression default.
// `length` is generated, so MySQL computes it again.
const createValues = `CREATE TABLE IF NOT EXISTS dump_values (
  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  price DECIMAL(12, 4) NULL,
  settings JSON NULL,
  bytes VARBINARY(16) NULL,
  at DATETIME(3) NULL,
  note TEXT NULL,
  stamped DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  length INT AS (CHAR_LENGTH(note)) VIRTUAL
)`

const rows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return yield* sql<Record<string, unknown>>`
    SELECT id, price, CAST(settings AS CHAR) AS settings, HEX(bytes) AS bytes,
           CAST(at AS CHAR) AS at, note, CAST(stamped AS CHAR) AS stamped,
           length
    FROM dump_values ORDER BY id`
})

describeMysql("Kiln database export", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "imports back exactly what it exported",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* resetDatabase
          yield* sql.unsafe(createValues)
          yield* sql.unsafe(`INSERT INTO dump_values
            (id, price, settings, bytes, at, note, stamped) VALUES
          (18446744073709551615, 12345678.9012, '{"a": [1, "two"], "b": null}',
           X'00FF0A27225C', '2026-06-01 12:34:56.789',
           'It''s "quoted"\\\\ and\\nnewlined; 🔥 ünïcode',
           '2001-02-03 04:05:06.007'),
          (1, NULL, NULL, NULL, NULL, NULL, '2002-03-04 05:06:07.008')`)
          yield* insertUser("user-one", { name: "O'Brien\nSecond line" })
          yield* insertRecentKilnBackup
          const exported = yield* rows

          const dump = (yield* Stream.runCollect(
            kilnDatabaseDump(new Date(Date.UTC(2026, 5, 1)))
          )).join("")
          assert.include(dump, "CREATE TABLE `dump_values`")

          // Whatever changed since, importing the dump puts it back.
          yield* sql.unsafe("DELETE FROM dump_values WHERE id = 1")
          yield* sql.unsafe(
            "UPDATE dump_values SET note = 'changed', bytes = NULL"
          )
          yield* sql.unsafe("INSERT INTO dump_values (id) VALUES (7)")
          yield* sql`UPDATE ${sql(databaseTableName("user"))}
          SET name = 'changed' WHERE id = 'user-one'`
          yield* importKilnDatabaseSql(dump, kiln)

          assert.deepStrictEqual(yield* rows, exported)
          const users = yield* sql<{ name: string }>`
          SELECT name FROM ${sql(databaseTableName("user"))}
          WHERE id = 'user-one'`
          assert.deepStrictEqual(users, [{ name: "O'Brien\nSecond line" }])
        }).pipe(
          Effect.ensuring(
            Effect.flatMap(SqlClient.SqlClient, (sql) =>
              sql.unsafe("DROP TABLE IF EXISTS dump_values")
            ).pipe(Effect.orDie)
          )
        ),
      // It writes and replaces every table in the test database.
      60_000
    )

    it.effect(
      "leaves every table as it was when any row fails to import",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* resetDatabase
          yield* sql.unsafe(createValues)
          yield* sql.unsafe(
            "INSERT INTO dump_values (id, note) VALUES (42, 'exported')"
          )
          yield* insertUser("user-one", { name: "Exported" })
          yield* insertRecentKilnBackup
          const dump = (yield* Stream.runCollect(
            kilnDatabaseDump(new Date(kiln.now))
          )).join("")
          yield* sql.unsafe("UPDATE dump_values SET note = 'current'")
          yield* sql`UPDATE ${sql(databaseTableName("user"))}
            SET name = 'Current' WHERE id = 'user-one'`

          // A value MySQL refuses, in a file that is otherwise whole.
          const failing = reseal(dump.replace("('42',", "('not a number',"))
          assert.notStrictEqual(failing, dump)
          yield* Effect.flip(importKilnDatabaseSql(failing, kiln))

          assert.deepStrictEqual(
            yield* sql`SELECT CAST(id AS CHAR) AS id, note FROM dump_values`,
            [{ id: "42", note: "current" }]
          )
          assert.deepStrictEqual(
            yield* sql`SELECT name FROM ${sql(databaseTableName("user"))}`,
            [{ name: "Current" }]
          )
        }).pipe(
          Effect.ensuring(
            Effect.flatMap(SqlClient.SqlClient, (sql) =>
              sql.unsafe("DROP TABLE IF EXISTS dump_values")
            ).pipe(Effect.orDie)
          )
        ),
      // It writes every table in the test database.
      60_000
    )

    it.effect(
      "fails without a seal, and without taking Hearth down, when its connection is lost",
      () =>
        // On the real clock, as the export's own timeouts and MySQL are.
        TestClock.withLive(
          Effect.gen(function* () {
            yield* resetDatabase
            yield* insertManyRows
            const reader = Stream.toReadableStream(
              kilnDatabaseDump(new Date(kiln.now))
            ).getReader()
            let received = ""
            while (!received.includes("INSERT INTO `dump_many`")) {
              const chunk = yield* Effect.promise(() => reader.read())
              if (chunk.done) break
              received += chunk.value
            }
            yield* killExport

            const ended = yield* readToEnd(reader)
            assert.strictEqual(ended, "failed")
          })
        ).pipe(
          Effect.ensuring(
            Effect.flatMap(SqlClient.SqlClient, (sql) =>
              sql.unsafe("DROP TABLE IF EXISTS dump_many")
            ).pipe(Effect.orDie)
          )
        ),
      60_000
    )

    it.effect(
      "fails without a seal when its connection is lost between tables",
      () =>
        // On the real clock, as the export's own timeouts and MySQL are.
        TestClock.withLive(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* resetDatabase
            yield* sql.unsafe(
              "CREATE TABLE IF NOT EXISTS dump_a (id INT PRIMARY KEY)"
            )
            yield* sql.unsafe(
              "CREATE TABLE IF NOT EXISTS dump_b (id INT PRIMARY KEY)"
            )
            yield* sql.unsafe("INSERT INTO dump_a (id) VALUES (1)")
            yield* sql.unsafe("INSERT INTO dump_b (id) VALUES (1)")
            // Pulled one chunk at a time, so nothing is read ahead: up to
            // dump_b's definition, before its rows are asked for.
            const pull = yield* Stream.toPull(
              kilnDatabaseDump(new Date(kiln.now))
            )
            let received = ""
            while (!received.includes("CREATE TABLE `dump_b`")) {
              received += (yield* pull).join("")
            }
            yield* killExport
            yield* waitFor(200)

            let ended: "failed" | "finished" | null = null
            while (ended === null) {
              const step = yield* Effect.exit(pull)
              if (Exit.isSuccess(step)) received += step.value.join("")
              else ended = Pull.isDoneCause(step.cause) ? "finished" : "failed"
            }
            assert.strictEqual(ended, "failed")
            assert.notInclude(received, "-- Kiln export sha256")
          })
        ).pipe(
          Effect.scoped,
          Effect.ensuring(
            Effect.flatMap(SqlClient.SqlClient, (sql) =>
              sql.unsafe("DROP TABLE IF EXISTS dump_a, dump_b")
            ).pipe(Effect.orDie)
          )
        ),
      60_000
    )

    it.effect(
      "lets go of its connection when cancelled while a query waits",
      () =>
        // On the real clock, as the export's own timeouts and MySQL are.
        TestClock.withLive(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* resetDatabase
            yield* sql.unsafe("DROP TABLE IF EXISTS dump_many")
            yield* sql.unsafe("CREATE TABLE dump_many (id INT PRIMARY KEY)")
            yield* sql.unsafe("INSERT INTO dump_many (id) VALUES (1), (2)")
            // Another session's write lock holds the export's SELECT.
            const locker = yield* Effect.acquireRelease(
              Effect.promise(() =>
                createConnection(databaseConnectionConfig())
              ),
              (connection) => Effect.promise(() => connection.end())
            )
            const scope = yield* Scope.make()
            const pull = yield* Stream.toPull(
              kilnDatabaseDump(new Date(kiln.now))
            ).pipe(Scope.provide(scope))
            let received = ""
            while (!received.includes("CREATE TABLE `dump_many`")) {
              received += (yield* pull).join("")
            }
            yield* Effect.promise(() =>
              locker.query("LOCK TABLES dump_many WRITE")
            )
            const waiting = yield* Effect.forkChild(pull)
            yield* waitFor(500)

            // Cancelling ends the export without waiting for the SELECT.
            yield* Fiber.interrupt(waiting)
            const outcome = yield* Effect.raceFirst(
              Scope.close(scope, Exit.void).pipe(Effect.as("closed" as const)),
              waitFor(15_000).pipe(Effect.as("stuck" as const))
            )
            yield* Effect.promise(() => locker.query("UNLOCK TABLES"))
            assert.strictEqual(outcome, "closed")
          })
        ).pipe(
          Effect.scoped,
          Effect.ensuring(
            Effect.flatMap(SqlClient.SqlClient, (sql) =>
              sql.unsafe("DROP TABLE IF EXISTS dump_many")
            ).pipe(Effect.orDie)
          )
        ),
      60_000
    )

    it.effect(
      "refuses an incomplete export, one from another schema, and one without a recent Kiln backup",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRecentKilnBackup
          const dump = (yield* Stream.runCollect(
            kilnDatabaseDump(new Date(kiln.now))
          )).join("")
          const refusal = (sql: string, at = kiln) =>
            Effect.flip(importKilnDatabaseSql(sql, at)).pipe(
              Effect.map((error) => error.refusal)
            )

          assert.strictEqual(
            yield* refusal("DROP TABLE IF EXISTS anything;"),
            "not_kiln_export"
          )
          // Cut short, or with an INSERT's rows left out.
          assert.strictEqual(
            yield* refusal(
              dump.slice(0, dump.lastIndexOf("SET UNIQUE_CHECKS"))
            ),
            "changed"
          )
          assert.strictEqual(
            yield* refusal(dump.replace(/^INSERT INTO /mu, "insert into ")),
            "changed"
          )
          // Even resealed, a file must hold only what Kiln writes.
          assert.strictEqual(
            yield* refusal(
              reseal(dump.replace(/^INSERT INTO /mu, "insert into "))
            ),
            "changed"
          )
          assert.strictEqual(
            yield* refusal(
              reseal(dump.replace(/^-- Kiln schema \d+$/mu, "-- Kiln schema 1"))
            ),
            "other_schema"
          )
          assert.strictEqual(
            yield* refusal(dump, { ...kiln, now: kiln.now + 2 * 86_400_000 }),
            "no_recent_backup"
          )
        }),
      // It writes every table in the test database.
      60_000
    )
  })
})
