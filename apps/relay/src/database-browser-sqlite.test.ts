import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { assert, describe, it } from "@effect/vitest"

import {
  DatabaseBrowserError,
  openSqliteDatabase,
  splitSqlStatements,
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
  it("splits scripts without breaking quotes, comments, or triggers", () => {
    assert.deepStrictEqual(
      splitSqlStatements(`
        SELECT ';' AS "a;b"; -- trailing ; comment
        /* ; */ CREATE TRIGGER t AFTER INSERT ON x BEGIN
          UPDATE y SET z = CASE WHEN z THEN 1 ELSE 2 END; DELETE FROM y;
        END;
        ;
      `),
      [
        `SELECT ';' AS "a;b"`,
        `-- trailing ; comment\n        /* ; */ CREATE TRIGGER t AFTER INSERT ON x BEGIN\n          UPDATE y SET z = CASE WHEN z THEN 1 ELSE 2 END; DELETE FROM y;\n        END`,
      ]
    )
  })

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
        assert.deepStrictEqual(alex, { rowid: 1, uuid: "a" })
        assert.throws(
          () =>
            sqliteMutate(database, {
              action: "mutate",
              table: "players",
              changes: [
                {
                  kind: "update",
                  key: alex ?? {},
                  original: { name: "Alex" },
                  values: { name: "Alexa" },
                },
                {
                  kind: "update",
                  key: steve ?? {},
                  original: { name: "Herobrine" },
                  values: { name: "Notch" },
                },
              ],
            }),
          /no longer matches/u
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
        assert.throws(() => deleteSecond(2), /no longer matches/u)
        assert.deepStrictEqual(messages(), ["second", "third"])
        assert.deepStrictEqual(deleteSecond(1), { applied: 1 })
        assert.deepStrictEqual(messages(), ["third"])
      } finally {
        database.close()
      }
    })
  })

  it("changes one row even when primary keys repeat as NULL", () => {
    withDatabase((path) => {
      const database = openSqliteDatabase(path, false)
      try {
        database.exec(
          "INSERT INTO players VALUES (NULL, 'x', 1), (NULL, 'y', 2)"
        )
        const page = sqliteRows(database, {
          action: "rows",
          limit: 10,
          offset: 0,
          table: "players",
        })
        const nullKey = page.keys?.find((key) => key.uuid === null)
        assert.deepStrictEqual(
          sqliteMutate(database, {
            action: "mutate",
            table: "players",
            changes: [
              {
                kind: "delete",
                key: nullKey ?? {},
                original: { balance: 1, name: "x", uuid: null },
              },
            ],
          }),
          { applied: 1 }
        )
      } finally {
        database.close()
      }
    })
  })

  it("never commits a cancelled job", () => {
    withDatabase((path) => {
      const database = openSqliteDatabase(path, false)
      try {
        // The Relay refuses the commit, as it would after a timeout.
        const refused = {
          claimCommit() {
            throw new DatabaseBrowserError("cancelled", "cancelled")
          },
        }
        assert.throws(
          () =>
            sqliteQuery(
              database,
              {
                action: "query",
                maxRows: 10,
                sql: "UPDATE players SET balance = 0; DELETE FROM log",
              },
              { job: refused, writable: true }
            ),
          /cancelled/u
        )
        const read = (sql: string) =>
          sqliteQuery(database, { action: "query", maxRows: 10, sql }).rows
        assert.deepStrictEqual(
          read("SELECT balance FROM players ORDER BY uuid"),
          [[10.5], [3]]
        )
        assert.deepStrictEqual(read("SELECT count(*) FROM log"), [[2]])
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
