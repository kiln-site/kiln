import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { assert, describe, it } from "@effect/vitest"

import {
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
          UPDATE y SET z = 1; DELETE FROM y;
        END;
        ;
      `),
      [
        `SELECT ';' AS "a;b"`,
        `-- trailing ; comment\n        /* ; */ CREATE TRIGGER t AFTER INSERT ON x BEGIN\n          UPDATE y SET z = 1; DELETE FROM y;\n        END`,
      ]
    )
  })

  it("rejects stale edits and keeps the transaction atomic", () => {
    withDatabase((path) => {
      const database = openSqliteDatabase(path, false)
      try {
        assert.throws(() =>
          sqliteMutate(database, {
            action: "mutate",
            table: "players",
            changes: [
              {
                kind: "update",
                key: { uuid: "a" },
                original: { name: "Alex" },
                values: { name: "Alexa" },
              },
              {
                kind: "update",
                key: { uuid: "b" },
                original: { name: "Herobrine" },
                values: { name: "Notch" },
              },
            ],
          })
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

  it("addresses keyless tables by rowid", () => {
    withDatabase((path) => {
      const database = openSqliteDatabase(path, false)
      try {
        const page = sqliteRows(database, {
          action: "rows",
          limit: 10,
          offset: 0,
          search: "sec",
          table: "log",
        })
        assert.deepStrictEqual(page.keys, [{ rowid: 2 }])
        sqliteMutate(database, {
          action: "mutate",
          table: "log",
          changes: [{ kind: "delete", key: { rowid: 2 } }],
        })
        assert.strictEqual(
          sqliteRows(database, {
            action: "rows",
            limit: 10,
            offset: 0,
            table: "log",
          }).total,
          1
        )
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
