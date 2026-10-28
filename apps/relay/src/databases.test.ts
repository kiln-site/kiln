import { createHash, randomBytes } from "node:crypto"
import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  relayCreateDatabaseSchema,
  type DatabaseEngine,
} from "@workspace/contracts"
import { randomUUID } from "node:crypto"

import { Effect } from "effect"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { fakeDocker } from "./test/docker.js"
import {
  provisioningWorker,
  relayHarness,
  TEST_NAMESPACE,
  type RelayHarness,
} from "./test/relay.js"
import { DockerEngine } from "./docker-engine.js"
import { controlRequestLocks, databaseLocks } from "./operation-plans.js"

const serverId = "a".repeat(40)
const password = "correct-horse-battery-staple-1"
const nextPassword = "correct-horse-battery-staple-2"

function createDatabase(
  harness: RelayHarness,
  id: string,
  engine: DatabaseEngine = "postgres"
) {
  return harness.databases.create(
    relayCreateDatabaseSchema.parse({
      databaseName: "kiln_app",
      engine,
      id,
      name: "Main database",
      password,
      username: "kiln_user",
    })
  )
}

function databaseContainer(id: string) {
  const container = fakeDocker.container(
    `${TEST_NAMESPACE}-kiln-db-${id}-database`
  )
  if (!container) throw new Error(`Database ${id} has no container`)
  return container
}

const networkOf = (id: string) => `${TEST_NAMESPACE}-kiln-db-${id}-network`
const volumeOf = (id: string) => `${TEST_NAMESPACE}-kiln-db-${id}-data`

describe("managed database recovery metadata", () => {
  it("keeps database connection details out of the status view and scopes detail reads to requested IDs", async () => {
    const harness = await relayHarness()
    const id = "d".repeat(40)
    await createDatabase(harness, id)
    await createDatabase(harness, "e".repeat(40))
    const items = await harness.databases.inventory(
      [
        { id, view: "status" },
        { id, view: "detail" },
        { id: "f".repeat(40), view: "detail" },
      ],
      new AbortController().signal
    )
    expect(items).toEqual([
      { id, view: "status", observedState: "running" },
      {
        id,
        view: "detail",
        observedState: "running",
        database: expect.objectContaining({ id, connectedInstanceIds: [] }),
      },
    ])
  })
  it("labels databases for recovery without putting credentials in labels", async () => {
    const harness = await relayHarness()
    const id = "d".repeat(40)

    await createDatabase(harness, id)

    const container = databaseContainer(id)
    expect(container.labels).toMatchObject({
      "kiln.database.engine": "postgres",
      "kiln.database.id": id,
      "kiln.database.network": networkOf(id),
      "kiln.database.volume": volumeOf(id),
      "kiln.relay.owner": TEST_NAMESPACE,
      "kiln.resource.kind": "database",
    })
    const labelText = JSON.stringify(container.labels)
    expect(labelText).not.toContain(password)
    expect(labelText).not.toMatch(/password|secret|kiln_user/iu)
    expect(container.env.POSTGRES_PASSWORD).toBe(password)
    // A fresh Relay recovers the database from Docker alone.
    const [recovered] = await (await harness.restart()).databases.list()
    expect(recovered).toMatchObject({
      engine: "postgres",
      id,
      observedState: "running",
    })
  })

  it("gives databases that share an id prefix separate resources", async () => {
    const harness = await relayHarness()
    const first = `${"a".repeat(8)}${"b".repeat(32)}`
    const second = `${"a".repeat(8)}${"c".repeat(32)}`

    const created = [
      await createDatabase(harness, first),
      await createDatabase(harness, second),
    ]

    expect(new Set(created.map((database) => database.hostname)).size).toBe(2)
    expect([...fakeDocker.networks.keys()]).toEqual(
      expect.arrayContaining([networkOf(first), networkOf(second)])
    )
    expect([...fakeDocker.volumes.keys()]).toEqual([
      volumeOf(first),
      volumeOf(second),
    ])
  })
})

describe("managed database provisioning", () => {
  function input(id: string) {
    return relayCreateDatabaseSchema.parse({
      databaseName: "kiln_app",
      engine: "postgres",
      id,
      name: "Main database",
      password,
      username: "kiln_user",
    })
  }

  async function settled(harness: RelayHarness, id: string) {
    for (let tries = 0; tries < 10_000; tries += 1) {
      const database = (await harness.databases.list()).find(
        (candidate) => candidate.id === id
      )
      if (database && database.observedState !== "provisioning") {
        return database
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
    throw new Error("The database never finished provisioning")
  }

  it("shows a placeholder at once, then creates the database once Hearth claims it", async () => {
    const harness = await relayHarness()
    const manager = await provisioningWorker(harness)
    const id = "c".repeat(40)
    const job = {
      idempotencyKey: randomUUID(),
      input: input(id),
      instanceId: id,
      kind: "database" as const,
      placeholder: harness.databases.placeholder(input(id)),
    }

    await Effect.runPromise(manager.prepare(job))
    // A retried prepare answers the same job.
    await Effect.runPromise(manager.prepare(job))
    expect(await harness.databases.list()).toEqual([
      expect.objectContaining({
        containerId: null,
        id,
        observedState: "provisioning",
        provisioning: expect.objectContaining({ phase: "awaiting_claim" }),
      }),
    ])
    expect(
      await harness.databases.inventory(
        [{ id, view: "status" }],
        new AbortController().signal
      )
    ).toEqual([{ id, view: "status", observedState: "provisioning" }])

    await Effect.runPromise(manager.claim("database", id))
    const database = await settled(harness, id)

    expect(database).toMatchObject({ id, observedState: "running" })
    expect(database.provisioning).toBeUndefined()
    expect(databaseContainer(id).state.running).toBe(true)
  })

  it("shows where a failed create stopped and leaves nothing behind", async () => {
    const harness = await relayHarness()
    const manager = await provisioningWorker(harness)
    const id = "c".repeat(40)
    fakeDocker.failNext({ command: "start" }, "port is already allocated")

    await Effect.runPromise(
      manager.prepare({
        idempotencyKey: randomUUID(),
        input: input(id),
        instanceId: id,
        kind: "database",
        placeholder: harness.databases.placeholder(input(id)),
      })
    )
    await Effect.runPromise(manager.claim("database", id))
    const database = await settled(harness, id)

    expect(database).toMatchObject({
      containerId: null,
      observedState: "failed",
      provisioning: { failedPhase: "finalizing", phase: "failed" },
    })
    expect(fakeDocker.networks.has(networkOf(id))).toBe(false)
    expect(fakeDocker.volumes.has(volumeOf(id))).toBe(false)
  })

  it("keeps a deleted job visible until what it made is gone, and never runs it", async () => {
    const harness = await relayHarness()
    const manager = await provisioningWorker(harness)
    const id = "c".repeat(40)
    await Effect.runPromise(
      manager.prepare({
        idempotencyKey: randomUUID(),
        input: input(id),
        instanceId: id,
        kind: "database",
        placeholder: harness.databases.placeholder(input(id)),
      })
    )

    await expect(
      Effect.runPromise(
        manager.discard("database", id, async () => {
          throw new Error("Docker unavailable")
        })
      )
    ).rejects.toThrow("Docker unavailable")
    expect(await harness.databases.list()).toEqual([
      expect.objectContaining({ id, observedState: "failed" }),
    ])
    // Hearth's claim no longer starts it.
    await expect(
      Effect.runPromise(manager.claim("database", id))
    ).resolves.toMatchObject({ observedState: "failed" })

    await Effect.runPromise(manager.discard("database", id, async () => {}))
    expect(await harness.databases.list()).toEqual([])
    expect(fakeDocker.volumes.has(volumeOf(id))).toBe(false)
  })

  it("refuses to delete a job the worker has taken", async () => {
    const harness = await relayHarness()
    const manager = await provisioningWorker(harness)
    const id = "c".repeat(40)
    // Another change to the database holds its lanes, so the worker takes
    // the job and waits its turn.
    let release: () => void = () => undefined
    const held = Effect.runPromise(
      harness.lanes.run(
        { label: "database.action", locks: databaseLocks(id) },
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              release = resolve
            })
        )
      )
    )
    await Effect.runPromise(
      manager.prepare({
        idempotencyKey: randomUUID(),
        input: input(id),
        instanceId: id,
        kind: "database",
        placeholder: harness.databases.placeholder(input(id)),
      })
    )
    await Effect.runPromise(manager.claim("database", id))
    for (let tries = 0; tries < 10_000; tries += 1) {
      const job = await Effect.runPromise(harness.state.getProvisioningJob(id))
      if (job?.status === "running") break
      await new Promise((resolve) => setImmediate(resolve))
    }

    await expect(
      Effect.runPromise(manager.discard("database", id, async () => {}))
    ).rejects.toThrow("Wait for the database to finish provisioning")

    release()
    await held
    expect(await settled(harness, id)).toMatchObject({
      observedState: "running",
    })
  })
})

describe("managed database limits", () => {
  const MIB = 1024 ** 2

  it("changes memory and CPU in place and keeps the disk limit", async () => {
    const harness = await relayHarness()
    const id = "d".repeat(40)
    await createDatabase(harness, id)
    const before = databaseContainer(id).id

    const limited = await harness.databases.setLimits({
      databaseId: id,
      limits: { cpuMillis: 500, diskBytes: 1024 * MIB, memoryBytes: 512 * MIB },
    })

    expect(limited.limits).toEqual({
      cpuMillis: 500,
      diskBytes: 1024 * MIB,
      memoryBytes: 512 * MIB,
    })
    expect(databaseContainer(id)).toMatchObject({
      id: before,
      memoryBytes: 512 * MIB,
      nanoCpus: 5e8,
    })
    // A Relay that restarts reads the same limits back.
    const [listed] = await harness.databases.list()
    expect(listed?.limits).toEqual(limited.limits)
  })

  it("recreates the container over the same data to remove a limit", async () => {
    const harness = await relayHarness()
    const id = "d".repeat(40)
    await createDatabase(harness, id)
    await harness.databases.setLimits({
      databaseId: id,
      limits: { cpuMillis: 500, memoryBytes: 512 * MIB },
    })
    const before = databaseContainer(id)

    const unlimited = await harness.databases.setLimits({
      databaseId: id,
      limits: { memoryBytes: null },
    })

    expect(unlimited.limits).toEqual({
      cpuMillis: 500,
      diskBytes: null,
      memoryBytes: null,
    })
    const after = databaseContainer(id)
    expect(after.id).not.toBe(before.id)
    expect(after).toMatchObject({ memoryBytes: 0, nanoCpus: 5e8 })
    expect(after.state.running).toBe(true)
    expect(after.env).toEqual(before.env)
    expect(after.mounts).toContainEqual(
      expect.objectContaining({ source: volumeOf(id) })
    )
    expect(fakeDocker.containers.size).toBe(1)
  })

  it("keeps the old container when its replacement can't be created", async () => {
    const harness = await relayHarness()
    const id = "d".repeat(40)
    await createDatabase(harness, id)
    await harness.databases.setLimits({
      databaseId: id,
      limits: { memoryBytes: 512 * MIB },
    })
    const before = databaseContainer(id).id
    fakeDocker.failNext({ command: "create" }, "no space left on device")

    await expect(
      harness.databases.setLimits({
        databaseId: id,
        limits: { memoryBytes: null },
      })
    ).rejects.toThrow("no space left on device")

    expect(databaseContainer(id)).toMatchObject({
      id: before,
      memoryBytes: 512 * MIB,
    })
    expect(databaseContainer(id).state.running).toBe(true)
  })
})

describe("managed database replacement recovery", () => {
  const MIB = 1024 ** 2

  it("never lists a database twice when the old container outlives its replacement", async () => {
    const harness = await relayHarness()
    const id = "d".repeat(40)
    await createDatabase(harness, id)
    await harness.databases.setLimits({
      databaseId: id,
      limits: { memoryBytes: 512 * MIB },
    })
    const before = databaseContainer(id).id
    fakeDocker.failNext({ command: "rm", target: before }, "device busy")

    await harness.databases.setLimits({
      databaseId: id,
      limits: { memoryBytes: null },
    })

    expect(fakeDocker.containers.size).toBe(2)
    expect(await harness.databases.list()).toHaveLength(1)
    await harness.databases.recoverReplacements()
    expect([...fakeDocker.containers.values()]).toEqual([
      expect.objectContaining({ id: databaseContainer(id).id }),
    ])
    expect(databaseContainer(id).id).not.toBe(before)
  })

  it("starts a replacement a restart caught before it started", async () => {
    const harness = await relayHarness()
    const id = "d".repeat(40)
    await createDatabase(harness, id)
    await harness.databases.setLimits({
      databaseId: id,
      limits: { memoryBytes: 512 * MIB },
    })
    const original = databaseContainer(id).id
    // The Relay stops while Docker starts the replacement.
    const start = fakeDocker.hold({ command: "start" })
    void harness.databases.setLimits({
      databaseId: id,
      limits: { memoryBytes: null },
    })
    await start.reached
    const restarted = await harness.restart()

    await restarted.databases.recoverReplacements()

    expect([...fakeDocker.containers.values()]).toEqual([
      expect.objectContaining({ id: databaseContainer(id).id }),
    ])
    expect(databaseContainer(id).id).not.toBe(original)
    expect(databaseContainer(id).state.running).toBe(true)
    expect(databaseContainer(id).memoryBytes).toBe(0)
  })

  it("goes back to the old container when a restart caught a replacement that never got ready", async () => {
    const harness = await relayHarness()
    const id = "d".repeat(40)
    await createDatabase(harness, id)
    await harness.databases.setLimits({
      databaseId: id,
      limits: { memoryBytes: 512 * MIB },
    })
    const original = databaseContainer(id).id
    // The Relay stops as Docker starts the replacement, which comes up
    // running but fails its health check.
    fakeDocker.unhealthyImages.add("postgres:17")
    const start = fakeDocker.hold({ command: "start" })
    void harness.databases.setLimits({
      databaseId: id,
      limits: { memoryBytes: null },
    })
    await start.reached
    const replacement = `${TEST_NAMESPACE}-kiln-db-${id}-database`
    await Effect.runPromise(
      new DockerEngine(harness.config.dockerSocket).startContainer(
        replacement,
        {
          timeout: 5_000,
        }
      )
    )
    expect(fakeDocker.container(replacement)?.state.health).toBe("unhealthy")
    const restarted = await harness.restart()

    await restarted.databases.recoverReplacements()

    expect([...fakeDocker.containers.values()]).toEqual([
      expect.objectContaining({ id: original }),
    ])
    expect(databaseContainer(id).memoryBytes).toBe(512 * MIB)
  })

  it("leaves a stopped database stopped when a restart caught its replacement", async () => {
    const harness = await relayHarness()
    const id = "d".repeat(40)
    await createDatabase(harness, id)
    await harness.databases.setLimits({
      databaseId: id,
      limits: { memoryBytes: 512 * MIB },
    })
    await harness.databases.action({ action: "stop", databaseId: id })
    const original = databaseContainer(id).id
    // The Relay stops while Docker creates the replacement.
    const creation = fakeDocker.hold({ command: "create" })
    void harness.databases.setLimits({
      databaseId: id,
      limits: { memoryBytes: null },
    })
    await creation.reached
    const restarted = await harness.restart()

    await restarted.databases.recoverReplacements()

    expect(databaseContainer(id)).toMatchObject({ id: original })
    expect(databaseContainer(id).state.running).toBe(false)
  })

  it("puts back a database a restart caught set aside", async () => {
    const harness = await relayHarness()
    const id = "d".repeat(40)
    await createDatabase(harness, id)
    const original = databaseContainer(id)
    const engine = new DockerEngine(harness.config.dockerSocket)
    // As a Relay that stopped right after setting the old container aside.
    await Effect.runPromise(
      engine.stopContainer(original.id, {
        seconds: 1,
        timeout: 5_000,
      })
    )
    await Effect.runPromise(
      engine.renameContainer(original.id, `${original.name}-replaced-0000`)
    )
    expect(await harness.databases.list()).toHaveLength(0)

    await harness.databases.recoverReplacements()

    expect(databaseContainer(id)).toMatchObject({ id: original.id })
    expect(databaseContainer(id).state.running).toBe(true)
    expect(await harness.databases.list()).toHaveLength(1)
  })
})

describe("managed database credential rotation", () => {
  it.each([
    // Valkey's client reads the same variable as Redis's.
    ["redis", "REDISCLI_AUTH"],
    ["valkey", "REDISCLI_AUTH"],
  ] as const)(
    "rotates %s credentials without exposing passwords to process arguments",
    async (engine, environmentName) => {
      const harness = await relayHarness()
      const id = "e".repeat(40)
      await createDatabase(harness, id, engine)

      await harness.databases.rotateCredentials({
        currentPassword: password,
        databaseId: id,
        nextPassword,
        username: "kiln_user",
      })

      const acl = fakeDocker.volumes.get(volumeOf(id))?.files.get("users.acl")
      expect(acl).toContain(
        createHash("sha256").update(nextPassword).digest("hex")
      )
      expect(acl).not.toContain(nextPassword)
      const processes = databaseContainer(id).processes
      expect(processes).toHaveLength(1)
      expect(processes[0]?.env).toEqual({ [environmentName]: password })
      expect(processes[0]?.argv.join(" ")).not.toContain(password)
    }
  )
})

describe("managed database container details", () => {
  it("reports the database's container, data folder, and volume size", async () => {
    const harness = await relayHarness()
    const id = "f".repeat(40)
    const other = "1".repeat(40)
    await createDatabase(harness, id)
    await createDatabase(harness, other)
    fakeDocker.volumes.get(volumeOf(id))?.files.set("base/1", "x".repeat(4096))
    fakeDocker.volumes.get(volumeOf(other))?.files.set("base/1", "x".repeat(10))

    await expect(harness.databases.inspect(id)).resolves.toEqual({
      containerName: `${TEST_NAMESPACE}-kiln-db-${id}-database`,
      dataDirectory: `/var/lib/docker/volumes/${volumeOf(id)}/_data`,
      volumeBytes: 4096,
    })
    await expect(harness.databases.inspect("2".repeat(40))).rejects.toThrow(
      "Database not found"
    )
  })
})

describe("managed database wipe", () => {
  // Their clients read REDISCLI_AUTH, so a wipe that set another variable
  // would fail to log in and, without -e, still exit 0.
  it.each(["redis", "valkey"] as const)(
    "wipes %s logged in as its user, without exposing the password",
    async (engine) => {
      const harness = await relayHarness()
      const id = "6".repeat(40)
      await createDatabase(harness, id, engine)

      await harness.databases.wipe({
        databaseId: id,
        password,
        username: "kiln_user",
      })

      const [wipe] = databaseContainer(id).processes
      expect(wipe?.env).toEqual({ REDISCLI_AUTH: password })
      expect(wipe?.argv).toContain("-e")
      expect(wipe?.argv.join(" ")).not.toContain(password)
    }
  )

  it("refuses to wipe a stopped database", async () => {
    const harness = await relayHarness()
    const id = "3".repeat(40)
    await createDatabase(harness, id)
    await harness.databases.action({ action: "stop", databaseId: id })

    await expect(
      harness.databases.wipe({
        databaseId: id,
        password,
        username: "kiln_user",
      })
    ).rejects.toThrow("Start the database before wiping it")
  })
})

describe("managed database dumps", () => {
  const credentials = { password, username: "kiln_user" }

  const fileName = "import-0f8e2c1d-7a4b-4c3e-9d2f-1b6a5e4c3d2f"

  // Where a browser's upload of a dump lands.
  async function uploadDump(
    harness: RelayHarness,
    id: string,
    dump: Buffer | string,
    name = fileName
  ) {
    const root = await harness.databases.dumpFileRoot(id)
    const file = join(harness.databases.dumpDirectory, root.directory, name)
    await writeFile(file, dump)
    return file
  }

  it("runs an uploaded dump far past the old 700 KB limit, then removes it", async () => {
    const harness = await relayHarness()
    const id = "4".repeat(40)
    await createDatabase(harness, id)
    const dump = "INSERT INTO kiln_test VALUES ('row');\n".repeat(80_000)
    const uploaded = await uploadDump(harness, id, dump)

    await harness.databases.importDump({
      ...credentials,
      databaseId: id,
      fileName,
    })

    expect(databaseContainer(id).executedSql).toEqual([dump])
    await expect(stat(uploaded)).rejects.toThrow()
  })

  it("runs only the upload its import names, leaving another browser's", async () => {
    const harness = await relayHarness()
    const id = "8".repeat(40)
    await createDatabase(harness, id)
    const other = "import-7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f"
    await uploadDump(harness, id, "INSERT INTO mine VALUES (1);\n")
    const theirs = await uploadDump(harness, id, "DELETE FROM mine;\n", other)

    await harness.databases.importDump({
      ...credentials,
      databaseId: id,
      fileName,
    })

    expect(databaseContainer(id).executedSql).toEqual([
      "INSERT INTO mine VALUES (1);\n",
    ])
    expect(await readFile(theirs, "utf8")).toBe("DELETE FROM mine;\n")
  })

  it("removes an upload whose import can't start, leaving another browser's", async () => {
    const harness = await relayHarness()
    const id = "a1".repeat(20)
    await createDatabase(harness, id)
    const other = "import-7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f"
    const mine = await uploadDump(harness, id, "INSERT INTO mine VALUES (1);\n")
    const theirs = await uploadDump(harness, id, "SELECT 1;\n", other)
    await harness.databases.action({ action: "stop", databaseId: id })

    await expect(
      harness.databases.importDump({ ...credentials, databaseId: id, fileName })
    ).rejects.toThrow()

    await expect(stat(mine)).rejects.toThrow()
    expect(await readFile(theirs, "utf8")).toBe("SELECT 1;\n")
    expect(databaseContainer(id).executedSql).toEqual([])
  })

  it("restores an uploaded custom-format dump byte for byte, and only into PostgreSQL", async () => {
    const harness = await relayHarness()
    const postgres = "5".repeat(40)
    const mysql = "6".repeat(40)
    await createDatabase(harness, postgres)
    await createDatabase(harness, mysql, "mysql")
    const dump = Buffer.concat([
      Buffer.from("PGDMP"),
      Buffer.from([0x01, 0x0e, 0x00, 0xff, 0xfe, 0x80]),
      randomBytes(256 * 1024),
    ])
    await uploadDump(harness, postgres, dump)
    await uploadDump(harness, mysql, dump)

    await harness.databases.importDump({
      ...credentials,
      databaseId: postgres,
      fileName,
    })
    await expect(
      harness.databases.importDump({
        ...credentials,
        databaseId: mysql,
        fileName,
      })
    ).rejects.toThrow("can only be imported into PostgreSQL")

    expect(databaseContainer(postgres).restoredDumps).toEqual([dump])
    expect(databaseContainer(mysql).executedSql).toEqual([])
  })

  it("exports a dump far past the old limit for download, keeping the last whole one when a dump fails", async () => {
    const harness = await relayHarness()
    const id = "7".repeat(40)
    await createDatabase(harness, id)
    const container = databaseContainer(id)
    container.sqlDump = "-- PostgreSQL database dump\n".repeat(50_000)

    const exported = await harness.databases.exportDump({
      ...credentials,
      databaseId: id,
    })
    const file = join(harness.databases.dumpDirectory, id, exported.path)
    expect(await readFile(file, "utf8")).toBe(container.sqlDump)
    // A dump holds all of the database's data, for the Relay alone to read.
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await stat(dirname(file))).mode & 0o777).toBe(0o700)

    const whole = container.sqlDump
    container.sqlDump = "-- partial"
    fakeDocker.programFailures.set("pg_dump", "pg_dump: error: query failed")
    await expect(
      harness.databases.exportDump({ ...credentials, databaseId: id })
    ).rejects.toThrow("pg_dump: error: query failed")
    expect(await readFile(file, "utf8")).toBe(whole)
    expect(await readdir(join(harness.databases.dumpDirectory, id))).toEqual([
      exported.path,
    ])
  })

  it("finishes exports run at once each whole", async () => {
    const harness = await relayHarness()
    const id = "9".repeat(40)
    await createDatabase(harness, id)
    const container = databaseContainer(id)
    container.sqlDump = "-- PostgreSQL database dump\n".repeat(50_000)

    const exports = await Promise.all([
      harness.databases.exportDump({ ...credentials, databaseId: id }),
      harness.databases.exportDump({ ...credentials, databaseId: id }),
    ])

    const folder = join(harness.databases.dumpDirectory, id)
    expect(exports.map(({ size }) => size)).toEqual([
      container.sqlDump.length,
      container.sqlDump.length,
    ])
    expect(await readFile(join(folder, exports[0].path), "utf8")).toBe(
      container.sqlDump
    )
    expect(await readdir(folder)).toEqual([exports[0].path])
  })
})

describe("managed database ACL files", () => {
  it("fails a create whose ACL write Docker breaks off, leaving no one-off container", async () => {
    const harness = await relayHarness()
    const id = "f".repeat(40)
    fakeDocker.streamErrors.set("redis:8", "container is being removed")

    await expect(createDatabase(harness, id, "redis")).rejects.toThrow(
      "container is being removed"
    )

    expect(
      [...fakeDocker.containers.values()].filter(
        (container) => container.image === "redis:8" && container.autoRemove
      )
    ).toEqual([])
  })
})

describe("managed database deletion", () => {
  it("removes owned network and volume resources without a container", async () => {
    const harness = await relayHarness()
    const id = "d".repeat(40)
    const labels = {
      "kiln.database.id": id,
      "kiln.relay.owner": TEST_NAMESPACE,
      "kiln.resource.kind": "database",
    }
    fakeDocker.addNetwork({
      internal: true,
      labels: { ...labels, "kiln.database.network": networkOf(id) },
      name: networkOf(id),
    })
    fakeDocker.addVolume({
      labels: { ...labels, "kiln.database.volume": volumeOf(id) },
      name: volumeOf(id),
    })
    const server = await harness.seedServer({ id: serverId, running: true })
    fakeDocker.connect(server.name, networkOf(id))

    await expect(
      harness.databases.delete({ databaseId: id, deleteData: true })
    ).resolves.toEqual({ databaseId: id, deleted: true })

    expect(fakeDocker.networks.has(networkOf(id))).toBe(false)
    expect(fakeDocker.volumes.has(volumeOf(id))).toBe(false)
    expect(server.networks.has(networkOf(id))).toBe(false)
    expect(server.state.running).toBe(true)
  })

  it("fails a delete whose network won't go, so it can be retried", async () => {
    const harness = await relayHarness()
    const id = "d".repeat(40)
    await createDatabase(harness, id)
    fakeDocker.failNext(
      { command: "network rm", target: networkOf(id) },
      "network has active endpoints"
    )

    await expect(
      harness.databases.delete({ databaseId: id, deleteData: true })
    ).rejects.toThrow("network has active endpoints")
    expect(fakeDocker.networks.has(networkOf(id))).toBe(true)

    await harness.databases.delete({ databaseId: id, deleteData: true })
    expect(fakeDocker.networks.has(networkOf(id))).toBe(false)
    expect(fakeDocker.volumes.has(volumeOf(id))).toBe(false)
  })

  it("doesn't call a database gone when Docker can't say what's left of it", async () => {
    const harness = await relayHarness()
    const id = "d".repeat(40)
    await createDatabase(harness, id)
    // An earlier delete stopped after removing the container.
    await Effect.runPromise(
      new DockerEngine(harness.config.dockerSocket).removeContainer(
        databaseContainer(id).id,
        { force: true }
      )
    )
    fakeDocker.failNext(
      { command: "network inspect", target: networkOf(id) },
      "Docker unavailable"
    )

    await expect(
      harness.databases.delete({ databaseId: id, deleteData: true })
    ).rejects.toThrow("Docker unavailable")
    expect(fakeDocker.networks.has(networkOf(id))).toBe(true)

    await harness.databases.delete({ databaseId: id, deleteData: true })
    expect(fakeDocker.networks.has(networkOf(id))).toBe(false)
    expect(fakeDocker.volumes.has(volumeOf(id))).toBe(false)
  })

  it("finishes when the container disappears before Docker removes it", async () => {
    const harness = await relayHarness()
    const id = "d".repeat(40)
    await createDatabase(harness, id)
    const removal = fakeDocker.hold({ command: "rm" })

    const deleting = harness.databases.delete({
      databaseId: id,
      deleteData: true,
    })
    await removal.reached
    fakeDocker.removeContainer(databaseContainer(id).name)
    removal.release()

    await expect(deleting).resolves.toEqual({ databaseId: id, deleted: true })
    expect(fakeDocker.networks.has(networkOf(id))).toBe(false)
    expect(fakeDocker.volumes.has(volumeOf(id))).toBe(false)
  })
})

describe("explicit database connections", () => {
  it("attaches a running server to a healthy database without restarting it", async () => {
    const harness = await relayHarness()
    const id = "b".repeat(40)
    await createDatabase(harness, id)
    const server = await harness.seedServer({ id: serverId, running: true })
    const startedAt = server.state.startedAt

    const updated = await harness.databases.updateNetwork({
      connected: true,
      databaseId: id,
      member: { id: serverId, kind: "instance" },
    })

    expect(updated.connectedInstanceIds).toEqual([serverId])
    expect(server.networks.has(networkOf(id))).toBe(true)
    expect(server.state).toMatchObject({ running: true, startedAt })
  })

  it("reports an unavailable database network without touching the server", async () => {
    const harness = await relayHarness()
    const id = "b".repeat(40)
    await createDatabase(harness, id)
    const server = await harness.seedServer({ id: serverId, running: true })
    // The network vanished outside Relay.
    databaseContainer(id).networks.delete(networkOf(id))
    fakeDocker.networks.delete(networkOf(id))

    await expect(
      harness.databases.updateNetwork({
        connected: true,
        databaseId: id,
        member: { id: serverId, kind: "instance" },
      })
    ).rejects.toThrow("Retry the connection")
    expect(server.state.running).toBe(true)
  })

  it("refuses to connect a missing database and saves no intent", async () => {
    const harness = await relayHarness()
    await harness.seedServer({ id: serverId, running: true })

    await expect(
      harness.databases.updateNetwork({
        connected: true,
        databaseId: "b".repeat(40),
        member: { id: serverId, kind: "instance" },
      })
    ).rejects.toThrow("Database not found")
    expect(
      await Effect.runPromise(
        harness.state.listMemberDatabaseConnections({
          id: serverId,
          kind: "instance",
        })
      )
    ).toEqual([])
  })
})

describe("database mutation serialization", () => {
  it("runs a connect queued behind deletion after it, without saving an orphan", async () => {
    const harness = await relayHarness()
    const id = "d".repeat(40)
    await createDatabase(harness, id)
    const server = await harness.seedServer({ id: serverId, running: true })
    const removal = fakeDocker.hold({
      command: "rm",
      target: databaseContainer(id).id,
    })

    // As the control socket runs them: each in its turn in the lanes.
    const inLane = <T>(
      operation: "database.delete" | "database.network.write",
      payload: Record<string, unknown>,
      run: () => Promise<T>
    ) =>
      Effect.runPromise(
        harness.lanes.run(
          {
            label: operation,
            locks: controlRequestLocks(operation, payload, (ref) => ref)!,
          },
          Effect.promise(run)
        )
      )
    const deleting = inLane("database.delete", { databaseId: id }, () =>
      harness.databases.delete({ databaseId: id, deleteData: true })
    )
    await removal.reached
    const connect = {
      connected: true,
      databaseId: id,
      member: { id: serverId, kind: "instance" },
    } as const
    const connecting = inLane("database.network.write", connect, () =>
      harness.databases.updateNetwork(connect)
    ).then(
      () => null,
      (error: unknown) => error
    )
    removal.release()

    await expect(deleting).resolves.toMatchObject({ deleted: true })
    expect(await connecting).toMatchObject({ message: "Database not found" })
    expect(
      await Effect.runPromise(
        harness.state.listMemberDatabaseConnections({
          id: serverId,
          kind: "instance",
        })
      )
    ).toEqual([])
    expect([...server.networks.keys()]).toEqual([harness.resources.gameNetwork])
    // The failed connect released its lock for later operations.
    await expect(
      inLane("database.network.write", connect, () =>
        harness.databases.updateNetwork(connect)
      )
    ).rejects.toThrow("Database not found")
  })
})

describe("connections of every member kind", () => {
  const appId = "c".repeat(40)

  // An App with one running service, as a deploy leaves it.
  async function runningApp(harness: RelayHarness) {
    await harness.apps.create({ id: appId, name: "Website" })
    return fakeDocker.addContainer({
      labels: {
        "kiln.app.id": appId,
        "kiln.app.service": "web",
        "kiln.relay.owner": TEST_NAMESPACE,
        "kiln.resource.kind": "app",
      },
      name: `${TEST_NAMESPACE}-kiln-${appId.slice(0, 8)}-web`,
      networks: [harness.resources.appNetwork(appId)],
      running: true,
    })
  }

  it("removes every member's connections to a deleted database, and its own", async () => {
    const harness = await relayHarness()
    const [deleted, member, other] = ["d", "e", "f"].map((c) => c.repeat(40))
    for (const id of [deleted!, member!, other!])
      await createDatabase(harness, id)
    const app = await runningApp(harness)
    const connect = (
      databaseId: string,
      to: { id: string; kind: "app" | "database" }
    ) =>
      harness.databases.updateNetwork({
        connected: true,
        databaseId,
        member: to,
      })
    await connect(deleted!, { id: appId, kind: "app" })
    await connect(deleted!, { id: member!, kind: "database" })
    await connect(other!, { id: deleted!, kind: "database" })
    await connect(other!, { id: appId, kind: "app" })
    expect(app.networks.has(networkOf(deleted!))).toBe(true)
    expect(databaseContainer(member!).networks.has(networkOf(deleted!))).toBe(
      true
    )

    await harness.databases.delete({ databaseId: deleted!, deleteData: true })

    expect(
      await Effect.runPromise(harness.state.listDatabaseConnections())
    ).toEqual([
      {
        databaseId: other,
        memberId: appId,
        memberKind: "app",
        relayId: harness.config.nodeId,
      },
    ])
    expect(app.networks.has(networkOf(deleted!))).toBe(false)
    expect([...databaseContainer(member!).networks.keys()]).toEqual([
      networkOf(member!),
    ])
    expect((await harness.apps.get(appId)).savedDatabaseIds).toEqual([other])
  })

  it("joins a member database's replacement to its connections when a restart came first", async () => {
    const harness = await relayHarness()
    const [target, member] = ["d", "e"].map((c) => c.repeat(40))
    for (const id of [target!, member!]) await createDatabase(harness, id)
    await harness.databases.updateNetwork({
      connected: true,
      databaseId: target!,
      member: { id: member!, kind: "database" },
    })
    await harness.databases.setLimits({
      databaseId: member!,
      limits: { memoryBytes: 512 * 1024 ** 2 },
    })
    const original = databaseContainer(member!).id
    // The Relay stops after creating the replacement, before joining it.
    const joining = fakeDocker.hold({
      command: "network connect",
      target: networkOf(target!),
    })
    void harness.databases.setLimits({
      databaseId: member!,
      limits: { memoryBytes: null },
    })
    await joining.reached
    const restarted = await harness.restart()

    await restarted.databases.recoverReplacements()

    const replacement = databaseContainer(member!)
    expect(replacement.id).not.toBe(original)
    expect(replacement.state.running).toBe(true)
    expect(replacement.networks.has(networkOf(target!))).toBe(true)
  })

  it("joins a member database to its connections again when it starts", async () => {
    const harness = await relayHarness()
    const [target, member] = ["d", "e"].map((c) => c.repeat(40))
    for (const id of [target!, member!]) await createDatabase(harness, id)
    await harness.databases.updateNetwork({
      connected: true,
      databaseId: target!,
      member: { id: member!, kind: "database" },
    })
    await harness.databases.action({ action: "stop", databaseId: member! })
    // Taken off outside Kiln while it was stopped.
    await Effect.runPromise(
      new DockerEngine(harness.config.dockerSocket).disconnectNetwork(
        networkOf(target!),
        databaseContainer(member!).id
      )
    )

    await harness.databases.action({ action: "start", databaseId: member! })

    expect(databaseContainer(member!).networks.has(networkOf(target!))).toBe(
      true
    )
  })

  it("runs an App's connect queued behind the database's deletion after it, without saving an orphan", async () => {
    const harness = await relayHarness()
    const id = "d".repeat(40)
    await createDatabase(harness, id)
    const app = await runningApp(harness)
    const removal = fakeDocker.hold({
      command: "rm",
      target: databaseContainer(id).id,
    })
    const inLane = <T>(
      operation: "database.delete" | "database.network.write",
      payload: Record<string, unknown>,
      run: () => Promise<T>
    ) =>
      Effect.runPromise(
        harness.lanes.run(
          {
            label: operation,
            locks: controlRequestLocks(operation, payload, (ref) => ref)!,
          },
          Effect.promise(run)
        )
      )
    const deleting = inLane("database.delete", { databaseId: id }, () =>
      harness.databases.delete({ databaseId: id, deleteData: true })
    )
    await removal.reached
    const connect = {
      connected: true,
      databaseId: id,
      member: { id: appId, kind: "app" },
    } as const
    const connecting = inLane("database.network.write", connect, () =>
      harness.databases.updateNetwork(connect)
    ).then(
      () => null,
      (error: unknown) => error
    )
    // It waits its turn rather than joining a network on its way out.
    await vi.waitFor(() => expect(harness.lanes.pending.waiting).toBe(1))
    removal.release()

    await expect(deleting).resolves.toMatchObject({ deleted: true })
    expect(await connecting).toMatchObject({ message: "Database not found" })
    expect(
      await Effect.runPromise(harness.state.listDatabaseConnections())
    ).toEqual([])
    expect([...app.networks.keys()]).toEqual([
      harness.resources.appNetwork(appId),
    ])
  })
})
