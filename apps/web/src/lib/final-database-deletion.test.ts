import { beforeEach, describe, expect, it, vi } from "vite-plus/test"
import type { AuthenticatedUser } from "@/lib/auth-session"

const state = vi.hoisted(() => ({
  canCreate: true,
  canDownload: false,
  failed: true,
  owner: "user-one" as string | null,
  policyStorageId: "personal-storage" as string | null,
  reserved: vi.fn(),
  clearFailed: vi.fn(),
  dispatch: vi.fn(),
}))

vi.mock("@/lib/access-control", () => ({
  requireRelayPermission: async ({ permission }: { permission: string }) => {
    if (permission === "backup.create" ? !state.canCreate : !state.canDownload)
      throw new Error("Permission denied")
  },
}))
vi.mock("@/effect/runtime", async () => {
  const { Effect } = await import("effect")
  return {
    runAppEffect: (_operation: string, effect: never) =>
      Effect.runPromise(effect),
  }
})
vi.mock("@/effect/backups", async () => {
  const { Effect } = await import("effect")
  return {
    getFinalDatabaseDeletionEffect: () =>
      Effect.succeed(state.failed ? { status: "failed" } : null),
    getBackupPolicyEffect: () =>
      Effect.succeed({ storageId: state.policyStorageId }),
    clearFailedFinalDatabaseDeletionEffect: () =>
      Effect.sync(() => {
        state.clearFailed()
        state.failed = false
      }),
    reserveDatabaseBackupEffect: (input: unknown) =>
      Effect.sync(() => {
        state.reserved(input)
        throw new Error("Reservation reached")
      }),
  }
})
vi.mock("@/backups/destinations/s3", async () => {
  const { Effect } = await import("effect")
  return {
    loadBackupStorageEffect: () =>
      Effect.succeed({
        enabled: true,
        deleting: false,
        ownerUserId: state.owner,
      }),
  }
})
vi.mock("@/lib/backup-reconciliation", () => ({
  dispatchBackupTask: state.dispatch,
}))
vi.mock("@/lib/relay-connection", () => ({}))
vi.mock("@/effect/managed-databases", () => ({}))
vi.mock("@/lib/backup-realtime.server", () => ({}))

import { ensureFinalDatabaseDeletion } from "./final-database-deletion"

const input = {
  databaseId: "database-one",
  relay: { id: "relay-one" } as never,
  requestedBy: "user-one",
  user: {
    id: "user-one",
    role: "user",
    email: "user@example.com",
    emailVerified: true,
    isDevelopmentBypass: false,
    name: "User",
    twoFactorEnabled: false,
  } satisfies AuthenticatedUser,
}

beforeEach(() => {
  vi.clearAllMocks()
  state.canCreate = true
  state.canDownload = false
  state.failed = true
  state.owner = "user-one"
  state.policyStorageId = "personal-storage"
})

describe("final database backup export", () => {
  it("denies personal default export without clearing a failed plan", async () => {
    await expect(ensureFinalDatabaseDeletion(input)).rejects.toThrow(
      "Permission denied"
    )
    expect(state.clearFailed).not.toHaveBeenCalled()
    expect(state.reserved).not.toHaveBeenCalled()
    expect(state.dispatch).not.toHaveBeenCalled()
  })

  it("requires create permission before scheduling a final backup", async () => {
    state.canCreate = false
    state.canDownload = true
    await expect(ensureFinalDatabaseDeletion(input)).rejects.toThrow(
      "Permission denied"
    )
    expect(state.clearFailed).not.toHaveBeenCalled()
    expect(state.reserved).not.toHaveBeenCalled()
  })

  it("pins the personal default destination with download permission", async () => {
    state.canDownload = true
    await expect(ensureFinalDatabaseDeletion(input)).rejects.toThrow(
      "Reservation reached"
    )
    expect(state.reserved).toHaveBeenCalledWith(
      expect.objectContaining({ storageIds: ["personal-storage"] })
    )
  })

  it.each([null, "platform-storage"])(
    "permits create-only backups to local/platform storage (%s)",
    async (storageId) => {
      state.policyStorageId = storageId
      state.owner = null
      await expect(ensureFinalDatabaseDeletion(input)).rejects.toThrow(
        "Reservation reached"
      )
      expect(state.reserved).toHaveBeenCalledWith(
        expect.objectContaining({ storageIds: [storageId] })
      )
    }
  )
})
