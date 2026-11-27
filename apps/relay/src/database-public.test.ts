import { relayCreateDatabaseSchema } from "@workspace/contracts"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { PublicDatabases } from "./database-public.js"
import { DockerEngine } from "./docker-engine.js"
import { databaseBrick } from "./test/database-bricks.js"
import { fakeDocker } from "./test/docker.js"
import {
  relayHarness,
  TEST_NAMESPACE,
  type RelayHarness,
} from "./test/relay.js"

const id = "d".repeat(12)
const gate = `${TEST_NAMESPACE}-kiln-db-${id}-public`
const opened = { hostnames: ["db.example.com"], port: 25_432 }

async function publicDatabases(harness: RelayHarness) {
  const databases = new PublicDatabases({
    certificates: harness.lifecycle.certificates,
    config: harness.config,
    databases: harness.databases,
    engine: new DockerEngine(harness.config.dockerSocket),
    hostPorts: harness.lifecycle.hostPorts,
    proxy: { runsTraefik: true },
    state: harness.state,
  })
  await databases.load()
  return databases
}

async function withDatabase() {
  const harness = await relayHarness()
  await harness.databases.create(
    relayCreateDatabaseSchema.parse({
      databaseName: "kiln_app",
      ...databaseBrick("postgres"),
      id,
      name: "Main database",
      password: "correct-horse-battery-staple-1",
      username: "kiln_user",
    })
  )
  return harness
}

describe("a public database", () => {
  it("stays public, and kept, when its gate can't be removed as it closes", async () => {
    const harness = await withDatabase()
    const databases = await publicDatabases(harness)
    await databases.write(id, opened)
    fakeDocker.addContainer({ name: gate, running: true })
    fakeDocker.failNext({ command: "rm", target: gate }, "device busy")

    await expect(databases.write(id, null)).rejects.toThrow()

    // Still saved across a restart, so the loop keeps it, and closing
    // again finishes.
    expect((await publicDatabases(harness)).ids()).toEqual([id])
    expect(databases.status({ id })).toMatchObject(opened)
    await databases.write(id, null)
    expect(fakeDocker.container(gate)).toBeUndefined()
    expect((await publicDatabases(harness)).ids()).toEqual([])
  })

  it("can't be given a port another public database waits for", async () => {
    const harness = await withDatabase()
    const other = "e".repeat(12)
    await harness.databases.create(
      relayCreateDatabaseSchema.parse({
        databaseName: "kiln_app",
        ...databaseBrick("postgres"),
        id: other,
        name: "Other database",
        password: "correct-horse-battery-staple-1",
        username: "kiln_user",
      })
    )
    const databases = await publicDatabases(harness)
    await databases.write(id, opened)

    await expect(
      databases.write(other, { hostnames: ["other.example.com"], port: 25_432 })
    ).rejects.toThrow(/port 25432/u)
    expect(databases.ids()).toEqual([id])
  })

  it("holds what it saved as a restart reads it back", async () => {
    const harness = await withDatabase()
    const databases = await publicDatabases(harness)
    await databases.write(id, opened)
    await databases.write(id, {
      hostnames: ["data.example.com", "db.example.com"],
      port: 25_433,
    })

    const restarted = await publicDatabases(harness)
    expect(databases.names()).toEqual(restarted.names())
    expect(databases.status({ id })).toMatchObject({ port: 25_433 })
    expect(restarted.status({ id })).toMatchObject({ port: 25_433 })
  })

  it("is forgotten once its database is gone, as after a delete the Relay stopped in", async () => {
    const harness = await withDatabase()
    const databases = await publicDatabases(harness)
    await databases.write(id, opened)
    fakeDocker.addContainer({
      labels: { "kiln.database.gate": id, "kiln.relay.owner": TEST_NAMESPACE },
      name: gate,
      running: true,
    })
    await harness.databases.delete({ databaseId: id, deleteData: true })

    await databases.reconcile(id)

    expect(databases.ids()).toEqual([])
    expect(fakeDocker.container(gate)).toBeUndefined()
    expect((await publicDatabases(harness)).ids()).toEqual([])
  })
})
