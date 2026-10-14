import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import {
  databaseOverviewSchema,
  databaseQueryResultSchema,
} from "@workspace/contracts"
import { Effect } from "effect"
import { describe, expect, it, onTestFinished } from "vite-plus/test"

import { readDatabaseFile } from "./database-browser.js"

describe("Relay state database", () => {
  // The Relay's own state is a live WAL database, written while it is read.
  it("inspects live SQLite state while refusing queries that modify it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kiln-state-browser-"))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const path = join(directory, "relay.sqlite")
    const sqlite = new DatabaseSync(path)
    onTestFinished(() => sqlite.close())
    sqlite.exec(
      "PRAGMA journal_mode = WAL; CREATE TABLE node_state (name TEXT PRIMARY KEY, value TEXT); INSERT INTO node_state VALUES ('name', 'Relay One')"
    )

    const overview = databaseOverviewSchema.parse(
      await Effect.runPromise(readDatabaseFile(path, { action: "overview" }))
    )
    expect(overview.readOnly).toBe(true)
    expect(overview.tables.map((table) => table.name)).toContain("node_state")

    await expect(
      Effect.runPromise(
        readDatabaseFile(path, {
          action: "query",
          maxRows: 10,
          sql: "DELETE FROM node_state",
        })
      )
    ).rejects.toThrow("This database is open read-only")

    sqlite.exec("UPDATE node_state SET value = 'Relay Two'")
    const rows = databaseQueryResultSchema.parse(
      await Effect.runPromise(
        readDatabaseFile(path, {
          action: "query",
          maxRows: 10,
          sql: "SELECT value FROM node_state",
        })
      )
    )
    expect(rows.rows).toEqual([["Relay Two"]])
  })
})
