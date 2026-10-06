import { createCipheriv, scryptSync } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { afterAll, assert, describe, expect, it } from "@effect/vitest"

import {
  inspectEncryptedPlatformBackup,
  type PlatformBackupManifest,
} from "./platform-backups.js"

const testDirectory = mkdtempSync(join(tmpdir(), "kiln-platform-backup-"))
const recoveryKey = "test-recovery-key-with-at-least-32-bytes"

afterAll(() => {
  rmSync(testDirectory, { force: true, recursive: true })
})

describe("Kiln platform backups", () => {
  it("authenticates the manifest and encrypted payload", async () => {
    const manifest: PlatformBackupManifest = {
      compression: "gzip",
      createdAt: "2026-08-10T12:00:00.000Z",
      databaseEngine: "mysql",
      encryption: "aes-256-gcm+scrypt",
      formatVersion: 1,
      installationId: "kiln-test",
      payload: "hearth.dmp",
    }
    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8")
    const salt = Buffer.from("00112233445566778899aabbccddeeff", "hex")
    const initializationVector = Buffer.from("00112233445566778899aabb", "hex")
    // The bundle format pins scrypt with Node's default cost parameters.
    const key = scryptSync(recoveryKey, salt, 32)
    const cipher = createCipheriv("aes-256-gcm", key, initializationVector)
    cipher.setAAD(manifestBytes)
    const ciphertext = Buffer.concat([
      cipher.update(gzipSync("SELECT 1;")),
      cipher.final(),
    ])
    const header = platformHeader(manifestBytes.byteLength)
    salt.copy(header, 16)
    initializationVector.copy(header, 32)
    cipher.getAuthTag().copy(header, 44)

    const source = join(testDirectory, "valid.kiln")
    const bundle = Buffer.concat([header, manifestBytes, ciphertext])
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
