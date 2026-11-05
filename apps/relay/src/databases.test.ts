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
      const id = "e".repeat(40)
      await createDatabase(harness, id, engine)

      await harness.databases.rotateCredentials({
        currentPassword: password,
        databaseId: id,
        nextPassword,
        nextUsername: "kiln_user",
        username: "kiln_user",
      })

      const acl = fakeDocker.volumes.get(volumeOf(id))?.files.get("users.acl")
      expect(acl).toContain(
        createHash("sha256").update(nextPassword).digest("hex")
      )
      expect(acl).not.toContain(nextPassword)
      const processes = databaseContainer(id).processes
      expect(processes.length).toBeGreaterThan(0)
      for (const process of processes) {
        expect(process.env).toEqual({ [environmentName]: password })
        expect(process.argv.join(" ")).not.toContain(password)
      }
    }
  )

  it.each(["redis", "valkey"] as const)(
    "renames %s's login, and puts it back when the database won't load it",
    async (engine) => {
      const harness = await relayHarness()
      const id = "e".repeat(40)
      await createDatabase(harness, id, engine)
      const acl = () =>
        fakeDocker.volumes.get(volumeOf(id))?.files.get("users.acl")
      const change = {
        currentPassword: password,
        databaseId: id,
        nextPassword,
        nextUsername: "app_user",
        username: "kiln_user",
      }

      fakeDocker.programAnswers = (argv) =>
        argv.includes("LOAD")
          ? { failure: "ERR Error loading ACLs" }
          : undefined
      await expect(harness.databases.rotateCredentials(change)).rejects.toThrow(
        "ERR Error loading ACLs"
      )
      expect(acl()).toContain("user kiln_user ")

      fakeDocker.programAnswers = null
      await harness.databases.rotateCredentials(change)
      expect(acl()).toContain("user app_user ")
      expect(acl()).not.toContain("kiln_user")
    }
  )

  it.each(["redis", "valkey"] as const)(
    "finishes a %s change sent again once its login has already moved",
    async (engine) => {
      const harness = await relayHarness()
      const id = "e".repeat(40)
      await createDatabase(harness, id, engine)
      // The old login is gone, so loading as it could only fail.
      fakeDocker.programAnswers = (argv) =>
        argv.includes("kiln_user") ? { failure: "WRONGPASS" } : undefined

      await harness.databases.rotateCredentials({
        currentPassword: password,
        databaseId: id,
        nextPassword,
        nextUsername: "app_user",
        username: "kiln_user",
      })

      expect(
        fakeDocker.volumes.get(volumeOf(id))?.files.get("users.acl")
      ).toContain("user app_user ")
      expect(
        databaseContainer(id).processes.some(({ argv }) =>
          argv.includes("LOAD")
        )
      ).toBe(false)
    }
  )

  it.each(["redis", "valkey"] as const)(
    "reports why %s took neither login, and leaves it alone",
    async (engine) => {
      const harness = await relayHarness()
      const id = "e".repeat(40)
      await createDatabase(harness, id, engine)
      const before = fakeDocker.volumes
        .get(volumeOf(id))
        ?.files.get("users.acl")
      fakeDocker.programAnswers = () => ({ failure: "LOADING" })

      await expect(
        harness.databases.rotateCredentials({
          currentPassword: password,
          databaseId: id,
          nextPassword,
          nextUsername: "app_user",
          username: "kiln_user",
        })
      ).rejects.toThrow("LOADING")

      expect(fakeDocker.volumes.get(volumeOf(id))?.files.get("users.acl")).toBe(
        before
      )
    }
  )

  // Backups run with no login from Hearth, as the container's POSTGRES_USER.
  it("gives Postgres a new container naming the login it was renamed to", async () => {
    const harness = await relayHarness()
    const id = "f".repeat(40)
    await createDatabase(harness, id)
    const original = databaseContainer(id)

    await harness.databases.rotateCredentials({
      currentPassword: password,
      databaseId: id,
      nextPassword,
      nextUsername: "app_user",
      username: "kiln_user",
    })

    const replaced = databaseContainer(id)
    expect(replaced.id).not.toBe(original.id)
    expect(replaced.state.running).toBe(true)
    expect(replaced.env).toMatchObject({
      POSTGRES_DB: "kiln_app",
      POSTGRES_PASSWORD: nextPassword,
      POSTGRES_USER: "app_user",
    })
    expect(await harness.databases.list()).toHaveLength(1)
  })

  it("keeps the Postgres container when the login can't be renamed", async () => {
    const harness = await relayHarness()
    const id = "f".repeat(40)
    await createDatabase(harness, id)
    const original = databaseContainer(id)

    fakeDocker.programAnswers = (_argv, input) =>
      input.includes("RENAME TO")
        ? { failure: 'role "app_user" already exists' }
        : undefined
    await expect(
      harness.databases.rotateCredentials({
        currentPassword: password,
        databaseId: id,
        nextPassword,
        nextUsername: "app_user",
        username: "kiln_user",
      })
    ).rejects.toThrow("already exists")

    expect(databaseContainer(id).id).toBe(original.id)
    expect(databaseContainer(id).env.POSTGRES_USER).toBe("kiln_user")
  })

  // A restart can come after the rename but before the new container.
  it("gives Postgres its new container when a change sent again finds the role renamed", async () => {
    const harness = await relayHarness()
    const id = "f".repeat(40)
    await createDatabase(harness, id)
    const original = databaseContainer(id)
    fakeDocker.programAnswers = (argv) =>
      argv.includes("kiln_user")
        ? { failure: 'role "kiln_user" does not exist' }
        : undefined

    await harness.databases.rotateCredentials({
      currentPassword: password,
      databaseId: id,
      nextPassword,
      nextUsername: "app_user",
      username: "kiln_user",
    })

    expect(databaseContainer(id).id).not.toBe(original.id)
    expect(databaseContainer(id).env.POSTGRES_USER).toBe("app_user")
    expect(original.executedSql.join("")).not.toContain("RENAME TO")
    // What the restart left of the rename goes too.
    expect(original.executedSql.join("")).toContain("DROP ROLE")
  })

  it("finishes a rename even if an old helper role won't go", async () => {
    const harness = await relayHarness()
    const id = "f".repeat(40)
    await createDatabase(harness, id)
    fakeDocker.programAnswers = (_argv, input) =>
      input.startsWith("DO $$") ? { failure: "role is in use" } : undefined

    await harness.databases.rotateCredentials({
      currentPassword: password,
      databaseId: id,
      nextPassword,
      nextUsername: "app_user",
      username: "kiln_user",
    })

    expect(databaseContainer(id).env.POSTGRES_USER).toBe("app_user")
  })

  it("doesn't take a role already called the new name for the rename", async () => {
    const harness = await relayHarness()
    const id = "f".repeat(40)
    await createDatabase(harness, id)
    const original = databaseContainer(id)
    // Still starting, so the old role doesn't answer; another has the name.
    fakeDocker.programAnswers = (argv) =>
      argv.includes("kiln_user")
        ? { failure: "the database system is starting up" }
        : undefined

    await expect(
      harness.databases.rotateCredentials({
        currentPassword: password,
        databaseId: id,
        nextPassword,
        nextUsername: "app_user",
        username: "kiln_user",
      })
    ).rejects.toThrow("starting up")

    expect(databaseContainer(id).id).toBe(original.id)
    expect(databaseContainer(id).env.POSTGRES_USER).toBe("kiln_user")
  })

  it("leaves the Postgres container alone when one sent again finds it done", async () => {
    const harness = await relayHarness()
    const id = "f".repeat(40)
    await createDatabase(harness, id)
    const change = {
      currentPassword: password,
      databaseId: id,
      nextPassword,
      nextUsername: "app_user",
      username: "kiln_user",
    }
    await harness.databases.rotateCredentials(change)
    const replaced = databaseContainer(id)
    fakeDocker.programAnswers = (argv) =>
      argv.includes("kiln_user")
        ? { failure: 'role "kiln_user" does not exist' }
        : undefined

    await harness.databases.rotateCredentials(change)

    expect(databaseContainer(id).id).toBe(replaced.id)
  })

  it("takes the old Postgres login back when the new container fails", async () => {
    const harness = await relayHarness()
    const id = "f".repeat(40)
    await createDatabase(harness, id)
    const original = databaseContainer(id)
    fakeDocker.failNext({ command: "create" }, "no space left on device")

    await expect(
      harness.databases.rotateCredentials({
        currentPassword: password,
        databaseId: id,
        nextPassword,
        nextUsername: "app_user",
        username: "kiln_user",
      })
    ).rejects.toThrow("no space left on device")

    expect(databaseContainer(id).id).toBe(original.id)
    expect(original.executedSql.join("")).toContain(
      'ALTER ROLE "app_user" RENAME TO "kiln_user"'
    )
  })

  describe.each(["mysql", "mariadb"] as const)("%s logins", (engine) => {
    const id = "a".repeat(40)
    const change = {
      currentPassword: password,
      databaseId: id,
      nextPassword,
      nextUsername: "app_user",
      username: "kiln_user",
    }
    const listing = (input: string, users: string) =>
      input.startsWith("SELECT User") ? `${users}\n` : undefined

    it("renames the login as root, then sets its password", async () => {
      const harness = await relayHarness()
      await createDatabase(harness, id, engine)
      fakeDocker.programAnswers = (_argv, input) => listing(input, "kiln_user")

      await harness.databases.rotateCredentials(change)

      const sql = databaseContainer(id).executedSql.join("")
      expect(sql).toContain("RENAME USER 'kiln_user'@'%' TO 'app_user'@'%'")
      expect(sql).toContain("ALTER USER 'app_user'@'%' IDENTIFIED BY")
    })

    it("takes the old name back when the password can't be set", async () => {
      const harness = await relayHarness()
      await createDatabase(harness, id, engine)
      fakeDocker.programAnswers = (_argv, input) =>
        input.startsWith("ALTER USER")
          ? { failure: "ERROR 1819 password policy" }
          : listing(input, "kiln_user")

      await expect(harness.databases.rotateCredentials(change)).rejects.toThrow(
        "password policy"
      )

      expect(databaseContainer(id).executedSql.join("")).toContain(
        "RENAME USER 'app_user'@'%' TO 'kiln_user'@'%'"
      )
    })

    it("only sets the password when one sent again finds it renamed", async () => {
      const harness = await relayHarness()
      await createDatabase(harness, id, engine)
      fakeDocker.programAnswers = (_argv, input) => listing(input, "app_user")

      await harness.databases.rotateCredentials(change)

      const sql = databaseContainer(id).executedSql.join("")
      expect(sql).not.toContain("RENAME USER")
      expect(sql).toContain("ALTER USER 'app_user'@'%' IDENTIFIED BY")
    })

    it("takes the old name back from an earlier attempt's rename when the password can't be set", async () => {
      const harness = await relayHarness()
      await createDatabase(harness, id, engine)
      fakeDocker.programAnswers = (_argv, input) =>
        input.startsWith("ALTER USER")
          ? { failure: "ERROR 1819 password policy" }
          : listing(input, "app_user")

      await expect(harness.databases.rotateCredentials(change)).rejects.toThrow(
        "password policy"
      )

      expect(databaseContainer(id).executedSql.join("")).toContain(
        "RENAME USER 'app_user'@'%' TO 'kiln_user'@'%'"
      )
    })

    it("refuses a name already taken, changing nothing", async () => {
      const harness = await relayHarness()
      await createDatabase(harness, id, engine)
      fakeDocker.programAnswers = (_argv, input) =>
        input.startsWith("RENAME USER")
          ? { failure: "ERROR 1396 Operation RENAME USER failed" }
          : listing(input, "kiln_user\napp_user")

      await expect(harness.databases.rotateCredentials(change)).rejects.toThrow(
        "RENAME USER failed"
      )

      expect(databaseContainer(id).executedSql.join("")).not.toContain(
        "ALTER USER"
      )
    })

    it("fails when it has neither login", async () => {
      const harness = await relayHarness()
      await createDatabase(harness, id, engine)
      fakeDocker.programAnswers = (_argv, input) => listing(input, "")

      await expect(harness.databases.rotateCredentials(change)).rejects.toThrow(
        "neither its old login nor its new one"
      )
    })
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
})
