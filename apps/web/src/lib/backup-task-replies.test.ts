import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import { cancelCreateForDelete } from "@/lib/backup-reconciliation"
import { listPersistedRelays } from "@/lib/relay-registry"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertBackup, insertRelay, insertRows, selectRows } from "@/test/seed"

// Hearth applies a Relay's answer about a task only to the task it asked
// about: one about another of the Relay's tasks would reach a record Hearth
// never asked about.

const relayId = "1".repeat(12)
const at = Date.UTC(2026, 10, 1)
const asked = {
  backupId: "11111111-1111-4111-8111-111111111111",
  taskId: "11111111-1111-4111-8111-1111111111c1",
}
const other = {
  backupId: "22222222-2222-4222-8222-222222222222",
  taskId: "22222222-2222-4222-8222-2222222222c2",
}

vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (_relay: unknown, operation: string) => {
    // Asked to cancel one create, the Relay answers with another, cancelled.
    if (operation === "backup.task.cancel") {
      return {
        backupId: other.backupId,
        bytesCompleted: 0,
        bytesTotal: null,
        createdAt: at,
        error: "Cancelled",
        finishedAt: at + 1,
        input: {
          artifactKind: "archive",
          backupId: other.backupId,
          destination: { kind: "local" },
          exclude: [],
          kind: "create",
          maxBytes: null,
          mode: "full",
          reason: "manual",
          target: { id: "instance-one", kind: "instance" },
          taskId: other.taskId,
        },
        inputRefreshRequired: false,
        kind: "create",
        result: null,
        startedAt: at,
        status: "cancelled",
        taskId: other.taskId,
        updatedAt: at + 1,
      }
    }
    if (operation === "backup.task.list") return []
    throw new Error(`Unexpected Relay request ${operation}`)
  },
}))
vi.mock("@/lib/realtime-source.server", () => ({
  publishRealtimeChange: () => undefined,
}))

afterAll(() => disposeAppRuntime())

describeMysql("A Relay's answer about a backup task", () => {
  layer(TestDatabase)((it) => {
    it.effect("is applied only to the task Hearth asked about", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay(relayId, { enabled: 1 })
        for (const backup of [asked, other]) {
          yield* insertBackup(backup.backupId, {
            relay_id: relayId,
            status: "running",
          })
          yield* insertRows("backup_task", {
            id: backup.taskId,
            backup_id: backup.backupId,
            task_kind: "create",
            status: "running",
            created_at: at,
            updated_at: at,
          })
        }
        const [relay] = yield* Effect.promise(listPersistedRelays)

        const outcome = yield* Effect.promise(() =>
          cancelCreateForDelete(relay!, asked.taskId).then(
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
  })
})
