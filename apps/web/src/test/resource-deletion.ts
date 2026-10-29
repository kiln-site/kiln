import { randomUUID } from "node:crypto"

import { Effect, Schedule } from "effect"

import { RelayUnavailableError } from "@/effect/errors"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { resetDatabase } from "@/test/database"
import {
  insertGrant,
  insertInstance,
  insertRelay,
  insertRows,
  insertUser,
  selectRows,
} from "@/test/seed"

// What deletion tests share: a fake Relay, and a game server on it that
// its owner may delete.

export const relayId = "r".repeat(43)
export const serverId = "a".repeat(40)
export const databaseId = "d".repeat(40)
export const at = 1_767_225_600_000

const person = (id: string) =>
  ({
    email: `${id}@example.test`,
    emailVerified: true,
    emailVerifiedAt: "2026-01-01T00:00:00.000Z",
    id,
    isDevelopmentBypass: false,
    name: id,
    role: "user",
    twoFactorEnabled: false,
  }) satisfies AuthenticatedUser
export const owner = person("owner")
// Signed in, verified, and without any access to the game server.
export const stranger = person("stranger")

/** The owner's grant on one resource, with just these permissions. */
export const allow = (
  resourceType: "database" | "instance",
  resourceId: string,
  permissions: ReadonlyArray<string>
) =>
  Effect.gen(function* () {
    const id = randomUUID()
    yield* insertGrant({
      id,
      relayId,
      resourceId,
      resourceType,
      role: null,
      userId: owner.id,
    })
    yield* insertRows(
      "access_selection",
      permissions.map((permission) => ({
        access_id: id,
        selection_key: permission,
        selection_kind: "permission",
      }))
    )
  })

// Waits a while for every operation an earlier test started to end, its
// workflow's last writes included, so emptying the tables doesn't wait on
// them. One a stopped test run left running never ends; it's emptied anyway.
const operationsEnded = selectRows<{ state: string }>("operation").pipe(
  Effect.repeat({
    schedule: Schedule.spaced("100 millis"),
    until: (rows) =>
      rows.every((row) =>
        ["cancelled", "failed", "interrupted", "succeeded"].includes(row.state)
      ),
  }),
  Effect.timeoutOption("15 seconds")
)

/** A fresh database with the owner's game server, on a fresh Relay. */
export const seedDeletion = Effect.gen(function* () {
  yield* operationsEnded
  yield* resetDatabase
  resetDeletionRelay([serverId])
  yield* insertRelay(relayId)
  for (const user of [owner, stranger]) {
    yield* insertUser(user.id, { emailVerifiedAt: new Date(at) })
  }
  yield* allow("instance", serverId, ["instance.delete", "backup.create"])
  yield* insertInstance(relayId, serverId, { display_name: "Survival" })
})

export const deletionOf = (resourceId: string) =>
  selectRows<{
    attempt: number
    backup_id: string | null
    error: string | null
    id: string
    relay_deleted_at: number | null
    resource_id: string
    status: string
  }>("resource_deletion").pipe(
    Effect.map((rows) => rows.find((row) => row.resource_id === resourceId))
  )

/** Waits, on the live clock, for a deletion to reach one of `statuses`. */
export const deletionUntil = (
  resourceId: string,
  statuses: ReadonlyArray<string>
) =>
  deletionOf(resourceId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("100 millis"),
      until: (row) => row !== undefined && statuses.includes(row.status),
    }),
    Effect.timeout("45 seconds")
  )

export const serverRecords = selectRows<{ instance_id: string }>(
  "instance"
).pipe(Effect.map((rows) => rows.map((row) => row.instance_id)))

/** A deletion as an earlier Hearth, or the final-delete worker, left it. */
export const insertDeletion = (row: Record<string, unknown>) =>
  insertRows("resource_deletion", {
    actor: JSON.stringify(owner),
    attempt: 1,
    created_at: at,
    final_backup: false,
    id: randomUUID(),
    relay_id: relayId,
    requested_by: owner.id,
    resource_id: serverId,
    resource_kind: "instance",
    status: "pending",
    updated_at: at,
    ...row,
  })

/**
 * A Relay for deletion tests, faked at `@/lib/relay-connection`: the game
 * servers and databases it has, which it froze and for which deletion,
 * every change asked of it, and an outcome journal by command ID, as its
 * control socket keeps. Its next delete can lose its reply, be refused, or
 * apply and then never answer, as when Hearth stops while waiting for it.
 */
export const deletionRelay = {
  changes: [] as Array<string>,
  databases: new Set<string>(),
  // Whether each database delete took its data volume too.
  deletedData: [] as Array<boolean>,
  frozen: new Map<string, string>(),
  journal: new Map<string, unknown>(),
  nextDelete: null as null | "loses-reply" | "refuses" | "stalls",
  servers: new Set<string>(),
}

export function resetDeletionRelay(servers: ReadonlyArray<string>): void {
  deletionRelay.changes.length = 0
  deletionRelay.databases.clear()
  deletionRelay.deletedData.length = 0
  deletionRelay.frozen.clear()
  deletionRelay.journal.clear()
  deletionRelay.nextDelete = null
  deletionRelay.servers.clear()
  for (const id of servers) deletionRelay.servers.add(id)
}

/** What a test's `vi.mock("@/lib/relay-connection")` replaces. */
export const deletionRelayConnection = {
  relayJournal: async () => ({
    clientId: "hearth-one",
    journalId: "journal-one",
  }),
  relayRpc: async (
    relay: { id: string },
    operation: string,
    payload: Record<string, unknown>,
    _timeout?: number,
    _subject?: string,
    _signal?: AbortSignal,
    frame: { operationId?: string } = {}
  ): Promise<unknown> => {
    const state = deletionRelay
    if (operation === "operation.get") {
      return (
        state.journal.get(String(payload.operationId)) ?? { status: "unknown" }
      )
    }
    if (operation === "relay.snapshot") return snapshot(relay.id)
    if (operation === "database.list") {
      const id = String(
        (payload.requests as Array<{ id: string }>)[0]?.id ?? ""
      )
      return state.databases.has(id) ? [{ id }] : []
    }
    // Backups are queued and followed by Hearth's own records here.
    if (operation === "backup.task.list") return []
    if (operation === "backup.task.enqueue") {
      throw new Error("The Relay's backup queue is busy")
    }
    state.changes.push(operation)
    const id = String(payload.id ?? payload.instanceId ?? payload.databaseId)
    const deleting =
      operation === "instance.delete" || operation === "database.delete"
    const outcome = deleting ? state.nextDelete : null
    if (deleting) state.nextDelete = null
    let result: unknown
    switch (operation) {
      case "resource.freeze":
        state.frozen.set(id, String(payload.deletionId))
        result = { frozen: true }
        break
      case "resource.unfreeze":
        if (state.frozen.get(id) === payload.deletionId) state.frozen.delete(id)
        result = { frozen: state.frozen.has(id) }
        break
      case "instance.delete":
      case "database.delete":
        if (outcome === "refuses") {
          throw RelayUnavailableError.make({
            code: "delete_failed",
            message: "The Relay couldn't remove it",
            retryable: false,
          })
        }
        if (operation === "database.delete") {
          state.deletedData.push(Boolean(payload.deleteData))
        }
        state.servers.delete(id)
        state.databases.delete(id)
        state.frozen.delete(id)
        result =
          operation === "instance.delete"
            ? { deleted: true, instanceId: id }
            : { databaseId: id, deleted: true }
        break
      default:
        throw new Error(`Unexpected Relay operation ${operation}`)
    }
    if (frame.operationId) {
      state.journal.set(frame.operationId, { result, status: "succeeded" })
    }
    if (outcome === "loses-reply") {
      throw RelayUnavailableError.make({
        message: "The connection dropped before the Relay answered",
        outcome: "unknown",
      })
    }
    if (outcome === "stalls") return new Promise(() => undefined)
    return result
  },
}

function snapshot(relayId: string) {
  return {
    instances: [...deletionRelay.servers].map((id) => ({
      connectAddress: "play.example.test:25565",
      containerId: null,
      desiredState: "stopped",
      directory: "/data/survival",
      game: "Minecraft",
      id,
      implementation: "paper",
      javaVersion: "21",
      name: "Survival",
      observedState: "stopped",
      service: "survival",
      shortId: id.slice(0, 8),
      status: "stopped",
      version: "1.21",
    })),
    node: {
      arch: "arm64",
      connectedAt: "2026-01-01T00:00:00.000Z",
      cpu: { cores: 4, loadPercent: 0 },
      docker: { available: true, version: "test" },
      id: relayId,
      memory: { totalBytes: 1, usedBytes: 0 },
      name: "Relay",
      platform: "linux",
      storage: { totalBytes: 1, usedBytes: 0 },
      version: "test",
    },
  }
}
