import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { assert, describe, it } from "@effect/vitest"

import {
  openSqliteDatabase,
  sqliteMutate,
  sqliteQuery,
  sqliteRows,
} from "./database-browser-sqlite.js"

function withDatabase(run: (path: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "kiln-sqlite-"))
  try {
    const path = join(directory, "test.db")
    const database = openSqliteDatabase(path, false)
    database.exec(`
      CREATE TABLE players (uuid TEXT PRIMARY KEY, name TEXT, balance REAL);
      CREATE TABLE log (message TEXT);
      INSERT INTO players VALUES ('a', 'Alex', 10.5), ('b', 'Steve', 3);
      INSERT INTO log VALUES ('first'), ('second');
    `)
    database.close()
    run(path)
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
}

describe("SQLite database browser", () => {
  it("rejects stale edits and keeps the transaction atomic", () => {
    withDatabase((path) => {
      const database = openSqliteDatabase(path, false)
      try {
        const [alex, steve] =
          sqliteRows(database, {
            action: "rows",
            limit: 10,
            offset: 0,
            table: "players",
          }).keys ?? []
        assert.deepStrictEqual(alex, { rowid: 1 })
        // The second change conflicts, so the first one is rolled back too,
        // and the conflict reports the row as it is now.
        assert.deepStrictEqual(
          sqliteMutate(database, {
            action: "mutate",
            table: "players",
            changes: [
              {
                kind: "update",
                key: alex ?? {},
                original: { balance: 10.5, name: "Alex", uuid: "a" },
                values: { name: "Alexa" },
              },
              {
                kind: "update",
                key: steve ?? {},
                original: { balance: 3, name: "Herobrine", uuid: "b" },
                values: { name: "Notch" },
              },
            ],
          }),
          {
            applied: 0,
            conflicts: [
              {
                change: 1,
                current: { balance: 3, name: "Steve", uuid: "b" },
              },
            ],
          }
        )
        // A change whose loaded row is incomplete (say, a hidden column was
        // left out) is refused rather than checked partially.
        assert.throws(
          () =>
            sqliteMutate(database, {
              action: "mutate",
              table: "players",
              changes: [
                {
                  kind: "delete",
                  key: alex ?? {},
                  original: { name: "Alex", uuid: "a" },
                },
              ],
            }),
          /missing the original value of balance/u
        )
        const rows = sqliteRows(database, {
          action: "rows",
          limit: 10,
          offset: 0,
          table: "players",
        })
        assert.deepStrictEqual(rows.rows, [
          ["a", "Alex", 10.5],
          ["b", "Steve", 3],
        ])
      } finally {
        database.close()
      }
    })
  })

  it("guards keyless rows against rowids renumbered by VACUUM", () => {
    withDatabase((path) => {
      const database = openSqliteDatabase(path, false)
      try {
        database.exec("INSERT INTO log VALUES ('third')")
        const messages = () =>
          sqliteRows(database, {
            action: "rows",
            limit: 10,
            offset: 0,
            table: "log",
          }).rows.map(([message]) => message)
        const page = sqliteRows(database, {
          action: "rows",
          limit: 10,
          offset: 0,
          search: "sec",
          table: "log",
        })
        assert.deepStrictEqual(page.keys, [{ rowid: 2 }])
        // Another program removes "first" and vacuums, so "third" now holds
        // rowid 2.
        const other = new DatabaseSync(path)
        other.exec("DELETE FROM log WHERE message = 'first'; VACUUM")
        other.close()
        const deleteSecond = (rowid: number) =>
          sqliteMutate(database, {
            action: "mutate",
            table: "log",
            changes: [
              {
                kind: "delete",
                key: { rowid },
                original: { message: "second" },
              },
            ],
          })
        assert.deepStrictEqual(deleteSecond(2), {
          applied: 0,
          conflicts: [{ change: 0, current: { message: "third" } }],
        })
        assert.deepStrictEqual(messages(), ["second", "third"])
        assert.deepStrictEqual(deleteSecond(1), { applied: 1, conflicts: [] })
        assert.deepStrictEqual(messages(), ["third"])
      } finally {
        database.close()
      }
    })
  })

  it("blocks queries from reaching other files and writing read-only", () => {
    withDatabase((path) => {
      const readOnly = openSqliteDatabase(path, true)
      try {
        assert.throws(() =>
          sqliteQuery(readOnly, {
            action: "query",
            maxRows: 10,
            sql: `ATTACH '${path}-other' AS other`,
          })
        )
        assert.throws(() =>
          sqliteQuery(readOnly, {
            action: "query",
            maxRows: 10,
            sql: "DELETE FROM log",
          })
        )
      } finally {
        readOnly.close()
      }
    })
  })
})
