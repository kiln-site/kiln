import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import {
  databaseOverviewSchema,
  databaseQueryResultSchema,
} from "@workspace/contracts"
import { Effect } from "effect"
import { describe, expect, it, onTestFinished } from "vite-plus/test"

import { loadConfig, relayStateDatabasePath } from "./config.js"
import { RelayStateDatabase } from "./relay-state-database.js"

describe("Relay state database", () => {
  it("inspects live SQLite state while refusing queries that modify it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kiln-state-browser-"))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const config = loadConfig({
      NODE_ENV: "test",
      KILN_RELAY_DATA_DIR: directory,
    })
    const path = relayStateDatabasePath(config)
    await mkdir(dirname(path), { recursive: true })
    const sqlite = new DatabaseSync(path)
    try {
      sqlite.exec(
        "CREATE TABLE node_state (name TEXT PRIMARY KEY, value TEXT); INSERT INTO node_state VALUES ('name', 'Relay One')"
      )
      const database = new RelayStateDatabase(config)
      const overview = databaseOverviewSchema.parse(
        await Effect.runPromise(database.read({ action: "overview" }))
      )
      expect(overview.readOnly).toBe(true)
      expect(overview.tables.some((table) => table.name === "node_state")).toBe(
        true
      )
      await expect(
        Effect.runPromise(
          database.read({
            action: "query",
            maxRows: 10,
            sql: "DELETE FROM node_state",
          })
        )
      ).rejects.toThrow()
      sqlite.exec("UPDATE node_state SET value = 'Relay Two'")
      const rows = databaseQueryResultSchema.parse(
        await Effect.runPromise(
          database.read({
            action: "query",
            maxRows: 10,
            sql: "SELECT value FROM node_state",
          })
        )
      )
      expect(rows.rows).toEqual([["Relay Two"]])
    } finally {
      sqlite.close()
    }
  })
})
