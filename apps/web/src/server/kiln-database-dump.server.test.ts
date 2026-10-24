import { assert, layer } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { SqlClient } from "effect/sql"

import {
  importKilnDatabaseSql,
  kilnDatabaseDump,
} from "@/server/kiln-database-dump.server"
import { databaseTableName } from "@/lib/database-config"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertUser } from "@/test/seed"

// Values that a dump must carry exactly: the largest unsigned BIGINT,
// decimals, JSON, bytes that aren't text, millisecond times, text that needs
// escaping, and NULL. `length` is generated, so MySQL computes it again.
const createValues = `CREATE TABLE IF NOT EXISTS dump_values (
  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  price DECIMAL(12, 4) NULL,
  settings JSON NULL,
  bytes VARBINARY(16) NULL,
  at DATETIME(3) NULL,
  note TEXT NULL,
  length INT AS (CHAR_LENGTH(note)) VIRTUAL
)`

const rows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return yield* sql<Record<string, unknown>>`
    SELECT id, price, CAST(settings AS CHAR) AS settings, HEX(bytes) AS bytes,
           CAST(at AS CHAR) AS at, note, length
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
            (id, price, settings, bytes, at, note) VALUES
          (18446744073709551615, 12345678.9012, '{"a": [1, "two"], "b": null}',
           X'00FF0A27225C', '2026-06-01 12:34:56.789',
           'It''s "quoted"\\\\ and\\nnewlined; 🔥 ünïcode'),
          (1, NULL, NULL, NULL, NULL, NULL)`)
          yield* insertUser("user-one", { name: "O'Brien\nSecond line" })
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
          yield* importKilnDatabaseSql(dump)

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
  })
})
