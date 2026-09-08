import { beforeEach, describe, expect, it, vi } from "vite-plus/test"
import {
  scheduleBackupActionSchema,
  scheduleTargetKey,
  type ScheduleTarget,
} from "@workspace/contracts"
import type { AccessGrant } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { requireScheduleBackupDestinations } from "@/lib/schedule-backup-destinations.server"

const mocks = vi.hoisted(() => ({ storage: vi.fn() }))
vi.mock("@/backups/destinations/s3", () => ({
  loadBackupStorageEffect: (id: string) => id,
}))
vi.mock("@/effect/runtime", () => ({
  runAppEffect: (_name: string, id: string) => mocks.storage(id),
}))
vi.mock("@/lib/access-control", () => ({
  isPlatformAdmin: (user: AuthenticatedUser) => user.role === "admin",
  hasPlatformPermission: (user: AuthenticatedUser) => user.role === "admin",
}))
const user = { id: "user", role: "user" } as AuthenticatedUser
const storageId = "a01d9771-607d-4c22-b492-fb49c36a8a32"
const target: ScheduleTarget = {
  id: "server-a",
  relayId: "relay-a",
  kind: "instance",
  name: "Server A",
}
const otherTarget: ScheduleTarget = {
  id: "database-b",
  relayId: "relay-b",
  kind: "database",
  name: "Database B",
}
const action = scheduleBackupActionSchema.parse({
  id: storageId,
  type: "backup",
  destination: { kind: "storage", storageId },
})
function grant(
  target: ScheduleTarget,
  permissions: NonNullable<AccessGrant["permissions"]>
): AccessGrant {
  return {
    id: target.id,
    relayId: target.relayId,
    resourceId: target.id,
    resourceType: target.kind,
    role: "viewer",
    permissions,
  }
}
const input = {
  actions: [action],
  targets: [target],
  grants: [grant(target, ["backup.create"])],
  user,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.storage.mockResolvedValue({
    ownerUserId: user.id,
    enabled: true,
    deleting: false,
  })
})

describe("scheduled backup export authorization", () => {
  it("rejects create-only permission for personal storage", async () => {
    await expect(requireScheduleBackupDestinations(input)).rejects.toThrow(
      "backup.download"
    )
  })
  it("allows export permission on the target and platform admins", async () => {
    await expect(
      requireScheduleBackupDestinations({
        ...input,
        grants: [grant(target, ["backup.download"])],
      })
    ).resolves.toBeUndefined()
    await expect(
      requireScheduleBackupDestinations({
        ...input,
        user: { ...user, role: "admin" },
      })
    ).resolves.toBeUndefined()
  })
  it("requires export permission independently on every applicable target", async () => {
    await expect(
      requireScheduleBackupDestinations({
        ...input,
        targets: [target, otherTarget],
        grants: [grant(target, ["backup.download"])],
      })
    ).rejects.toThrow("Database B")
  })
  it("honors action target selection and does not require export on unrelated targets", async () => {
    await expect(
      requireScheduleBackupDestinations({
        ...input,
        actions: [{ ...action, targetKeys: [scheduleTargetKey(target)] }],
        targets: [target, otherTarget],
        grants: [grant(target, ["backup.download"])],
      })
    ).resolves.toBeUndefined()
  })
  it("does not use backup policy defaults for omitted destinations", async () => {
    const local = scheduleBackupActionSchema.parse({
      id: storageId,
      type: "backup",
    })
    await expect(
      requireScheduleBackupDestinations({ ...input, actions: [local] })
    ).resolves.toBeUndefined()
    expect(mocks.storage).not.toHaveBeenCalled()
  })
  it("permits shared platform storage without export permission", async () => {
    mocks.storage.mockResolvedValue({
      ownerUserId: null,
      enabled: true,
      deleting: false,
    })
    await expect(
      requireScheduleBackupDestinations(input)
    ).resolves.toBeUndefined()
  })
  it("prevents assigning another user's storage during creation or editing", async () => {
    mocks.storage.mockResolvedValue({
      ownerUserId: "other-user",
      enabled: true,
      deleting: false,
    })
    await expect(
      requireScheduleBackupDestinations({
        ...input,
        grants: [grant(target, ["backup.download"])],
      })
    ).rejects.toThrow("unavailable")
  })
  it("requires export for manual execution while retaining the approved destination's owner", async () => {
    mocks.storage.mockResolvedValue({
      ownerUserId: "other-user",
      enabled: true,
      deleting: false,
    })
    await expect(
      requireScheduleBackupDestinations({
        ...input,
        checkStorageOwnership: false,
      })
    ).rejects.toThrow("backup.download")
    await expect(
      requireScheduleBackupDestinations({
        ...input,
        checkStorageOwnership: false,
        grants: [grant(target, ["backup.download"])],
      })
    ).resolves.toBeUndefined()
  })
})
