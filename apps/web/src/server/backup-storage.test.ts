import { assert, describe, it } from "@effect/vitest"

import type { BackupStorageRecord } from "@/backups/destinations/s3"

import {
  backupStorageInputSchema,
  visibleBackupStorage,
} from "./backup-storage"

describe("backup storage validation", () => {
  it("accepts uppercase bucket names supported by S3-compatible providers", () => {
    const parsed = backupStorageInputSchema.safeParse({
      accessKeyId: "key",
      bucket: " Kiln-Backups ",
      endpoint: "https://s3.example.com",
      name: "Backups",
      region: "us-east-1",
      secretAccessKey: "secret",
    })

    assert.isTrue(parsed.success)
    if (parsed.success) assert.strictEqual(parsed.data.bucket, "Kiln-Backups")
  })

  it("rejects bucket names S3 cannot address", () => {
    const parsed = backupStorageInputSchema.safeParse({
      accessKeyId: "key",
      bucket: "Not_A_Bucket",
      endpoint: "https://s3.example.com",
      name: "Backups",
      region: "us-east-1",
      secretAccessKey: "secret",
    })

    assert.isFalse(parsed.success)
    if (!parsed.success) {
      assert.deepEqual(parsed.error.issues[0]?.path, ["bucket"])
    }
  })

  it("rejects regions longer than the storage column", () => {
    const parsed = backupStorageInputSchema.safeParse({
      accessKeyId: "key",
      bucket: "Kiln-Backups",
      endpoint: "https://s3.example.com",
      name: "Backups",
      region: "r".repeat(121),
      secretAccessKey: "secret",
    })

    assert.isFalse(parsed.success)
    if (!parsed.success) {
      assert.deepEqual(parsed.error.issues[0]?.path, ["region"])
    }
  })
})

const storage = [
  backupStorage({ id: "platform", ownerUserId: null }),
  backupStorage({ id: "own", ownerUserId: "user-a" }),
  backupStorage({ id: "other", ownerUserId: "user-b" }),
]

describe("backup storage visibility", () => {
  it("limits regular users to platform and owned destinations", () => {
    assert.deepEqual(
      visibleBackupStorage(storage, "user-a", false).map(({ id }) => id),
      ["platform", "own"]
    )
  })

  it("shows every destination to platform storage managers", () => {
    assert.deepEqual(
      visibleBackupStorage(storage, "user-a", true).map(({ id }) => id),
      ["platform", "own", "other"]
    )
  })
})

function backupStorage(
  overrides: Pick<BackupStorageRecord, "id" | "ownerUserId">
): BackupStorageRecord {
  return {
    allowPrivateNetwork: false,
    bucket: "backups",
    createdAt: "2026-08-10T00:00:00.000Z",
    deleting: false,
    enabled: true,
    endpoint: "https://s3.example.com",
    forcePathStyle: false,
    id: overrides.id,
    lastError: null,
    lastVerifiedAt: null,
    name: overrides.id,
    objectPrefix: "",
    ownerUserId: overrides.ownerUserId,
    region: "us-east-1",
  }
}
