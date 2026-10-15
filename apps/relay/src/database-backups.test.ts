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
import { relayHarness, TEST_NAMESPACE } from "./test/relay.js"

const databaseId = "d".repeat(40)
const dump = "CREATE TABLE players (name text);\nINSERT INTO players VALUES ('alex');\n"

async function harnessWithDatabase(engine: "mysql" | "postgres") {
  const harness = await relayHarness()
  await harness.databases.create(
    relayCreateDatabaseSchema.parse({
      databaseName: "kiln_app",
      engine,
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
      const { container, directory, harness } = await harnessWithDatabase(engine)
      container.sqlDump = dump
      const destination = join(directory, "backup.sql.gz")

      const progress = { completed: 0, total: 0 }
      await createCompressedDatabaseBackup(
        harness.databases,
        backupInput(),
        destination,
        progress
      )

      expect(gunzipSync(await readFile(destination)).toString("utf8")).toBe(dump)
      expect(progress.completed).toBe(Buffer.byteLength(dump))

      await restoreCompressedDatabaseBackup(
        harness.databases,
        databaseId,
        destination
      )
      expect(container.executedSql).toEqual([dump])
    }
  )

  it("fails with the client's error and keeps no partial backup", async () => {
    const { container, directory, harness } = await harnessWithDatabase("postgres")
    container.sqlDump = dump
    fakeDocker.programFailures.set(
      "pg_dump",
      'pg_dump: error: connection to server failed: FATAL: role "postgres" does not exist'
    )
    const destination = join(directory, "backup.sql.gz")

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

  it("reports the client's error when it stops reading a large restore partway", async () => {
    const { directory, harness } = await harnessWithDatabase("postgres")
    fakeDocker.programFailures.set(
      "psql",
      'ERROR:  relation "players" already exists'
    )
    const source = join(directory, "large.sql.gz")
    // More than the connection buffers, so input is still being written
    // when the client exits.
    await writeFile(
      source,
      gzipSync(
        Array.from(
          { length: 200_000 },
          (_, index) => `INSERT INTO players VALUES ('player-${index}');\n`
        ).join("")
      )
    )

    await expect(
      restoreCompressedDatabaseBackup(harness.databases, databaseId, source)
    ).rejects.toThrow('relation "players" already exists')
  })

  it("fails a restore the client rejects", async () => {
    const { directory, harness } = await harnessWithDatabase("postgres")
    fakeDocker.programFailures.set("psql", "ERROR:  syntax error at or near \"CREAT\"")
    const source = join(directory, "backup.sql.gz")
    await writeFile(source, gzipSync("CREAT TABLE broken;"))

    await expect(
      restoreCompressedDatabaseBackup(harness.databases, databaseId, source)
    ).rejects.toThrow('syntax error at or near "CREAT"')
  })
})
