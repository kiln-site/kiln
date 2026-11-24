import { createCipheriv, createHmac, randomUUID, scryptSync } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { afterAll, assert, describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { onTestFinished, vi } from "vite-plus/test"

import {
  type BackupCreateTaskInput,
  encodeRecoveryCode,
} from "@workspace/contracts"

vi.mock("./command.js", () => import("./test/docker.js"))

import { BackupManager } from "./backups.js"
import { TarRestoreFences } from "./backups/tar-restore-journal.js"
import {
  loadOrCreateRelayIdentity,
  readRelayIdentityMaterial,
} from "./effect/identity.js"
import { RelayStateStore } from "./effect/state.js"
import { controlRequestLocks } from "./operation-plans.js"
import {
  ensurePlatformBackupKey,
  platformBackupKey,
} from "./platform-backup-key.js"
import {
  createEncryptedPlatformBackup,
  inspectEncryptedPlatformBackup,
  type PlatformBackupManifest,
  readPlatformBackupRecovery,
  restoreEncryptedPlatformBackup,
} from "./platform-backups.js"
import { collectPlatformRecovery } from "./platform-recovery.js"
import { restorePlatform } from "./platform-restore.js"
import {
  type PlatformState,
  withPlatformLock,
  writePlatformState,
} from "./platform-state.js"
import { DockerEngine } from "./docker-engine.js"
import { identifyHearth, newPlatformState, platformInputs } from "./platform.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness } from "./test/relay.js"

const testDirectory = mkdtempSync(join(tmpdir(), "kiln-platform-backup-"))
const recoveryKey = "test-recovery-key-with-at-least-32-bytes"

afterAll(() => {
  rmSync(testDirectory, { force: true, recursive: true })
})

const manifest: PlatformBackupManifest = {
  compression: "gzip",
  createdAt: "2026-08-10T12:00:00.000Z",
  databaseEngine: "mysql",
  encryption: "aes-256-gcm+scrypt",
  formatVersion: 1,
  installationId: "kiln-test",
  payload: "hearth.dmp",
}

// A valid encrypted platform backup of `dump`.
function platformBundle(
  dump: string,
  overrides: Partial<PlatformBackupManifest> = {}
): Buffer {
  const manifestBytes = Buffer.from(
    JSON.stringify({ ...manifest, ...overrides }),
    "utf8"
  )
  const salt = Buffer.from("00112233445566778899aabbccddeeff", "hex")
  const initializationVector = Buffer.from("00112233445566778899aabb", "hex")
  // The bundle format pins scrypt with Node's default cost parameters.
  const key = scryptSync(recoveryKey, salt, 32)
  const cipher = createCipheriv("aes-256-gcm", key, initializationVector)
  cipher.setAAD(manifestBytes)
  const ciphertext = Buffer.concat([
    cipher.update(gzipSync(dump)),
    cipher.final(),
  ])
  const header = platformHeader(manifestBytes.byteLength)
  salt.copy(header, 16)
  initializationVector.copy(header, 32)
  cipher.getAuthTag().copy(header, 44)
  return Buffer.concat([header, manifestBytes, ciphertext])
}

describe("Kiln platform backups", () => {
  it("authenticates the manifest and encrypted payload", async () => {
    const source = join(testDirectory, "valid.kiln")
    const bundle = platformBundle("SELECT 1;")
    await writeFile(source, bundle)
    assert.deepStrictEqual(
      await inspectEncryptedPlatformBackup(recoveryKey, source),
      manifest
    )

    const tampered = Buffer.from(bundle)
    tampered[tampered.byteLength - 1] ^= 1
    const tamperedSource = join(testDirectory, "tampered.kiln")
    await writeFile(tamperedSource, tampered)
    await expect(
      inspectEncryptedPlatformBackup(recoveryKey, tamperedSource)
    ).rejects.toThrow(/authenticate|authentication|state/iu)
  })
})

// Hearth and its MySQL as Coolify deploys them, without Kiln's labels, once
// Hearth has proven its container to the Relay.
async function coolifyKiln(
  options: {
    backupKey?: string
    databaseEnvironment?: Record<string, string>
  } = {}
) {
  const harness = await relayHarness({
    KILN_INSTALLATION_ID: "kiln-test",
    KILN_PLATFORM_BACKUP_KEY: options.backupKey ?? recoveryKey,
  })
  onTestFinished(() => fakeDocker.reset())
  const hearth = {
    env: {
      BETTER_AUTH_SECRETS: "1:hearth-secret",
      DB_HOST: "coolify-mysql",
      DB_NAME: "hearth",
      KILN_URL: "https://kiln.example.test",
    },
    labels: { "coolify.managed": "true" },
    networks: ["coolify"],
    running: true,
  }
  const dataVolume = {
    destination: "/var/lib/mysql",
    source: "mysql-data",
    type: "volume" as const,
  }
  fakeDocker.addNetwork({ name: "coolify" })
  const proving = fakeDocker.addContainer({ ...hearth, name: "hearth-1" })
  const database = fakeDocker.addContainer({
    env: { MYSQL_DATABASE: "hearth", ...options.databaseEnvironment },
    image: "mysql:8",
    labels: { "coolify.managed": "true" },
    mounts: [dataVolume],
    name: "coolify-mysql",
    networks: ["coolify"],
    running: true,
  })
  const engine = new DockerEngine(harness.config.dockerSocket)
  await Effect.runPromise(loadOrCreateRelayIdentity(harness.config))
  const identified = await Effect.runPromise(
    identifyHearth(engine, harness.config, harness.state, {
      clientId: "hearth-client",
      containerId: proving.id,
      installationId: "kiln-test",
      proof: createHmac("sha256", "1:hearth-secret")
        .update("t")
        .digest("base64url"),
      transcript: "t",
    })
  )
  assert.isTrue(identified)
  return {
    dataVolume,
    database,
    engine,
    harness,
    hearth,
    restore: async (manifest: Partial<PlatformBackupManifest> = {}) => {
      const source = join(testDirectory, `coolify-${randomUUID()}.kiln`)
      await writeFile(
        source,
        platformBundle("CREATE TABLE restored (id int);", {
          databaseName: "hearth",
          ...manifest,
        })
      )
      return restoreEncryptedPlatformBackup(harness.config, source, "kiln-test")
    },
  }
}

// As a schedule or the panel has the Relay back Kiln up.
async function backupManager(kiln: Awaited<ReturnType<typeof coolifyKiln>>) {
  const { harness } = kiln
  const manager = await Effect.runPromise(
    BackupManager.make({
      apps: {
        isRunning: async () => false,
        start: async () => {},
        stop: async () => {},
        volumes: async () => [],
      },
      config: harness.config,
      fences: await TarRestoreFences.load(harness.config),
      findInstance: async () => null,
      isInstanceStopped: async () => true,
      lanes: harness.lanes,
      volumes: harness.volumes,
    }).pipe(Effect.provideService(RelayStateStore, harness.state))
  )
  const backUp = (taskId: string = randomUUID()) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* manager.enqueue({
          artifactKind: "platform_bundle",
          backupId: randomUUID(),
          destination: { kind: "local" },
          exclude: [],
          kind: "create",
          maxBytes: null,
          mode: "full",
          reason: "manual",
          target: { id: "kiln-test", kind: "platform" },
          taskId,
        })
        yield* manager.runPending()
        return (yield* manager.get(taskId))!
      })
    )
  return { backUp, manager }
}

describe("Kiln platform backups deployed by Coolify", () => {
  it("backs up Hearth's database, and restores it once Coolify removes Hearth's container", async () => {
    const kiln = await coolifyKiln()
    kiln.database.sqlDump = "CREATE TABLE kept (id int);"
    const backup = join(testDirectory, `coolify-${randomUUID()}.kiln`)
    await createEncryptedPlatformBackup(
      kiln.harness.config,
      {
        backupId: "d".repeat(40),
        maxBytes: null,
        target: { id: "kiln-test", kind: "platform" },
      } as unknown as BackupCreateTaskInput,
      backup,
      { completed: 0, total: 0 },
      new AbortController().signal,
      await Effect.runPromise(
        collectPlatformRecovery(kiln.harness.config, kiln.harness.state)
      )
    )
    await expect(
      inspectEncryptedPlatformBackup(recoveryKey, backup)
    ).resolves.toMatchObject({ databaseName: "hearth" })
    const restore = () =>
      restoreEncryptedPlatformBackup(kiln.harness.config, backup, "kiln-test")
    await expect(restore()).rejects.toThrow("Stop Hearth")

    // Coolify stops Hearth by removing its container.
    fakeDocker.removeContainer("hearth-1")
    await restore()

    expect(kiln.database.executedSql.join("\n")).toContain(
      "CREATE TABLE kept (id int);"
    )
  })

  it("carries what runs Kiln on a new machine, also while Coolify has Hearth stopped", async () => {
    const kiln = await coolifyKiln()
    const { config, state } = kiln.harness
    await Effect.runPromise(
      state.restoreClients([
        {
          actions: [],
          createdAt: 1,
          id: "hearth-client",
          invitationId: "hearth-invitation",
          name: "Hearth",
          origins: ["https://kiln.example.test"],
          publicKey: "hearth-public-key",
          role: "full_access",
          sourceCidrs: [],
        },
      ])
    )
    fakeDocker.removeContainer("hearth-1")

    expect(
      await Effect.runPromise(collectPlatformRecovery(config, state))
    ).toMatchObject({
      installation: {
        database: { image: "mysql:8", name: "hearth" },
        hearth: { url: "https://kiln.example.test" },
        installationId: "kiln-test",
        ownerInvitationIds: ["hearth-invitation"],
        secrets: {
          authSecrets: "1:hearth-secret",
          platformBackupKey: recoveryKey,
        },
      },
      relay: {
        clients: [{ id: "hearth-client" }],
        identity: await Effect.runPromise(readRelayIdentityMaterial(config)),
      },
    })
  })

  it("makes no backup of a Kiln whose Hearth never proved itself", async () => {
    const { config, state } = await relayHarness({
      KILN_INSTALLATION_ID: "kiln-test",
      KILN_PLATFORM_BACKUP_KEY: recoveryKey,
    })
    await Effect.runPromise(loadOrCreateRelayIdentity(config))
    await expect(
      Effect.runPromise(collectPlatformRecovery(config, state))
    ).rejects.toThrow("can't be backed up yet")
  })

  it("waits for a restart of Kiln's services before dumping Hearth's database", async () => {
    const kiln = await coolifyKiln()
    kiln.database.sqlDump = "CREATE TABLE kept (id int);"
    const { harness } = kiln
    const { backUp, manager } = await backupManager(kiln)
    const restarted = Deferred.makeUnsafe<void>()
    const restart = Effect.runFork(
      harness.lanes.run(
        {
          label: "relay.platform.action",
          locks: controlRequestLocks(
            "relay.platform.action",
            { action: "restart" },
            (id) => id,
            () => []
          )!,
        },
        Deferred.await(restarted)
      )
    )
    const taskId = randomUUID()
    const backup = backUp(taskId)

    // It waits its turn rather than dump a database being restarted.
    await vi.waitFor(() => expect(harness.lanes.pending.waiting).toBe(1))
    expect(await Effect.runPromise(manager.get(taskId))).not.toMatchObject({
      status: "succeeded",
    })
    Deferred.doneUnsafe(restarted, Exit.void)
    await Effect.runPromise(Fiber.join(restart))

    expect(await backup).toMatchObject({ status: "succeeded" })
  })

  // As `kiln-relay platform restore` does, with this recovery code typed.
  async function restoring(
    kiln: Awaited<ReturnType<typeof coolifyKiln>>,
    dump = "CREATE TABLE lost (id int);"
  ) {
    const { config, state } = kiln.harness
    const source = join(testDirectory, `lost-${randomUUID()}.kiln`)
    await writeFile(source, platformBundle(dump, { databaseName: "hearth" }))
    const printed: Array<string> = []
    return {
      printed,
      restore: (code: string, from = source, withoutUndo = false) =>
        Effect.runPromise(
          restorePlatform({
            config,
            engine: kiln.engine,
            print: (text) => printed.push(text),
            recoveryCode: async () => code,
            source: from,
            state,
            withoutUndo,
          })
        ),
    }
  }

  it("restores a backup of a machine since lost with its recovery code, and keeps that code", async () => {
    const kiln = await coolifyKiln({ backupKey: "" })
    const { config, state } = kiln.harness
    const key = (installationId = "kiln-test") =>
      Effect.runPromise(platformBackupKey({ ...config, installationId }, state))
    await Effect.runPromise(
      ensurePlatformBackupKey(
        { ...config, installationId: "another-kiln" },
        state
      )
    )
    const own = await key()
    const another = await key("another-kiln")
    const { printed, restore } = await restoring(kiln)

    // Coolify still runs Hearth.
    await expect(restore(encodeRecoveryCode(recoveryKey))).rejects.toThrow(
      "Hearth is running"
    )
    fakeDocker.removeContainer("hearth-1")
    await expect(
      restore(encodeRecoveryCode("wrong".repeat(8)))
    ).rejects.toThrow("recovery code")
    expect(kiln.database.executedSql).toEqual([])
    expect(await key()).toBe(own)

    await restore(encodeRecoveryCode(recoveryKey))
    expect(kiln.database.executedSql.join("\n")).toContain(
      "CREATE TABLE lost (id int);"
    )
    expect(await key()).toBe(recoveryKey)
    expect(await key("another-kiln")).toBe(another)
    // So does a new machine restored from what undoes it.
    const undo = printed.at(-1)?.split(" ").at(-1) ?? ""
    const { recovery } = await readPlatformBackupRecovery(recoveryKey, undo)
    expect(recovery?.installation.secrets.platformBackupKey).toBe(recoveryKey)
  })

  it("saves what's there first, which undoes the restore, however often it failed before", async () => {
    const kiln = await coolifyKiln()
    kiln.database.sqlDump = "CREATE TABLE before (id int);"
    fakeDocker.removeContainer("hearth-1")
    const { printed, restore } = await restoring(kiln)

    fakeDocker.programFailures.set("mysql", "Lost connection")
    await expect(restore("")).rejects.toThrow()
    fakeDocker.programFailures.delete("mysql")
    kiln.database.sqlDump = "CREATE TABLE half (id int);"
    await restore("")

    const undo = printed.at(-1)?.split(" ").at(-1) ?? ""
    expect(undo).toContain("before-restore")
    await restore("", undo)
    expect(kiln.database.executedSql.at(-1)).toContain(
      "CREATE TABLE before (id int);"
    )
  })

  it("isn't backed up with part of a failed restore in its database", async () => {
    const kiln = await coolifyKiln()
    fakeDocker.removeContainer("hearth-1")
    const { restore } = await restoring(kiln)
    const { backUp } = await backupManager(kiln)

    fakeDocker.programFailures.set("mysql", "Lost connection")
    await expect(restore("")).rejects.toThrow()
    fakeDocker.programFailures.delete("mysql")
    expect(await backUp()).toMatchObject({ status: "failed" })

    await restore("")
    expect(await backUp()).toMatchObject({ status: "succeeded" })
  })

  it("saves again what's there after a try that changed nothing", async () => {
    const kiln = await coolifyKiln()
    const { config } = kiln.harness
    kiln.database.sqlDump = "CREATE TABLE before (id int);"
    fakeDocker.removeContainer("hearth-1")
    const { printed, restore } = await restoring(kiln)

    // There's nowhere to decrypt it.
    const staging = join(config.dataDirectory, "restores")
    await rm(staging, { force: true, recursive: true })
    await writeFile(staging, "")
    await expect(restore("")).rejects.toThrow()
    expect(kiln.database.executedSql).toEqual([])
    await rm(staging)
    // Hearth ran meanwhile.
    kiln.database.sqlDump = "CREATE TABLE meanwhile (id int);"
    await restore("")

    const undo = printed.at(-1)?.split(" ").at(-1) ?? ""
    await restore("", undo)
    expect(kiln.database.executedSql.at(-1)).toContain(
      "CREATE TABLE meanwhile (id int);"
    )
  })

  it("restores without undo a Kiln whose Hearth hasn't connected since the Relay saved what backups carry", async () => {
    const kiln = await coolifyKiln()
    await Effect.runPromise(
      kiln.harness.state.setMetadata("hosted_kiln:kiln-test", "")
    )
    fakeDocker.removeContainer("hearth-1")
    const { restore } = await restoring(kiln)

    await expect(restore("")).rejects.toThrow("--without-undo")
    expect(kiln.database.executedSql).toEqual([])
    await restore("", undefined, true)
    expect(kiln.database.executedSql.join("\n")).toContain(
      "CREATE TABLE lost (id int);"
    )
  })

  it("won't restore while another process of the Relay does", async () => {
    const kiln = await coolifyKiln()
    fakeDocker.removeContainer("hearth-1")
    const { restore } = await restoring(kiln)

    await Effect.runPromise(
      withPlatformLock(
        kiln.harness.config.dataDirectory,
        Effect.promise(async () => {
          await expect(restore("")).rejects.toThrow("Another Relay process")
        })
      )
    )
    expect(kiln.database.executedSql).toEqual([])
  })

  it("won't restore into a container under the database's name that keeps other data where Hearth's was", async () => {
    const kiln = await coolifyKiln()
    // Stopped, not removed: its DB_HOST would name the impostor too.
    const stopped = fakeDocker.container("hearth-1")
    if (stopped) stopped.state.running = false
    fakeDocker.removeContainer("coolify-mysql")
    const impostor = fakeDocker.addContainer({
      env: { MYSQL_DATABASE: "hearth" },
      mounts: [{ ...kiln.dataVolume, source: "another-data" }],
      name: "coolify-mysql",
      networks: ["coolify"],
      running: true,
    })

    await expect(kiln.restore()).rejects.toThrow("was not found")
    expect(impostor.executedSql).toEqual([])
  })
})

function platformHeader(manifestLength: number): Buffer {
  const header = Buffer.alloc(64)
  Buffer.from("KILNPLATFORM0001", "ascii").copy(header)
  header.writeUInt32BE(manifestLength, 60)
  return header
}

describe("Kiln platform backups on a MySQL other Hearths share", () => {
  const database = "s_aaaaaaaaaaaa"
  const hearth = (installation: string, running: boolean) => ({
    env: {
      BETTER_AUTH_SECRETS: "1:secret-of-every-worktree",
      DB_HOST: "kiln-dev-mysql",
      DB_NAME: database,
      KILN_URL: "https://kiln.example.test",
    },
    networks: ["kiln-dev"],
    labels: {
      "io.kiln.installation": installation,
      "io.kiln.resource": "hearth",
    },
    name: `${installation}-hearth-1`,
    running,
  })

  async function sharedKiln() {
    const harness = await relayHarness({
      KILN_INSTALLATION_ID: "kiln-test",
      KILN_PLATFORM_BACKUP_KEY: recoveryKey,
      KILN_RELAY_PLATFORM_DATABASE_CONTAINER: "kiln-dev-mysql",
      KILN_RELAY_PLATFORM_DATABASE_NAME: database,
    })
    onTestFinished(() => fakeDocker.reset())
    fakeDocker.addNetwork({ name: "kiln-dev" })
    const mysql = fakeDocker.addContainer({
      image: "mysql:8.4",
      name: "kiln-dev-mysql",
      networks: ["kiln-dev"],
      running: true,
    })
    // Worktrees share one .env, so this Hearth's proof also matches its
    // sibling's secrets.
    const own = fakeDocker.addContainer(hearth("kiln-test", true))
    fakeDocker.addContainer(hearth("kiln-sibling", true))
    await Effect.runPromise(loadOrCreateRelayIdentity(harness.config))
    const identified = await Effect.runPromise(
      identifyHearth(
        new DockerEngine(harness.config.dockerSocket),
        harness.config,
        harness.state,
        {
          clientId: "hearth-client",
          containerId: own.id,
          installationId: "kiln-test",
          proof: createHmac("sha256", "1:secret-of-every-worktree")
            .update("t")
            .digest("base64url"),
          transcript: "t",
        }
      )
    )
    assert.isTrue(identified)
    // Stopped, as a restore needs.
    own.state.running = false
    const restore = async (manifest: Partial<PlatformBackupManifest>) => {
      const source = join(testDirectory, `shared-${randomUUID()}.kiln`)
      await writeFile(
        source,
        platformBundle("CREATE TABLE kept (id int);", manifest)
      )
      return restoreEncryptedPlatformBackup(harness.config, source, "kiln-test")
    }
    return { harness, mysql, restore }
  }

  it("backs up and restores this stack's database while another stack runs", async () => {
    const kiln = await sharedKiln()
    kiln.mysql.sqlDump = "CREATE TABLE dumped (id int);"
    const backup = join(testDirectory, `shared-${randomUUID()}.kiln`)
    await createEncryptedPlatformBackup(
      kiln.harness.config,
      {
        backupId: "d".repeat(40),
        maxBytes: null,
        target: { id: "kiln-test", kind: "platform" },
      } as unknown as BackupCreateTaskInput,
      backup,
      { completed: 0, total: 0 },
      new AbortController().signal,
      await Effect.runPromise(
        collectPlatformRecovery(kiln.harness.config, kiln.harness.state)
      )
    )
    await expect(
      inspectEncryptedPlatformBackup(recoveryKey, backup)
    ).resolves.toMatchObject({ databaseName: database })
    assert.deepInclude(
      [...fakeDocker.execs.values()].map(({ env }) => env),
      { MYSQL_DATABASE: database }
    )

    await restoreEncryptedPlatformBackup(
      kiln.harness.config,
      backup,
      "kiln-test"
    )

    expect(kiln.mysql.executedSql.join("\n")).toContain(
      "CREATE TABLE dumped (id int);"
    )
  })

  it("carries what restores Kiln on a new machine, and restores the dump past it", async () => {
    const kiln = await sharedKiln()
    kiln.mysql.sqlDump = "CREATE TABLE dumped (id int);"
    const installation: PlatformState = {
      ...newPlatformState(
        kiln.harness.config,
        platformInputs({ KILN_URL: "https://kiln.example.test" }),
        "hearth:test"
      ),
      installationId: "kiln-test",
    }
    await Effect.runPromise(
      writePlatformState(kiln.harness.config.dataDirectory, installation)
    )
    await Effect.runPromise(loadOrCreateRelayIdentity(kiln.harness.config))
    const backup = join(testDirectory, `recovery-${randomUUID()}.kiln`)
    await createEncryptedPlatformBackup(
      kiln.harness.config,
      {
        backupId: "e".repeat(40),
        maxBytes: null,
        target: { id: "kiln-test", kind: "platform" },
      } as unknown as BackupCreateTaskInput,
      backup,
      { completed: 0, total: 0 },
      new AbortController().signal,
      await Effect.runPromise(
        collectPlatformRecovery(kiln.harness.config, kiln.harness.state)
      )
    )
    const read = await readPlatformBackupRecovery(recoveryKey, backup)
    expect(read.manifest).toMatchObject({
      databaseName: database,
      formatVersion: 2,
    })
    expect(read.recovery).toMatchObject({
      installation,
      relay: {
        identity: await Effect.runPromise(
          readRelayIdentityMaterial(kiln.harness.config)
        ),
      },
    })
    await expect(
      readPlatformBackupRecovery(`${recoveryKey}x`, backup)
    ).rejects.toThrow()

    await restoreEncryptedPlatformBackup(
      kiln.harness.config,
      backup,
      "kiln-test"
    )

    expect(kiln.mysql.executedSql.join("\n")).toContain(
      "CREATE TABLE dumped (id int);"
    )
  })

  it("won't restore a backup of another database, or one that doesn't name its database", async () => {
    const kiln = await sharedKiln()

    await expect(
      kiln.restore({ databaseName: "s_bbbbbbbbbbbb" })
    ).rejects.toThrow("holds the database s_bbbbbbbbbbbb")
    await expect(kiln.restore({})).rejects.toThrow("predates Kiln recording")
    expect(kiln.mysql.executedSql).toEqual([])
  })
})
