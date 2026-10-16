import { createCipheriv, scryptSync } from "node:crypto"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { afterAll, assert, describe, expect, it } from "@effect/vitest"
import { onTestFinished, vi } from "vite-plus/test"

import type { BackupCreateTaskInput } from "@workspace/contracts"

vi.mock("./command.js", () => import("./test/docker.js"))

import {
  createEncryptedPlatformBackup,
  inspectEncryptedPlatformBackup,
  type PlatformBackupManifest,
  restoreEncryptedPlatformBackup,
} from "./platform-backups.js"
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
function platformBundle(dump: string): Buffer {
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8")
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
  it("fails with the client's error and keeps no partial bundle", async () => {
    const harness = await relayHarness({
      KILN_INSTALLATION_ID: "kiln-test",
      KILN_PLATFORM_BACKUP_KEY: recoveryKey,
    })
    fakeDocker.addContainer({
      labels: {
        "io.kiln.installation": "kiln-test",
        "io.kiln.resource": "hearth-database",
      },
      name: "kiln-test-database",
      running: true,
    })
    fakeDocker.programFailures.set("mysqldump", "mysqldump: Access denied")
    const destination = join(testDirectory, "failed.kiln")

    await expect(
      createEncryptedPlatformBackup(
        harness.config,
        {
          backupId: "b".repeat(40),
          maxBytes: null,
          target: { id: "kiln-test", kind: "platform" },
        } as unknown as BackupCreateTaskInput,
        destination,
        { completed: 0, total: 0 },
        new AbortController().signal
      )
    ).rejects.toThrow("mysqldump: Access denied")
    expect(existsSync(destination)).toBe(false)
  })

  it("removes the decrypted dump when the database stops before the restore starts", async () => {
    const harness = await relayHarness({
      KILN_INSTALLATION_ID: "kiln-test",
      KILN_PLATFORM_BACKUP_KEY: recoveryKey,
    })
    onTestFinished(() => fakeDocker.reset())
    fakeDocker.addContainer({
      labels: {
        "io.kiln.installation": "kiln-test",
        "io.kiln.resource": "hearth-database",
      },
      name: "kiln-test-database",
      running: true,
    })
    const source = join(testDirectory, "restore.kiln")
    await writeFile(source, platformBundle("CREATE TABLE secrets (value text);"))
    // It stops after it was found, before its client starts.
    fakeDocker.failNext(
      { command: "exec", target: "kiln-test-database" },
      "Container kiln-test-database is not running"
    )

    await expect(
      restoreEncryptedPlatformBackup(harness.config, source, "kiln-test")
    ).rejects.toThrow("is not running")

    const staged = await readdir(join(harness.config.dataDirectory, "restores"))
    expect(staged.filter((name) => name.endsWith(".dmp.gz"))).toEqual([])
  })

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

  it.each([
    ["a file without the platform magic", Buffer.alloc(64)],
    ["an empty manifest length", platformHeader(0)],
    ["an oversized manifest length", platformHeader(64 * 1024 + 1)],
  ])("rejects %s before reading the payload", async (name, header) => {
    const source = join(testDirectory, `${name.replaceAll(" ", "-")}.kiln`)
    await writeFile(source, Buffer.concat([header, Buffer.alloc(128)]))
    await expect(
      inspectEncryptedPlatformBackup(recoveryKey, source)
    ).rejects.toThrow()
  })
})

function platformHeader(manifestLength: number): Buffer {
  const header = Buffer.alloc(64)
  Buffer.from("KILNPLATFORM0001", "ascii").copy(header)
  header.writeUInt32BE(manifestLength, 60)
  return header
}
