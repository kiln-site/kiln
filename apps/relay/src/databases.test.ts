import { createHash } from "node:crypto"
import {
  relayCreateDatabaseSchema,
  type DatabaseEngine,
} from "@workspace/contracts"
import { randomUUID } from "node:crypto"

import { Effect, Fiber } from "effect"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { fakeDocker } from "./test/docker.js"
import {
  relayHarness,
  TEST_NAMESPACE,
  type RelayHarness,
} from "./test/relay.js"
import { databaseProvisioning } from "./database-provisioning.js"
import { DockerEngine } from "./docker-engine.js"
import { RelayStateStore } from "./effect/state.js"
import { ProvisioningManager } from "./provisioning.js"
import { serverProvisioning } from "./server-provisioning.js"
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
  // The Relay's provisioning queue and worker over the harness's drivers.
  async function provisioning(harness: RelayHarness) {
    const manager = await Effect.runPromise(
      ProvisioningManager.make({
        adapters: {
          database: databaseProvisioning(harness.databases),
          server: serverProvisioning({
            lifecycle: harness.lifecycle,
            refreshSnapshot: async () => undefined,
            state: harness.state,
          }),
        },
        lanes: harness.lanes,
      }).pipe(Effect.provideService(RelayStateStore, harness.state))
    )
    const worker = Effect.runFork(manager.run())
    return {
      manager,
      stop: () => Effect.runPromise(Fiber.interrupt(worker)),
    }
  }

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
    const { manager, stop } = await provisioning(harness)
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
    await stop()
  })

  it("shows where a failed create stopped and leaves nothing behind", async () => {
    const harness = await relayHarness()
    const { manager, stop } = await provisioning(harness)
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
    await stop()
  })

  it("keeps a deleted job visible until what it made is gone, and never runs it", async () => {
    const harness = await relayHarness()
    const { manager, stop } = await provisioning(harness)
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
    await stop()
  })

  it("refuses to delete a job the worker has taken", async () => {
    const harness = await relayHarness()
    const { manager, stop } = await provisioning(harness)
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
    expect(await settled(harness, id)).toMatchObject({ observedState: "running" })
    await stop()
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
      new DockerEngine(harness.config.dockerSocket).startContainer(replacement, {
        timeout: 5_000,
      })
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
      engine.renameContainer(
        original.id,
        `${original.name}-replaced-0000`
      )
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

describe("managed database custom-format imports", () => {
  it("refuses dumps that aren't PostgreSQL custom format, or aren't for PostgreSQL", async () => {
    const harness = await relayHarness()
    const postgres = "4".repeat(40)
    const mysql = "5".repeat(40)
    await createDatabase(harness, postgres)
    await createDatabase(harness, mysql, "mysql")
    const customDump = Buffer.from("PGDMP\u0001\u000e\u0000").toString("base64")
    const credentials = { password, username: "kiln_user" }

    await expect(
      harness.databases.importDump({
        ...credentials,
        content: customDump,
        databaseId: mysql,
        format: "postgres-custom",
      })
    ).rejects.toThrow("can only be imported into PostgreSQL")
    await expect(
      harness.databases.importDump({
        ...credentials,
        content: Buffer.from("SELECT 1;").toString("base64"),
        databaseId: postgres,
        format: "postgres-custom",
      })
    ).rejects.toThrow("isn't a PostgreSQL custom-format dump")
    await expect(
      harness.databases.importDump({
        ...credentials,
        content: Buffer.alloc(700_001).toString("base64"),
        databaseId: postgres,
        format: "postgres-custom",
      })
    ).rejects.toThrow("700 KB transfer limit")
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
      instanceId: serverId,
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
        instanceId: serverId,
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
        instanceId: serverId,
      })
    ).rejects.toThrow("Database not found")
    expect(
      await Effect.runPromise(
        harness.state.listInstanceDatabaseConnections(serverId)
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
      instanceId: serverId,
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
        harness.state.listInstanceDatabaseConnections(serverId)
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
