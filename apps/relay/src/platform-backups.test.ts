import { createCipheriv, createHmac, randomUUID, scryptSync } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { afterAll, assert, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { onTestFinished, vi } from "vite-plus/test"

import type { BackupCreateTaskInput } from "@workspace/contracts"

vi.mock("./command.js", () => import("./test/docker.js"))

import {
  createEncryptedPlatformBackup,
  inspectEncryptedPlatformBackup,
  type PlatformBackupManifest,
  restoreEncryptedPlatformBackup,
} from "./platform-backups.js"
import { DockerEngine } from "./docker-engine.js"
import { adoptProvenHearth } from "./installation.js"
import { provenHearthContainer } from "./platform.js"
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
  options: { databaseEnvironment?: Record<string, string> } = {}
) {
  const harness = await relayHarness({
    KILN_INSTALLATION_ID: "kiln-test",
    KILN_PLATFORM_BACKUP_KEY: recoveryKey,
  })
  onTestFinished(() => fakeDocker.reset())
  const hearth = {
    env: {
      BETTER_AUTH_SECRETS: "1:hearth-secret",
      DB_HOST: "coolify-mysql",
      DB_NAME: "hearth",
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
    labels: { "coolify.managed": "true" },
    mounts: [dataVolume],
    name: "coolify-mysql",
    networks: ["coolify"],
    running: true,
  })
  const engine = new DockerEngine(harness.config.dockerSocket)
  const proven = await Effect.runPromise(
    provenHearthContainer(engine, {
      containerId: proving.id,
      proof: createHmac("sha256", "1:hearth-secret")
        .update("t")
        .digest("base64url"),
      transcript: "t",
    })
  )
  assert.isNotNull(proven)
  await Effect.runPromise(
    adoptProvenHearth(harness.config, harness.state, {
      ...proven!,
      installationId: "kiln-test",
    })
  )
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
      new AbortController().signal
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
