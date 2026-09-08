import { describe, expect, it } from "vite-plus/test"

import type { BackupCatalogRecord } from "@/effect/backups"
import type { AccessGrant } from "@/lib/access-control"
import { hasBackupPermission } from "@/lib/backup-access"
import type { AuthenticatedUser } from "@/lib/auth-session"

const user = {
  email: "user@example.com",
  emailVerified: true,
  id: "user-1",
  isDevelopmentBypass: false,
  name: "User",
  role: "user",
  twoFactorEnabled: false,
} satisfies AuthenticatedUser

const backup = {
  artifacts: [
    {
      bytes: 1,
      checksumSha256: "a".repeat(64),
      error: null,
      filename: "backup.zip",
      id: "730ae31f-a620-43f3-93fd-d259b58f6614",
      objectKey: null,
      status: "available",
      storageId: null,
    },
  ],
  artifactKind: "archive",
  backupMode: "full",
  bytes: 1,
  checksumSha256: "a".repeat(64),
  completedAt: "2026-08-10T00:00:00.000Z",
  createdAt: "2026-08-10T00:00:00.000Z",
  createdBy: "another-user",
  filename: "backup.zip",
  id: "15e6df81-575f-421d-a666-e3eaabaafc3b",
  name: "Backup",
  objectKey: null,
  reason: "manual",
  relayId: "relay-1",
  resticSnapshotId: null,
  status: "available",
  storageId: null,
  targetId: "instance-1",
  targetKind: "instance",
  taskBytesCompleted: 1,
  taskBytesTotal: 1,
  taskCurrentArtifactId: null,
  taskCurrentPath: null,
  taskError: null,
  taskId: "319864b6-421f-4a19-8946-f51048245d73",
  taskKind: "create",
  taskPhase: null,
  taskStartedAt: "2026-08-10T00:00:00.000Z",
  taskStatus: "succeeded",
  taskUpdatedAt: "2026-08-10T00:00:00.000Z",
  warnings: [],
} satisfies BackupCatalogRecord

describe("backup access", () => {
  it("keeps platform bundles exclusive to platform admins", () => {
    const platformBackup: BackupCatalogRecord = {
      ...backup,
      artifactKind: "platform_bundle",
      targetId: "kiln",
      targetKind: "platform",
    }
    const relayGrant: AccessGrant = {
      id: "relay-grant",
      relayId: backup.relayId,
      resourceId: backup.relayId,
      resourceType: "relay",
      role: "operator",
    }
    const admin: AuthenticatedUser = { ...user, id: "admin", role: "admin" }

    expect(
      hasBackupPermission(user, [relayGrant], platformBackup, "backup.read")
    ).toBe(false)
    expect(
      hasBackupPermission(user, [relayGrant], platformBackup, "backup.download")
    ).toBe(false)
    expect(
      hasBackupPermission(user, [relayGrant], platformBackup, "backup.restore")
    ).toBe(false)
    expect(
      hasBackupPermission(user, [relayGrant], platformBackup, "backup.delete")
    ).toBe(false)
    expect(
      hasBackupPermission(admin, [], platformBackup, "backup.download")
    ).toBe(true)
  })

  it("revokes historical backup reads and downloads when target access is lost", () => {
    const creatorBackup = { ...backup, createdBy: user.id }
    expect(hasBackupPermission(user, [], creatorBackup, "backup.read")).toBe(
      false
    )
    expect(
      hasBackupPermission(user, [], creatorBackup, "backup.download")
    ).toBe(false)
    expect(hasBackupPermission(user, [], creatorBackup, "backup.restore")).toBe(
      false
    )
    expect(hasBackupPermission(user, [], creatorBackup, "backup.delete")).toBe(
      false
    )
  })

  it("uses matching current grants for mutating backup actions", () => {
    const grant = {
      id: "grant-1",
      relayId: backup.relayId,
      resourceId: backup.targetId,
      resourceType: "instance",
      role: "operator",
    } satisfies AccessGrant
    expect(hasBackupPermission(user, [grant], backup, "backup.restore")).toBe(
      true
    )
    expect(hasBackupPermission(user, [grant], backup, "backup.delete")).toBe(
      true
    )
    expect(
      hasBackupPermission(
        user,
        [{ ...grant, resourceId: "another-instance" }],
        backup,
        "backup.restore"
      )
    ).toBe(false)
  })
})
