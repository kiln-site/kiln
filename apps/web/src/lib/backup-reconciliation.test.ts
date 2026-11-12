import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import { reconcileRelayBackups } from "@/lib/backup-reconciliation"
import { listPersistedRelays } from "@/lib/relay-registry"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, selectRows } from "@/test/seed"

const relayId = "1".repeat(12)
const appId = "a".repeat(12)
const batchId = "22222222-2222-4222-8222-222222222222"
const at = Date.UTC(2026, 10, 1)
const id = (member: number, part: number) =>
  `0000000${member}-0000-4000-8000-00000000000${part}`

// A schedule's backup of an App that uses six volumes, queued on the Relay
// as one batch, which Hearth was never told of as each was made.
const members = Array.from({ length: 6 }, (_, member) => {
  const backupId = id(member, 1)
  const taskId = id(member, 2)
  return {
    backupId,
    bytesCompleted: 0,
    bytesTotal: null,
    createdAt: at,
    currentArtifactId: null,
    currentPath: null,
    error: null,
    errorCode: null,
    finishedAt: null,
    input: {
      appCoverage: [{ appId, volumeIds: [] }],
      artifactKind: "tar_archive",
      backupId,
      batch: { id: batchId, size: 6 },
      catalog: { batchId, name: "Nightly", storageId: null },
      destination: { artifactId: id(member, 3), kind: "local" },
      exclude: [],
      kind: "create",
      maxBytes: null,
      mode: "full",
      reason: "scheduled",
      target: { id: String(member + 1).repeat(40), kind: "volume" },
      taskId,
    },
    inputRefreshRequired: false,
    kind: "create",
    phase: null,
    result: null,
    startedAt: null,
    status: "queued",
    taskId,
    updatedAt: at,
  }
})

// The Relay is the only boundary: it lists the backups it holds.
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (_relay: unknown, operation: string) => {
    if (operation === "backup.task.list") return members
    throw new Error(`Unexpected Relay request ${operation}`)
  },
}))
vi.mock("@/lib/realtime-source.server", () => ({
  publishRealtimeChange: () => undefined,
}))

afterAll(() => disposeAppRuntime())

describeMysql("Reconciling a Relay's backups", () => {
  layer(TestDatabase)((it) => {
    // Cataloged side by side, each locks where its rows will go, and MySQL
    // ends one of two that wait on each other. Unless that one runs again,
    // the whole pass fails, every time, and none is ever cataloged.
    it.effect(
      "catalogs every backup of a batch Hearth hadn't heard of, though they are cataloged together",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay(relayId, { enabled: 1 })
          const [relay] = yield* Effect.promise(listPersistedRelays)

          yield* Effect.promise(() => reconcileRelayBackups(relay!))

          const backups = yield* selectRows<{
            batch_id: string | null
            reason: string
          }>("backup")
          assert.lengthOf(backups, members.length)
          assert.isTrue(
            backups.every(
              (backup) =>
                backup.batch_id === batchId && backup.reason === "scheduled"
            )
          )
        })
    )
  })
})
