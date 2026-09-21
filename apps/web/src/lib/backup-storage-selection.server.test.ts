import { beforeEach, describe, expect, it, vi } from "vite-plus/test"
import type { AuthenticatedUser } from "@/lib/auth-session"

const mocks = vi.hoisted(() => ({
  policyStorageId: null as string | null,
  storage: null as null | {
    enabled: boolean
    deleting: boolean
    ownerUserId: string | null
  },
  requireRelayPermission: vi.fn(),
}))

vi.mock("@/lib/access-control", () => ({
  requireRelayPermission: mocks.requireRelayPermission,
}))

vi.mock("@/backups/destinations/s3", async () => {
  const { Effect } = await import("effect")
  return { loadBackupStorageEffect: () => Effect.succeed(mocks.storage) }
})

vi.mock("@/effect/backups", async () => {
  const { Effect } = await import("effect")
  return {
    getBackupPolicyEffect: () =>
      Effect.succeed({ storageId: mocks.policyStorageId }),
  }
})

vi.mock("@/effect/runtime", async () => {
  const { Effect } = await import("effect")
  return {
    runAppEffect: (_operation: string, effect: unknown) =>
      Effect.runPromise(effect as never),
  }
})

import { resolveAuthorizedBackupStorageSelection } from "@/lib/backup-storage-selection.server"

const user = {
  id: "user-one",
  role: "user",
  email: "user@example.com",
  emailVerified: true,
  isDevelopmentBypass: false,
  name: "User",
  twoFactorEnabled: false,
} satisfies AuthenticatedUser

const selection = {
  relayId: "relay-one",
  targetId: "instance-one",
  targetKind: "instance" as const,
  user,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.policyStorageId = null
  mocks.storage = { enabled: true, deleting: false, ownerUserId: null }
})

describe("resolveAuthorizedBackupStorageSelection", () => {
  it("requires backup.download for a personal destination", async () => {
    mocks.storage = { enabled: true, deleting: false, ownerUserId: user.id }
    mocks.requireRelayPermission.mockRejectedValueOnce(
      new Error("Permission denied")
    )

    await expect(
      resolveAuthorizedBackupStorageSelection({
        ...selection,
        storageId: "personal-storage",
      })
    ).rejects.toThrow("Permission denied")

    expect(mocks.requireRelayPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: "instance-one",
        permission: "backup.download",
        relayId: "relay-one",
      })
    )
  })

  it("rejects another user's destination even with download permission", async () => {
    mocks.storage = {
      enabled: true,
      deleting: false,
      ownerUserId: "another-user",
    }

    await expect(
      resolveAuthorizedBackupStorageSelection({
        ...selection,
        storageId: "other-storage",
      })
    ).rejects.toThrow("Backup destination is unavailable")

    expect(mocks.requireRelayPermission).not.toHaveBeenCalled()
  })

  it("allows platform storage without a download check", async () => {
    await expect(
      resolveAuthorizedBackupStorageSelection({
        ...selection,
        storageIds: [null, "platform-storage"],
      })
    ).resolves.toEqual([null, "platform-storage"])

    expect(mocks.requireRelayPermission).not.toHaveBeenCalled()
  })

  it("pins the policy default when no destination is selected", async () => {
    mocks.policyStorageId = "personal-storage"
    mocks.storage = { enabled: true, deleting: false, ownerUserId: user.id }

    await expect(
      resolveAuthorizedBackupStorageSelection(selection)
    ).resolves.toEqual(["personal-storage"])

    expect(mocks.requireRelayPermission).toHaveBeenCalledOnce()
  })
})
