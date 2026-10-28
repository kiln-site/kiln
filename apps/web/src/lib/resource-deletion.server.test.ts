import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect, Layer, Schedule } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, vi } from "vite-plus/test"

import { Database } from "@/effect/database"
import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { testOperationsEngine } from "@/operations/test/engine"
import { insertSchedule } from "@/server/schedule-deployment.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertBackup,
  insertGrant,
  insertInstance,
  insertRelay,
  insertRows,
  insertUser,
  selectRows,
} from "@/test/seed"

import {
  cancelResourceDeletionEffect,
  deleteResource,
  requestResourceDeletionEffect,
  resumeResourceDeletions,
} from "./resource-deletion.server"

// The Relay is the only fake: the game servers and databases it has, which
// it has frozen and for which deletion, every change asked of it, and an
// outcome journal by command ID, as its control socket keeps. Its next
// delete can lose its reply or be refused.
const relay = vi.hoisted(() => ({
  changes: [] as Array<string>,
  databases: new Set<string>(),
  // Whether each database delete took its data volume too.
  deletedData: [] as Array<boolean>,
  frozen: new Map<string, string>(),
  journal: new Map<string, unknown>(),
  next: null as null | "loses-reply" | "refuses-delete",
  servers: new Set<string>(),
}))

vi.mock("@/lib/relay-connection", async (importOriginal) => {
  const { RelayUnavailableError } = await import("@/effect/errors")
  return {
    ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
    relayJournal: async () => ({
      clientId: "hearth-one",
      journalId: "journal-one",
    }),
    relayRpc: async (
      _relay: unknown,
      operation: string,
      payload: Record<string, unknown>,
      _timeout?: number,
      _subject?: string,
      _signal?: AbortSignal,
      frame: { operationId?: string } = {}
    ) => {
      if (operation === "operation.get") {
        return (
          relay.journal.get(String(payload.operationId)) ?? {
            status: "unknown",
          }
        )
      }
      if (operation === "relay.snapshot") return relaySnapshot()
      if (operation === "database.list") {
        const id = String(
          (payload.requests as Array<{ id: string }>)[0]?.id ?? ""
        )
        return relay.databases.has(id) ? [{ id }] : []
      }
      // Backups are queued and followed by Hearth's own records here.
      if (operation === "backup.task.list") return []
      if (operation === "backup.task.enqueue") {
        throw new Error("The Relay's backup queue is busy")
      }
      relay.changes.push(operation)
      const id = String(payload.id ?? payload.instanceId ?? payload.databaseId)
      let result: unknown
      switch (operation) {
        case "resource.freeze":
          relay.frozen.set(id, String(payload.deletionId))
          result = { frozen: true }
          break
        case "resource.unfreeze":
          if (relay.frozen.get(id) === payload.deletionId) {
            relay.frozen.delete(id)
          }
          result = { frozen: relay.frozen.has(id) }
          break
        case "instance.delete":
        case "database.delete":
          if (relay.next === "refuses-delete") {
            relay.next = null
            throw RelayUnavailableError.make({
              code: "delete_failed",
              message: "The Relay couldn't remove it",
              retryable: false,
            })
          }
          if (operation === "database.delete") {
            relay.deletedData.push(Boolean(payload.deleteData))
          }
          relay.servers.delete(id)
          relay.databases.delete(id)
          relay.frozen.delete(id)
          result =
            operation === "instance.delete"
              ? { deleted: true, instanceId: id }
              : { databaseId: id, deleted: true }
          break
        default:
          throw new Error(`Unexpected Relay operation ${operation}`)
      }
      if (frame.operationId) {
        relay.journal.set(frame.operationId, { result, status: "succeeded" })
      }
      if (relay.next === "loses-reply") {
        relay.next = null
        throw RelayUnavailableError.make({
          message: "The connection dropped before the Relay answered",
          outcome: "unknown",
        })
      }
      return result
    },
  }
})
vi.mock("@/lib/authorization-delivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authorization-delivery")>()),
  wakeAuthorizationDelivery: () => undefined,
}))

afterAll(() => disposeAppRuntime())

const Lanes = testOperationsEngine(deleteResource.layer).pipe(
  Layer.provideMerge(TestDatabase)
)

const relayId = "r".repeat(43)
const serverId = "a".repeat(40)
const databaseId = "d".repeat(40)
const at = 1_767_225_600_000

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
const owner = person("owner")
// Signed in, verified, and without any access to the game server.
const stranger = person("stranger")

// The owner's grant on one resource, with just these permissions.
const allow = (
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

// Every operation an earlier test started has ended, its workflow's last
// writes included, so emptying the tables doesn't wait on them.
const operationsEnded = selectRows<{ state: string }>("operation").pipe(
  Effect.repeat({
    schedule: Schedule.spaced("100 millis"),
    until: (rows) =>
      rows.every((row) =>
        ["cancelled", "failed", "interrupted", "succeeded"].includes(row.state)
      ),
  }),
  Effect.timeout("45 seconds")
)

const seed = Effect.gen(function* () {
  yield* operationsEnded
  yield* resetDatabase
  relay.changes.length = 0
  relay.frozen.clear()
  relay.journal.clear()
  relay.next = null
  relay.servers.clear()
  relay.servers.add(serverId)
  relay.databases.clear()
  relay.deletedData.length = 0
  yield* insertRelay(relayId)
  for (const user of [owner, stranger]) {
    yield* insertUser(user.id, { emailVerifiedAt: new Date(at) })
  }
  yield* allow("instance", serverId, ["instance.delete", "backup.create"])
  yield* insertInstance(relayId, serverId, { display_name: "Survival" })
})

const deletions = selectRows<{
  attempt: number
  backup_id: string | null
  error: string | null
  relay_deleted_at: number | null
  resource_id: string
  status: string
}>("resource_deletion")

const deletionOf = (resourceId: string) =>
  deletions.pipe(
    Effect.map((rows) => rows.find((row) => row.resource_id === resourceId))
  )

const until = (resourceId: string, statuses: ReadonlyArray<string>) =>
  deletionOf(resourceId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("100 millis"),
      until: (row) => row !== undefined && statuses.includes(row.status),
    }),
    Effect.timeout("45 seconds")
  )

const serverRecords = selectRows<{ instance_id: string }>("instance").pipe(
  Effect.map((rows) => rows.map((row) => row.instance_id))
)

// A deletion as an earlier Hearth, or the final-delete worker before it,
// left it.
const insertDeletion = (row: Record<string, unknown>) =>
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

describeMysql("Deleting a game server or database", () => {
  layer(Lanes, { timeout: 120_000 })((it) => {
    it.effect(
      "freezes then deletes once, even when the delete's reply is lost, and not again when started again",
      () =>
        Effect.gen(function* () {
          yield* seed
          relay.next = "loses-reply"

          yield* requestResourceDeletionEffect({
            finalBackup: false,
            kind: "instance",
            relayId,
            resourceId: serverId,
            user: owner,
          })
          const done = yield* until(serverId, ["completed", "failed"])
          // As after a restart, and as someone asking again.
          yield* resumeResourceDeletions()
          yield* requestResourceDeletionEffect({
            finalBackup: false,
            kind: "instance",
            relayId,
            resourceId: serverId,
            user: owner,
          })
          yield* Effect.sleep("1 second")

          assert.strictEqual(done?.status, "completed")
          assert.isNotNull(done?.relay_deleted_at)
          assert.deepStrictEqual(relay.changes, [
            "resource.freeze",
            "instance.delete",
          ])
          assert.isFalse(relay.servers.has(serverId))
          assert.deepStrictEqual(yield* serverRecords, [])
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "resumes a carried-over deletion with its final backup, taking no other",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* insertBackup("final-backup", {
            reason: "final_delete",
            relay_id: relayId,
            target_id: serverId,
          })
          yield* insertDeletion({
            backup_id: "final-backup",
            final_backup: true,
            status: "deleting",
          })

          yield* resumeResourceDeletions()
          yield* resumeResourceDeletions()
          const done = yield* until(serverId, ["completed", "failed"])

          assert.strictEqual(done?.status, "completed")
          assert.deepStrictEqual(relay.changes, [
            "resource.freeze",
            "instance.delete",
          ])
          // Kept, as final backups are, and the only one.
          assert.deepStrictEqual(
            (yield* selectRows<{ id: string; status: string }>("backup")).map(
              (row) => [row.id, row.status]
            ),
            [["final-backup", "available"]]
          )
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "deletes nothing when the final backup fails, keeping the server frozen until it's kept",
      () =>
        Effect.gen(function* () {
          yield* seed

          yield* requestResourceDeletionEffect({
            finalBackup: true,
            kind: "instance",
            relayId,
            resourceId: serverId,
            user: owner,
          })
          const backingUp = yield* until(serverId, ["backing_up"])
          // The Relay reports the backup failed, as reconciling records it.
          const database = yield* Database
          yield* database.execute(
            "test.failBackup",
            `UPDATE kiln_backup SET status = 'failed' WHERE id = ?`,
            [backingUp?.backup_id ?? ""]
          )
          yield* database.execute(
            "test.failBackupTask",
            `UPDATE kiln_backup_task SET status = 'failed',
                    error = 'Relay disk is full'
              WHERE backup_id = ?`,
            [backingUp?.backup_id ?? ""]
          )
          const failed = yield* until(serverId, ["failed", "completed"])

          assert.strictEqual(failed?.status, "failed")
          assert.strictEqual(failed?.error, "Relay disk is full")
          assert.deepStrictEqual(relay.changes, ["resource.freeze"])
          assert.isTrue(relay.servers.has(serverId))
          assert.isTrue(relay.frozen.has(serverId))
          assert.deepStrictEqual(yield* serverRecords, [serverId])

          yield* cancelResourceDeletionEffect({
            kind: "instance",
            relayId,
            resourceId: serverId,
            user: owner,
          })

          assert.strictEqual((yield* deletionOf(serverId))?.status, "cancelled")
          assert.isFalse(relay.frozen.has(serverId))
          assert.isTrue(relay.servers.has(serverId))
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "keeps everything when the Relay refuses to delete, and finishes on a retry",
      () =>
        Effect.gen(function* () {
          yield* seed
          relay.next = "refuses-delete"
          const request = requestResourceDeletionEffect({
            finalBackup: false,
            kind: "instance",
            relayId,
            resourceId: serverId,
            user: owner,
          })

          yield* request
          const failed = yield* until(serverId, ["failed", "completed"])

          assert.strictEqual(failed?.status, "failed")
          assert.include(failed?.error ?? "", "couldn't remove it")
          assert.isNull(failed?.relay_deleted_at)
          assert.deepStrictEqual(yield* serverRecords, [serverId])

          yield* request
          const done = yield* until(serverId, ["completed"])

          assert.strictEqual(done?.attempt, 2)
          assert.isFalse(relay.servers.has(serverId))
          assert.deepStrictEqual(yield* serverRecords, [])
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "only cleans up on a retry after the Relay deleted it, whoever asks",
      () =>
        Effect.gen(function* () {
          yield* seed
          relay.servers.clear()
          yield* insertDeletion({
            error: "Cleaning up failed",
            relay_deleted_at: at,
            status: "failed",
          })

          yield* requestResourceDeletionEffect({
            finalBackup: true,
            kind: "instance",
            relayId,
            resourceId: serverId,
            user: stranger,
          })
          const done = yield* until(serverId, ["completed", "failed"])

          assert.strictEqual(done?.status, "completed")
          assert.deepStrictEqual(relay.changes, [])
          assert.deepStrictEqual(yield* serverRecords, [])
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "touches nothing when the person who asked can no longer delete it",
      () =>
        Effect.gen(function* () {
          yield* seed

          yield* requestResourceDeletionEffect({
            finalBackup: false,
            kind: "instance",
            relayId,
            resourceId: serverId,
            user: stranger,
          })
          const failed = yield* until(serverId, ["failed", "completed"])

          assert.strictEqual(failed?.status, "failed")
          assert.include(failed?.error ?? "", "Nothing was deleted")
          assert.deepStrictEqual(relay.changes, [])
          assert.deepStrictEqual(yield* serverRecords, [serverId])
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "keeps what's left of a database's data when the Relay lists nothing of it",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* allow("database", databaseId, ["database.delete"])
          yield* insertRows("database", {
            created_at: at,
            created_by: owner.id,
            database_id: databaseId,
            database_name: "db_main",
            engine: "postgres",
            name: "main",
            password_ciphertext: "ciphertext",
            relay_id: relayId,
            updated_at: at,
            username: "user_main",
          })
          yield* requestResourceDeletionEffect({
            finalBackup: false,
            kind: "database",
            relayId,
            resourceId: databaseId,
            user: owner,
          })
          const done = yield* until(databaseId, ["completed", "failed"])

          assert.strictEqual(done?.status, "completed")
          assert.deepStrictEqual(relay.changes, [
            "resource.freeze",
            "database.delete",
          ])
          assert.deepStrictEqual(relay.deletedData, [false])
          assert.lengthOf(yield* selectRows("database"), 0)
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "refuses a schedule naming a game server whose deletion is under way",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* insertDeletion({ status: "backing_up" })
          const database = yield* Database
          const save = (id: string) =>
            database.transaction("test.schedule", (transaction) =>
              insertSchedule(
                transaction,
                {
                  actions: [],
                  continueOnFailure: false,
                  cron: "0 0 * * *",
                  enabled: true,
                  id,
                  name: "Nightly",
                  revision: 1,
                  targets: [
                    {
                      id: serverId,
                      kind: "instance",
                      name: "Survival",
                      relayId,
                    },
                  ],
                  timezone: "UTC",
                },
                owner.id,
                at
              )
            )

          const refused = yield* Effect.flip(save(randomUUID()))

          assert.strictEqual(refused.message, "Survival is being deleted")
          assert.lengthOf(yield* selectRows("schedule"), 0)

          // Kept, it's a target like any other again.
          yield* database.execute(
            "test.cancelDeletion",
            `UPDATE kiln_resource_deletion SET status = 'cancelled'`
          )
          yield* save(randomUUID())
          assert.lengthOf(yield* selectRows("schedule_target"), 1)
        }).pipe(TestClock.withLive),
      60_000
    )
  })
})

function relaySnapshot() {
  return {
    instances: [...relay.servers].map((id) => ({
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
