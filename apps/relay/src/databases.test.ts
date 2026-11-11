import { createHash } from "node:crypto"
import { readdir, readFile, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  relayCreateDatabaseSchema,
  type DatabaseEngine,
} from "@workspace/contracts"

import { Effect } from "effect"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { fakeDocker } from "./test/docker.js"
import { databaseBrick } from "./test/database-bricks.js"
import {
  relayHarness,
  TEST_NAMESPACE,
  type RelayHarness,
} from "./test/relay.js"
import { DockerEngine } from "./docker-engine.js"

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
      ...databaseBrick(engine),
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
  it("labels databases for recovery without putting credentials in labels", async () => {
    const harness = await relayHarness()
    const id = "d".repeat(12)

    await createDatabase(harness, id)

    const container = databaseContainer(id)
    expect(container.labels).toMatchObject({
      "kiln.brick.id": "postgres",
      "kiln.brick.kind": "database",
      "kiln.brick.type": "postgres",
      "kiln.brick.variables": JSON.stringify({ version: "17" }),
      "kiln.database.engine": "postgres",
      "kiln.database.image": "postgres:17",
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
      brickId: "postgres",
      engine: "postgres",
      id,
      observedState: "running",
    })
  })

  it("puts back a database a restart caught set aside", async () => {
    const harness = await relayHarness()
    const id = "d".repeat(12)
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

describe("a database made before databases ran Bricks", () => {
  // As a Relay labelled one then: its engine, and nothing of a Brick.
  function asMadeBefore(id: string) {
    const container = databaseContainer(id)
    for (const label of Object.keys(container.labels)) {
      if (
        label.startsWith("kiln.brick.") ||
        [
          "kiln.database.command",
          "kiln.database.data-mount",
          "kiln.database.port",
          "kiln.database.ready",
        ].includes(label)
      ) {
        delete container.labels[label]
      }
    }
    return container
  }

  it.each(["postgres", "redis"] as const)(
    "is read as its engine's Brick, and replaced as it ran (%s)",
    async (engine) => {
      const harness = await relayHarness()
      const id = "f".repeat(12)
      await createDatabase(harness, id, engine)
      const before = asMadeBefore(id)

      const [listed] = await harness.databases.list()
      expect(listed).toMatchObject({
        brickId: engine,
        engine,
        internalPort: engine === "postgres" ? 5432 : 6379,
      })

      await harness.databases.redeploy(id)

      const after = databaseContainer(id)
      expect(after.id).not.toBe(before.id)
      expect(after.cmd).toEqual(before.cmd)
      expect(after.mounts).toEqual(before.mounts)
      expect(after.env).toEqual(before.env)
      expect(after.state.running).toBe(true)
    }
  )
})

describe("managed database redeploy", () => {
  it("replaces the container from its image pulled anew, over the same data and login", async () => {
    const harness = await relayHarness()
    const id = "e".repeat(12)
    await createDatabase(harness, id)
    const before = databaseContainer(id)
    fakeDocker.pulls.clear()

    const database = await harness.databases.redeploy(id)

    const after = databaseContainer(id)
    expect(after.id).not.toBe(before.id)
    // The tag it was made from, pulled again: never another version.
    expect([...fakeDocker.pulls.keys()]).toEqual([
      `docker.io/library/${before.image}`,
    ])
    expect(after.image).toBe(before.image)
    expect(after.mounts).toEqual(before.mounts)
    expect(after.env).toEqual(before.env)
    expect(after.labels).toMatchObject({
      "kiln.database.id": id,
      "kiln.database.volume": volumeOf(id),
    })
    expect(after.state.running).toBe(true)
    expect(database).toMatchObject({ id, observedState: "running" })
  })

  it("installs a newer revision of its Brick over the same data and login", async () => {
    const harness = await relayHarness()
    const id = "e".repeat(12)
    await createDatabase(harness, id, "mariadb")
    const before = databaseContainer(id)
    const { recipe, recipeDefinition } = databaseBrick("mariadb")
    if (recipeDefinition.deploy?.type !== "image") throw new Error("No image")

    const database = await harness.databases.redeploy(
      id,
      undefined,
      undefined,
      {
        recipe,
        recipeDefinition: {
          ...recipeDefinition,
          deploy: {
            ...recipeDefinition.deploy,
            env: { ...recipeDefinition.deploy.env, TZ: "UTC" },
          },
          metadata: { ...recipeDefinition.metadata, revision: 2 },
        },
      }
    )

    const after = databaseContainer(id)
    expect(after.id).not.toBe(before.id)
    expect(after.mounts).toEqual(before.mounts)
    // What the new recipe adds, and the login exactly as the engine was
    // first given it: the root password is not made again.
    expect(after.env).toMatchObject({
      MARIADB_DATABASE: before.env.MARIADB_DATABASE,
      MARIADB_PASSWORD: before.env.MARIADB_PASSWORD,
      MARIADB_ROOT_PASSWORD: before.env.MARIADB_ROOT_PASSWORD,
      MARIADB_USER: before.env.MARIADB_USER,
      TZ: "UTC",
    })
    expect(before.env.MARIADB_ROOT_PASSWORD).toBeTruthy()
    expect(after.labels).toMatchObject({
      "kiln.brick.revision": "2",
      "kiln.database.volume": volumeOf(id),
    })
    expect(database).toMatchObject({
      brickRevision: 2,
      id,
      observedState: "running",
    })
  })

  it("leaves a database as it is when a newer revision would leave its data behind", async () => {
    const harness = await relayHarness()
    const id = "e".repeat(12)
    await createDatabase(harness, id)
    const before = databaseContainer(id)
    const { recipe, recipeDefinition } = databaseBrick("postgres")
    if (recipeDefinition.deploy?.type !== "image") throw new Error("No image")

    await expect(
      harness.databases.redeploy(id, undefined, undefined, {
        recipe,
        recipeDefinition: {
          ...recipeDefinition,
          deploy: {
            ...recipeDefinition.deploy,
            volumes: ["/var/lib/postgresql"],
          },
          metadata: { ...recipeDefinition.metadata, revision: 2 },
        },
      })
    ).rejects.toThrow(/keeps its data in/u)

    const after = databaseContainer(id)
    expect(after.id).toBe(before.id)
    expect(after.state.running).toBe(true)
  })

  it("leaves a stopped database stopped, in its new container", async () => {
    const harness = await relayHarness()
    const id = "e".repeat(12)
    await createDatabase(harness, id)
    await harness.power.requested("database", id, "stop")
    const before = databaseContainer(id)

    await harness.databases.redeploy(id)

    expect(databaseContainer(id).id).not.toBe(before.id)
    expect(databaseContainer(id).state.running).toBe(false)
  })

  it("puts the old container back, running, when the new one doesn't start", async () => {
    const harness = await relayHarness()
    const id = "e".repeat(12)
    await createDatabase(harness, id)
    const before = databaseContainer(id)
    fakeDocker.failNext({ command: "start" }, "no space left on device")

    await expect(harness.databases.redeploy(id)).rejects.toThrow(
      "no space left on device"
    )

    expect(databaseContainer(id).id).toBe(before.id)
    expect(databaseContainer(id).state.running).toBe(true)
    expect(await harness.databases.list()).toHaveLength(1)
  })

  it("leaves the database running when its image can't be pulled", async () => {
    const harness = await relayHarness()
    const id = "e".repeat(12)
    await createDatabase(harness, id)
    const before = databaseContainer(id)
    fakeDocker.failNext({ command: "pull" }, "registry unreachable")

    await expect(harness.databases.redeploy(id)).rejects.toThrow(
      "registry unreachable"
    )

    expect(databaseContainer(id)).toBe(before)
    expect(before.state.running).toBe(true)
  })
})

describe("managed database power state", () => {
  it("shows a database someone killed as stopped, and one that crashed as failed", async () => {
    const harness = await relayHarness()
    const id = "c".repeat(12)
    await createDatabase(harness, id)
    const observed = async () =>
      (await harness.databases.list())[0]?.observedState

    await harness.power.requested("database", id, "kill")
    expect(await observed()).toBe("stopped")

    await harness.power.requested("database", id, "start")
    const { name } = databaseContainer(id)
    fakeDocker.exit(name, { exitCode: 137, oomKilled: true })
    expect(await observed()).toBe("failed")
    await harness.power.requested("database", id, "start")
    fakeDocker.exit(name, { exitCode: 1 })
    expect(await observed()).toBe("failed")
  })
})

describe("managed database credentials and dumps", () => {
  const credentials = { password, username: "kiln_user" }

  it.each([
    // Valkey's client reads the same variable as Redis's.
    ["redis", "REDISCLI_AUTH"],
    ["valkey", "REDISCLI_AUTH"],
  ] as const)(
    "rotates %s credentials without exposing passwords to process arguments",
    async (engine, environmentName) => {
      const harness = await relayHarness()
      const id = "e".repeat(12)
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
      const client = databaseContainer(id).processes.at(-1)
      expect(client?.env).toEqual({ [environmentName]: password })
      expect(client?.argv.join(" ")).not.toContain(password)
    }
  )

  it.each([
    ["mariadb", "MYSQL_PWD"],
    ["mysql", "MYSQL_PWD"],
    ["postgres", "PGPASSWORD"],
  ] as const)(
    "rotates a %s password without exposing it to process arguments",
    async (engine, environmentName) => {
      const harness = await relayHarness()
      const id = "e".repeat(12)
      await createDatabase(harness, id, engine)

      await harness.databases.rotateCredentials({
        currentPassword: password,
        databaseId: id,
        nextPassword,
        username: "kiln_user",
      })

      const client = databaseContainer(id).processes.at(-1)
      expect(client?.env).toEqual({ [environmentName]: password })
      expect(client?.argv.join(" ")).not.toContain(password)
    }
  )

  it("exports a dump far past the old limit for download, keeping the last whole one when a dump fails", async () => {
    const harness = await relayHarness()
    const id = "7".repeat(12)
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
})
