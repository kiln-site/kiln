import { assert, describe, it } from "@effect/vitest"

import type { BackupStorageRecord } from "@/backups/destinations/s3"

import { visibleBackupStorage } from "./backup-storage"

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
