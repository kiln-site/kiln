import { beforeEach, describe, expect, it, vi } from "vite-plus/test"

import type { AccessGrant } from "@/lib/access-control"
import { grantHasPermission } from "@/lib/permissions"

const mocks = vi.hoisted(() => ({
  grants: [] as AccessGrant[],
  loadStorage: vi.fn(),
  publish: vi.fn(),
  reserveCopy: vi.fn(),
  reserveSafety: vi.fn(),
  reserveRestore: vi.fn(),
  rpc: vi.fn(),
  run: vi.fn(),
  scheduleCopy: vi.fn(),
}))

vi.mock("@workspace/contracts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/contracts")>()),
  relaySnapshotSchema: { parse: (value: unknown) => value },
}))

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    handler: (handler: unknown, serverHandler?: unknown) => ({
      __executeServer: serverHandler ?? handler,
    }),
    validator: () => ({
      handler: (handler: unknown, serverHandler?: unknown) => ({
        __executeServer: serverHandler ?? handler,
      }),
    }),
  }),
}))
vi.mock("@/server/auth", () => ({
  requireEligibleResourceUser: async () => ({
    emailVerifiedAt: "2026-01-01T00:00:00.000Z",
    id: "user-1",
    role: "user",
    status: "enabled",
  }),
}))
vi.mock("@/lib/access-control", () => ({
  hasPlatformPermission: () => false,
  isPlatformAdmin: () => false,
  listUserGrants: async () => mocks.grants,
  requireRelayPermission: async (input: {
    databaseId?: string
    instanceId?: string
    permission: Parameters<typeof grantHasPermission>[1]
    relayId: string
  }) => {
    if (
      !mocks.grants.some(
        (grant) =>
          grant.relayId === input.relayId &&
          grant.resourceId === (input.instanceId ?? input.databaseId) &&
          grantHasPermission(grant, input.permission)
      )
    )
      throw new Error("Permission denied")
  },
}))
vi.mock("@/effect/runtime", () => ({ runAppEffect: mocks.run }))
vi.mock("@/effect/backups", () => ({
  getBackupCatalogRecordEffect: () => "getBackup",
  getBackupPolicyEffect: () => "getPolicy",
  reserveBackupCopyEffect: mocks.reserveCopy,
  reserveInstanceBackupEffect: mocks.reserveSafety,
  reserveDatabaseBackupEffect: mocks.reserveSafety,
  reserveBackupRestoreEffect: mocks.reserveRestore,
}))
vi.mock("@/backups/destinations/s3", () => ({
  loadBackupStorageEffect: mocks.loadStorage,
}))
vi.mock("@/lib/backup-copy", () => ({
  scheduleBackupCopyProcessing: mocks.scheduleCopy,
}))
vi.mock("@/lib/backup-realtime.server", () => ({
  publishBackupChange: mocks.publish,
}))
vi.mock("@/lib/relay-registry", () => ({
  listPersistedRelays: async () => [{ id: "relay-1", enabled: true }],
}))
vi.mock("@/lib/relay-connection", () => ({ relayRpc: mocks.rpc }))
vi.mock("@/lib/backup-reconciliation", () => ({}))
vi.mock("@/backups/destinations", () => ({}))
vi.mock("@/backups/destinations/local", () => ({}))
vi.mock("@/lib/environment", () => ({}))
vi.mock("@/effect/backup-download-shares", () => ({}))
vi.mock("@/effect/managed-databases", () => ({
  listManagedDatabaseRecordsEffect: () => "records",
}))
vi.mock("@/lib/backup-run-cursor.server", () => ({}))

// Load the server provider so the test exercises handlers instead of RPC stubs.
import {
  copyBackupToDestination_createServerFn_handler as copyBackupToDestination,
  createInstanceBackup_createServerFn_handler as createInstanceBackup,
  restoreInstanceBackup_createServerFn_handler as restoreInstanceBackup,
  // @ts-expect-error TanStack Start exposes the provider through a Vite query.
} from "./backups?tss-serverfn-split"

const backup = {
  id: "15e6df81-575f-421d-a666-e3eaabaafc3b",
  relayId: "relay-1",
  targetKind: "instance",
  targetId: "instance-1",
  artifactKind: "archive",
  filename: "backup.zip",
  artifacts: [
    {
      id: "source-artifact",
      status: "available",
      storageId: null,
      filename: "backup.zip",
    },
  ],
}
const storageId = "730ae31f-a620-43f3-93fd-d259b58f6614"

function grant(
  permission: "backup.create" | "backup.download" | "backup.restore",
  resourceId = "instance-1"
): AccessGrant {
  return {
    id: "grant",
    relayId: "relay-1",
    resourceId,
    resourceType: "instance",
    permissions: [permission],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.grants = []
  mocks.run.mockImplementation(async (operation: string) => {
    if (operation === "backups.getForCopy") return backup
    if (operation === "backups.resolveStoragePolicy") return { storageId: null }
    if (operation === "backups.loadSelectedStorage")
      return { enabled: true, deleting: false, ownerUserId: "user-1" }
    if (operation === "backups.reserveCopy") return { taskId: "copy-task" }
    throw new Error(`Unexpected operation: ${operation}`)
  })
  mocks.rpc.mockRejectedValue(new Error("Resource lookup reached"))
})

describe("backup export authorization", () => {
  it("denies create-only copy before loading a destination or queuing work", async () => {
    mocks.grants = [grant("backup.create")]
    await expect(
      copyBackupToDestination({ data: { backupId: backup.id, storageId } })
    ).rejects.toThrow("permission to copy")
    expect(mocks.loadStorage).not.toHaveBeenCalled()
    expect(mocks.reserveCopy).not.toHaveBeenCalled()
    expect(mocks.scheduleCopy).not.toHaveBeenCalled()
  })

  it("allows a target download grant to queue a copy without create permission", async () => {
    mocks.grants = [grant("backup.download")]
    await expect(
      copyBackupToDestination({ data: { backupId: backup.id, storageId } })
    ).resolves.toEqual({ copied: false, queued: true, taskId: "copy-task" })
    expect(mocks.reserveCopy).toHaveBeenCalledWith(
      expect.objectContaining({
        backupId: backup.id,
        storageId,
        requestedBy: "user-1",
      })
    )
    expect(mocks.scheduleCopy).toHaveBeenCalledOnce()
  })

  it("does not allow a sibling download grant to export the backup", async () => {
    mocks.grants = [grant("backup.download", "instance-2")]
    await expect(
      copyBackupToDestination({ data: { backupId: backup.id, storageId } })
    ).rejects.toThrow("permission to copy")
    expect(mocks.loadStorage).not.toHaveBeenCalled()
    expect(mocks.reserveCopy).not.toHaveBeenCalled()
  })

  it("requires download permission when creating directly into personal storage", async () => {
    mocks.grants = [grant("backup.create")]
    await expect(
      createInstanceBackup({
        data: {
          instanceId: "instance-1",
          relayId: "relay-1",
          name: "Backup",
          storageIds: [null, storageId],
        },
      })
    ).rejects.toThrow("You do not have permission to perform this action")
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it("requires download permission for a personal safety-backup destination", async () => {
    mocks.grants = [grant("backup.restore"), grant("backup.create")]
    mocks.rpc.mockResolvedValue({
      instances: [
        {
          id: backup.targetId,
          observedState: "stopped",
          desiredState: "stopped",
        },
      ],
    })
    mocks.run.mockImplementation(async (operation: string) => {
      if (operation === "backups.getForRestore")
        return { ...backup, status: "available", backupMode: "full" }
      if (operation === "backups.resolveStoragePolicy") return { storageId }
      if (operation === "backups.loadSelectedStorage")
        return { enabled: true, deleting: false, ownerUserId: "user-1" }
      throw new Error(`Unexpected operation: ${operation}`)
    })

    await expect(
      restoreInstanceBackup({
        data: { backupId: backup.id, safetyBackup: true },
      })
    ).rejects.toThrow("Permission denied")
    expect(mocks.reserveSafety).not.toHaveBeenCalled()
    expect(mocks.reserveRestore).not.toHaveBeenCalled()
  })
})
