import { assert, beforeEach, describe, it } from "@effect/vitest"
import { vi } from "vite-plus/test"

const state = vi.hoisted(() => ({
  deleteFails: false,
  events: [] as Array<string>,
  existingStatus: null as null | "backing_up" | "completed" | "failed",
  pendingReads: 0,
  reservationMade: false,
  reservedStorageId: undefined as string | null | undefined,
}))

vi.mock("@workspace/contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/contracts")>()
  return {
    ...actual,
    relayControlDeadlineMs: () => 1_000,
    relaySnapshotSchema: { parse: (value: unknown) => value },
  }
})

vi.mock("@/effect/backups", async () => {
  const { Effect } = await import("effect")
  const deletion = (status: string) => ({
    backupId: "backup-one",
    backupStatus: "available",
    error: null,
    relayId: "relay-one",
    requestedBy: "user-one",
    status,
    targetId: "instance-one",
    taskError: null,
  })
  return {
    clearFailedFinalInstanceDeletionEffect: () =>
      Effect.sync(() => {
        state.events.push("clear-failed")
        state.existingStatus = null
        return true
      }),
    getFinalInstanceDeletionEffect: () =>
      Effect.succeed(
        state.existingStatus
          ? deletion(state.existingStatus)
          : state.reservationMade
            ? deletion("backing_up")
            : null
      ),
    listPendingFinalInstanceDeletionsEffect: () =>
      Effect.sync(() => {
        state.pendingReads += 1
        return state.pendingReads === 1 ? [deletion("deleting")] : []
      }),
    purgeInstanceBackupRepositoriesEffect: () =>
      Effect.sync(() => state.events.push("purge")),
    reserveInstanceBackupEffect: (input: { storageId?: string | null }) =>
      Effect.sync(() => {
        state.reservationMade = true
        state.reservedStorageId = input.storageId
        return { backupId: "backup-one", taskId: "task-one" }
      }),
    updateFinalInstanceDeletionEffect: (input: { status: string }) =>
      Effect.sync(() => {
        state.events.push(`update:${input.status}`)
        return true
      }),
  }
})

vi.mock("@/lib/backup-reconciliation", () => ({
  dispatchBackupTask: async () => undefined,
}))

vi.mock("@/effect/runtime", async () => {
  const { Effect } = await import("effect")
  return {
    runAppEffect: (_operation: string, effect: unknown) =>
      Effect.runPromise(effect as never),
  }
})

vi.mock("@/server/domains.server", async () => {
  const { Effect } = await import("effect")
  return {
    deleteInstanceDomainEffect: () =>
      Effect.sync(() => state.events.push("domain")),
  }
})

vi.mock("@/server/instance-deletion-cleanup", async () => {
  const { Effect } = await import("effect")
  return {
    finalizeInstanceDeletionEffect: () =>
      Effect.sync(() => state.events.push("finalize")),
  }
})

vi.mock("@/lib/relay-connection", () => ({
  relayRpc: async (
    _relay: unknown,
    method: string,
    _input: unknown
  ): Promise<unknown> => {
    state.events.push(method)
    if (method === "instance.delete") {
      if (state.deleteFails) throw new Error("Relay delete failed")
      return { deleted: true, instanceId: "instance-one" }
    }
    return { instances: [{ id: "instance-one" }] }
  },
}))

import {
  deleteInstanceWithoutFinalBackup,
  ensureFinalInstanceDeletion,
  processFinalInstanceDeletions,
} from "@/lib/final-instance-deletion"

describe("final instance deletion", () => {
  beforeEach(() => {
    state.deleteFails = false
    state.events.length = 0
    state.existingStatus = null
    state.pendingReads = 0
    state.reservationMade = false
    state.reservedStorageId = undefined
  })

  it("purges S3 repositories only after Relay confirms deletion", async () => {
    await processFinalInstanceDeletions({ id: "relay-one" } as never)

    assert.deepEqual(state.events, [
      "domain",
      "instance.delete",
      "purge",
      "finalize",
      "update:completed",
    ])
  })

  it("retains S3 repositories when Relay still has the instance", async () => {
    state.deleteFails = true

    await processFinalInstanceDeletions({ id: "relay-one" } as never)

    assert.deepEqual(state.events, [
      "domain",
      "instance.delete",
      "relay.snapshot",
      "update:deleting",
    ])
  })

  it("deletes directly when a final backup is unavailable", async () => {
    await deleteInstanceWithoutFinalBackup({
      instanceId: "instance-one",
      relay: { id: "relay-one" } as never,
      requestedBy: "user-one",
    })

    assert.deepEqual(state.events, [
      "domain",
      "instance.delete",
      "purge",
      "finalize",
    ])
  })

  it("clears a failed final backup before deleting directly", async () => {
    state.existingStatus = "failed"

    await deleteInstanceWithoutFinalBackup({
      instanceId: "instance-one",
      relay: { id: "relay-one" } as never,
      requestedBy: "user-one",
    })

    assert.deepEqual(state.events, [
      "clear-failed",
      "domain",
      "instance.delete",
      "purge",
      "finalize",
    ])
  })

  it("uses the selected destination for the final backup", async () => {
    await ensureFinalInstanceDeletion({
      instanceId: "instance-one",
      relay: { id: "relay-one" } as never,
      requestedBy: "user-one",
      storageId: "11111111-1111-4111-8111-111111111111",
    })

    assert.strictEqual(
      state.reservedStorageId,
      "11111111-1111-4111-8111-111111111111"
    )
  })
})
