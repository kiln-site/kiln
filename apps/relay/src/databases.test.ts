import { createHash } from "node:crypto"

import {
  relayCreateDatabaseSchema,
  type DatabaseEngine,
} from "@workspace/contracts"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { fakeDocker } from "./test/docker.js"
import { relayHarness, TEST_NAMESPACE, type RelayHarness } from "./test/relay.js"

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
  const container = fakeDocker.container(`${TEST_NAMESPACE}-kiln-db-${id}-database`)
  if (!container) throw new Error(`Database ${id} has no container`)
  return container
}

const networkOf = (id: string) => `${TEST_NAMESPACE}-kiln-db-${id}-network`
const volumeOf = (id: string) => `${TEST_NAMESPACE}-kiln-db-${id}-data`

describe("managed database recovery metadata", () => {
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
    expect(recovered).toMatchObject({ engine: "postgres", id, observedState: "running" })
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
    expect([...fakeDocker.volumes.keys()]).toEqual([volumeOf(first), volumeOf(second)])
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
      expect(acl).toContain(createHash("sha256").update(nextPassword).digest("hex"))
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

  it("finishes when the container disappears before Docker removes it", async () => {
    const harness = await relayHarness()
    const id = "d".repeat(40)
    await createDatabase(harness, id)
    const removal = fakeDocker.hold({ command: "rm" })

    const deleting = harness.databases.delete({ databaseId: id, deleteData: true })
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
      await Effect.runPromise(harness.state.listInstanceDatabaseConnections(serverId))
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

    const deleting = harness.databases.delete({ databaseId: id, deleteData: true })
    await removal.reached
    const connecting = harness.databases.updateNetwork({
      connected: true,
      databaseId: id,
      instanceId: serverId,
    })
    removal.release()

    await expect(deleting).resolves.toMatchObject({ deleted: true })
    await expect(connecting).rejects.toThrow("Database not found")
    expect(
      await Effect.runPromise(harness.state.listInstanceDatabaseConnections(serverId))
    ).toEqual([])
    expect([...server.networks.keys()]).toEqual([harness.resources.gameNetwork])
    // The failed connect released its lock for later operations.
    await expect(
      harness.databases.updateNetwork({
        connected: true,
        databaseId: id,
        instanceId: serverId,
      })
    ).rejects.toThrow("Database not found")
  })
})
