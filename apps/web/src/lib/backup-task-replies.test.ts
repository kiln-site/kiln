import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { relayBackupTaskReportSchema } from "@workspace/contracts"

import type { AuthenticatedUser } from "@/lib/auth-session"

import { reconcileBackupTaskEffect } from "@/effect/backups"
import { disposeAppRuntime, runAppEffect } from "@/effect/runtime"
import {
  cancelCreateForDelete,
  reconcileRelayBackups,
} from "@/lib/backup-reconciliation"
import { listPersistedRelays } from "@/lib/relay-registry"
import { cancelBackupHandler } from "@/server/backups.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertBackup, insertRelay, insertRows, selectRows } from "@/test/seed"
import { relayBackupTaskPage } from "@/test/relay-backup-tasks"

// Hearth applies a Relay's answer about a task only to the task it asked
// about, and counts a task as arrived only when the Relay holds that task.

const relayId = "1".repeat(12)
const at = Date.UTC(2026, 10, 1)
const first = {
  artifactId: "11111111-1111-4111-8111-1111111111a1",
  backupId: "11111111-1111-4111-8111-111111111111",
  taskId: "11111111-1111-4111-8111-1111111111c1",
}
const deleteTaskId = "33333333-3333-4333-8333-3333333333d3"
const second = {
  artifactId: "22222222-2222-4222-8222-2222222222a2",
  backupId: "22222222-2222-4222-8222-222222222222",
  taskId: "22222222-2222-4222-8222-2222222222c2",
}

const createTask = (
  ids: typeof first,
  status: "cancelled" | "queued",
  kind: "create" | "delete" = "create"
) => ({
  backupId: ids.backupId,
  bytesCompleted: 0,
  bytesTotal: null,
  createdAt: at,
  error: status === "cancelled" ? "Cancelled" : null,
  finishedAt: status === "cancelled" ? at + 1 : null,
  input:
    kind === "create"
      ? {
          artifactKind: "archive",
          backupId: ids.backupId,
          destination: { artifactId: ids.artifactId, kind: "local" },
          exclude: [],
          kind: "create",
          maxBytes: null,
          mode: "full",
          reason: "manual",
          target: { id: "instance-one", kind: "instance" },
          taskId: ids.taskId,
        }
      : {
          backupId: ids.backupId,
          destination: { artifactId: ids.artifactId, kind: "local" },
          kind: "delete",
          target: { id: "instance-one", kind: "instance" },
          taskId: ids.taskId,
        },
  inputRefreshRequired: false,
  kind,
  result: null,
  startedAt: status === "cancelled" ? at : null,
  status,
  taskId: ids.taskId,
  updatedAt: at + 1,
})

const admin: AuthenticatedUser = {
  id: "admin-one",
  name: "Admin",
  email: "admin@example.test",
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  isDevelopmentBypass: false,
  role: "admin",
  status: "enabled",
  twoFactorEnabled: false,
}

// The Relay, the one boundary: each test says how it answers.
const relay = vi.hoisted(() => ({
  answer: (_operation: string, _payload: unknown): unknown => null,
}))
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (_relay: unknown, operation: string, payload: unknown) =>
    relay.answer(operation, payload),
}))
vi.mock("@/lib/realtime-source.server", () => ({
  publishRealtimeChange: () => undefined,
}))

afterAll(() => disposeAppRuntime())

// Two manual backups on the Relay, each with its create.
const seed = (status: "queued" | "running") =>
  Effect.gen(function* () {
    yield* resetDatabase
    yield* insertRelay(relayId, { enabled: 1 })
    for (const [index, ids] of [first, second].entries()) {
      yield* insertBackup(ids.backupId, { relay_id: relayId, status })
      yield* insertRows("backup_artifact", {
        id: ids.artifactId,
        backup_id: ids.backupId,
        destination_key: "local",
        status,
        created_at: at + index,
        updated_at: at + index,
      })
      yield* insertRows("backup_task", {
        id: ids.taskId,
        backup_id: ids.backupId,
        task_kind: "create",
        status,
        created_at: at + index,
        updated_at: at + index,
      })
    }
    return (yield* Effect.promise(listPersistedRelays))[0]!
  })

const tasks = selectRows<{
  error: string | null
  id: string
  relay_updated_at_ms: number | null
  status: string
}>("backup_task")

describeMysql("A Relay's answer about a backup task", () => {
  layer(TestDatabase)((it) => {
    it.effect("is applied only to the task Hearth asked about", () =>
      Effect.gen(function* () {
        const persisted = yield* seed("running")
        // Asked to cancel one create, the Relay answers with the other,
        // cancelled.
        relay.answer = (operation) => {
          if (operation === "backup.task.cancel") {
            return createTask(second, "cancelled")
          }
          if (operation === "backup.task.list") return relayBackupTaskPage([])
          throw new Error(`Unexpected Relay request ${operation}`)
        }

        const outcome = yield* Effect.promise(() =>
          cancelCreateForDelete(persisted, first.taskId).then(
            () => "answered",
            () => "refused"
          )
        )

        assert.strictEqual(outcome, "refused")
        const backups = yield* selectRows<{ id: string; status: string }>(
          "backup"
        )
        assert.deepStrictEqual(
          backups.map(({ status }) => status),
          ["running", "running"]
        )
      })
    )

    it.effect(
      "to a cancel is not taken as cancelled once Hearth has the create's success",
      () =>
        Effect.gen(function* () {
          yield* seed("running")
          // The create finishes, and a pass accepts its success, while the
          // cancel is on its way; the Relay then answers cancelled.
          relay.answer = async (operation) => {
            if (operation !== "backup.task.cancel") {
              throw new Error(`Unexpected Relay request ${operation}`)
            }
            await runAppEffect(
              "test.success",
              reconcileBackupTaskEffect(
                relayBackupTaskReportSchema.parse({
                  ...createTask(first, "queued"),
                  bytesCompleted: 2048,
                  bytesTotal: 2048,
                  finishedAt: at + 1,
                  result: {
                    artifacts: [
                      {
                        artifactId: first.artifactId,
                        error: null,
                        status: "available",
                      },
                    ],
                    bytes: 2048,
                    checksumSha256: "a".repeat(64),
                    filename: `${first.backupId}.zip`,
                    warnings: [],
                  },
                  startedAt: at,
                  status: "succeeded",
                }),
                relayId
              )
            )
            return { ...createTask(first, "cancelled"), updatedAt: at + 5 }
          }

          const outcome = yield* Effect.promise(() =>
            cancelBackupHandler(admin, { backupId: first.backupId }).then(
              () => "cancelled",
              () => "refused"
            )
          )

          assert.strictEqual(outcome, "refused")
          const backups = yield* selectRows<{ id: string; status: string }>(
            "backup"
          )
          assert.strictEqual(
            backups.find(({ id }) => id === first.backupId)?.status,
            "available"
          )
        })
    )

    it.effect("about another task leaves the pass to send the rest", () =>
      Effect.gen(function* () {
        const persisted = yield* seed("queued")
        // The first create is answered with the second; the second with
        // itself.
        relay.answer = (operation) => {
          if (operation === "backup.task.list") return relayBackupTaskPage([])
          if (operation === "backup.task.enqueue") {
            return createTask(second, "queued")
          }
          throw new Error(`Unexpected Relay request ${operation}`)
        }

        yield* Effect.promise(() => reconcileRelayBackups(persisted))

        const byId = new Map((yield* tasks).map((task) => [task.id, task]))
        // Only the second is recorded as heard from its Relay.
        assert.isNull(byId.get(first.taskId)?.relay_updated_at_ms ?? null)
        assert.isNotNull(byId.get(second.taskId)?.relay_updated_at_ms ?? null)
      })
    )

    it.effect(
      "settles a task whose ID the Relay holds for another, rather than counting it sent",
      () =>
        Effect.gen(function* () {
          const persisted = yield* seed("queued")
          // The Relay lists a delete under the first create's ID, and the
          // second create as Hearth sent it.
          relay.answer = (operation, payload) => {
            if (operation === "backup.task.list") {
              return relayBackupTaskPage(
                [
                  createTask(first, "queued", "delete"),
                  createTask(second, "queued"),
                ],
                payload
              )
            }
            throw new Error(`Unexpected Relay request ${operation}`)
          }

          yield* Effect.promise(() => reconcileRelayBackups(persisted))

          const byId = new Map((yield* tasks).map((task) => [task.id, task]))
          assert.strictEqual(byId.get(first.taskId)?.status, "failed")
          assert.strictEqual(byId.get(second.taskId)?.status, "queued")
        })
    )

    it.effect(
      "settles a task the Relay holds for another resource under its ID",
      () =>
        Effect.gen(function* () {
          const persisted = yield* seed("queued")
          // The first create listed as Hearth sent it but for another game
          // server, waiting on fresh input.
          relay.answer = (operation, payload) => {
            if (operation === "backup.task.list") {
              const listed = createTask(first, "queued")
              return relayBackupTaskPage(
                [
                  {
                    ...listed,
                    input: {
                      ...listed.input,
                      target: { id: "d".repeat(12), kind: "instance" },
                    },
                    inputRefreshRequired: true,
                  },
                  createTask(second, "queued"),
                ],
                payload
              )
            }
            throw new Error(`Unexpected Relay request ${operation}`)
          }

          yield* Effect.promise(() => reconcileRelayBackups(persisted))

          const byId = new Map((yield* tasks).map((task) => [task.id, task]))
          assert.strictEqual(byId.get(first.taskId)?.status, "failed")
          assert.strictEqual(byId.get(second.taskId)?.status, "queued")
        })
    )

    // A delete waits on its backup's create. The Relay holds a create under
    // that create's ID, but of another game server: Hearth's never arrived.
    const seedDeleteWaiting = Effect.gen(function* () {
      yield* resetDatabase
      yield* insertRelay(relayId, { enabled: 1 })
      yield* insertBackup(first.backupId, {
        relay_id: relayId,
        status: "deleting",
      })
      yield* insertRows("backup_artifact", {
        id: first.artifactId,
        backup_id: first.backupId,
        destination_key: "local",
        status: "queued",
        created_at: at,
        updated_at: at,
      })
      yield* insertRows("backup_task", {
        id: first.taskId,
        backup_id: first.backupId,
        task_kind: "create",
        status: "queued",
        created_at: at,
        updated_at: at,
      })
      yield* insertRows("backup_task", {
        id: deleteTaskId,
        backup_id: first.backupId,
        task_kind: "delete",
        status: "queued",
        depends_on_task_id: first.taskId,
        created_at: at + 1,
        updated_at: at + 1,
      })
      const listed = createTask(first, "queued")
      const held = {
        ...listed,
        input: {
          ...listed.input,
          target: { id: "d".repeat(12), kind: "instance" },
        },
      }
      // The Relay, holding that create: it cancels only what Hearth names
      // as it holds it, and takes the delete it is sent.
      relay.answer = (operation, payload) => {
        if (operation === "backup.task.list") {
          return relayBackupTaskPage([held], payload)
        }
        if (operation === "backup.task.cancel") {
          const asked = payload as {
            backupId: string
            target: { id: string; kind: string }
          }
          if (
            asked.backupId === held.backupId &&
            asked.target.id === held.input.target.id
          ) {
            held.status = "cancelled"
          }
          return held
        }
        if (operation === "backup.task.enqueue") {
          const input = payload as { taskId: string }
          return {
            ...createTask(first, "queued", "delete"),
            taskId: input.taskId,
            input: {
              ...createTask(first, "queued", "delete").input,
              taskId: input.taskId,
            },
          }
        }
        throw new Error(`Unexpected Relay request ${operation}`)
      }
      return { held, persisted: (yield* Effect.promise(listPersistedRelays))[0]! }
    })

    for (const [path, run] of [
      [
        "a pass",
        (persisted: Parameters<typeof reconcileRelayBackups>[0]) =>
          reconcileRelayBackups(persisted),
      ],
      [
        "the person deleting it",
        (persisted: Parameters<typeof reconcileRelayBackups>[0]) =>
          cancelCreateForDelete(persisted, first.taskId),
      ],
    ] as const) {
      it.effect(
        `lets a delete go whose create the Relay holds for another resource, from ${path}`,
        () =>
          Effect.gen(function* () {
            const { held, persisted } = yield* seedDeleteWaiting

            yield* Effect.promise(() => run(persisted))

            const byId = new Map((yield* tasks).map((task) => [task.id, task]))
            assert.strictEqual(byId.get(first.taskId)?.status, "cancelled")
            // The delete was sent and its Relay answered for it.
            assert.isNotNull(byId.get(deleteTaskId)?.relay_updated_at_ms ?? null)
            // What the Relay holds under the ID is left as it was.
            assert.strictEqual(held.status, "queued")
          })
      )
    }
  })
})
