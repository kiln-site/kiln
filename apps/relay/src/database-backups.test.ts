import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"

import {
  relayCreateDatabaseSchema,
  type BackupCreateTaskInput,
} from "@workspace/contracts"
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import {
  createCompressedDatabaseBackup,
  restoreCompressedDatabaseBackup,
} from "./database-backups.js"
import { fakeDocker } from "./test/docker.js"
import { databaseBrick } from "./test/database-bricks.js"
import { relayHarness, TEST_NAMESPACE } from "./test/relay.js"

const databaseId = "d".repeat(12)
const dump =
  "CREATE TABLE players (name text);\nINSERT INTO players VALUES ('alex');\n"

async function harnessWithDatabase(engine: "mysql" | "postgres") {
  const harness = await relayHarness()
  await harness.databases.create(
    relayCreateDatabaseSchema.parse({
      databaseName: "kiln_app",
      ...databaseBrick(engine),
      id: databaseId,
      name: "Main database",
      password: "correct-horse-battery-staple-1",
      username: "kiln_user",
    })
  )
  const container = fakeDocker.container(
    `${TEST_NAMESPACE}-kiln-db-${databaseId}-database`
  )
  if (!container) throw new Error("The database has no container")
  const directory = await mkdtemp(join(tmpdir(), "kiln-database-backup-"))
  onTestFinished(() => rm(directory, { force: true, recursive: true }))
  return { container, directory, harness }
}

function backupInput(): BackupCreateTaskInput {
  return {
    backupId: "b".repeat(40),
    maxBytes: null,
    target: { id: databaseId, kind: "database" },
  } as unknown as BackupCreateTaskInput
}

describe("database backups", () => {
  it.each(["postgres", "mysql"] as const)(
    "stores the %s dump compressed and restores it into the database",
    async (engine) => {
      const { container, directory, harness } =
        await harnessWithDatabase(engine)
      container.sqlDump = dump
      const destination = join(directory, "backup.sql.gz")

      const progress = { completed: 0, total: 0 }
      await createCompressedDatabaseBackup(
        harness.databases,
        backupInput(),
        destination,
        progress
      )

      expect(gunzipSync(await readFile(destination)).toString("utf8")).toBe(
        dump
      )
      expect(progress.completed).toBe(Buffer.byteLength(dump))

      await restoreCompressedDatabaseBackup(
        harness.databases,
        databaseId,
        destination
      )
      expect(container.executedSql).toEqual([dump])
    }
  )

  it("refuses a dump of another engine before importing any of it", async () => {
    const { container, directory, harness } = await harnessWithDatabase("mysql")
    const source = join(directory, "postgres.sql.gz")
    await writeFile(
      source,
      gzipSync(`--\n-- PostgreSQL database dump\n--\n\n${dump}`)
    )

    await expect(
      restoreCompressedDatabaseBackup(harness.databases, databaseId, source)
    ).rejects.toThrow("PostgreSQL dump")
    expect(container.executedSql).toEqual([])

    // One of its own engine's tools still restores.
    const own = join(directory, "mysql.sql.gz")
    await writeFile(
      own,
      gzipSync(`-- MySQL dump 10.13  Distrib 8.4.7, for Linux (aarch64)\n${dump}`)
    )
    await restoreCompressedDatabaseBackup(harness.databases, databaseId, own)
    expect(container.executedSql).toHaveLength(1)
  })

  it("fails with the client's error and keeps no partial backup", async () => {
    const { container, directory, harness } =
      await harnessWithDatabase("postgres")
    container.sqlDump = dump
    fakeDocker.programFailures.set(
      "pg_dump",
      'pg_dump: error: connection to server failed: FATAL: role "postgres" does not exist'
    )
    const destination = join(directory, "backup.sql.gz")
    // The client can exit before the caller starts opening the backup file.
    const start = harness.databases.process.bind(harness.databases)
    vi.spyOn(harness.databases, "process").mockImplementationOnce(
      async (...args) => {
        const child = await start(...args)
        const code = await child.waitFor({
          timeout: 1_000,
          timedOut: "Client did not exit",
        })
        vi.spyOn(child, "waitFor").mockImplementation(async () => {
          // Deliver the buffered stderr to the backup's listener before exit.
          child.stderr.read()
          return code
        })
        return child
      }
    )

    await expect(
      createCompressedDatabaseBackup(
        harness.databases,
        backupInput(),
        destination,
        { completed: 0, total: 0 }
      )
    ).rejects.toThrow('role "postgres" does not exist')
    expect(existsSync(destination)).toBe(false)
  })
})
