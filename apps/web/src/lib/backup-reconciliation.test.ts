import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import { reconcileRelayBackups } from "@/lib/backup-reconciliation"
import { listPersistedRelays } from "@/lib/relay-registry"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, selectRows } from "@/test/seed"
import { relayBackupTaskPage } from "@/test/relay-backup-tasks"

const relayId = "1".repeat(12)
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
      artifactKind: "tar_archive",
      backupId,
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

// The Relay is the only boundary: it lists the backups it holds, as each
// test says.
const relay = vi.hoisted(() => ({
  list: null as null | ((payload: unknown, relayId: string) => unknown),
}))
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (
    asking: { id: string },
    operation: string,
    payload: unknown
  ) => {
    if (operation === "backup.task.list") {
      return relay.list
        ? relay.list(payload, asking.id)
        : relayBackupTaskPage(members, payload)
    }
    throw new Error(`Unexpected Relay request ${operation}`)
  },
}))

// A schedule's backup of one volume the Relay made on its own, which failed
// there, changed last at `updatedAt` by the Relay's clock.
const scheduled = (index: number, updatedAt: number) => {
  const part = String(index).padStart(4, "0")
  const backupId = `${part}0000-0000-4000-8000-000000000001`
  const taskId = `${part}0000-0000-4000-8000-000000000002`
  return {
    ...members[0]!,
    backupId,
    input: {
      ...members[0]!.input,
      backupId,
      catalog: { name: "Nightly", storageId: null },
      destination: {
        artifactId: `${part}0000-0000-4000-8000-000000000003`,
        kind: "local",
      },
      target: { id: part.repeat(10), kind: "volume" },
      taskId,
    },
    error: "The volume couldn't be read",
    finishedAt: updatedAt,
    status: "failed",
    taskId,
    updatedAt,
  }
}

// The Relay the paging tests read: passes over another, as ones an earlier
// test left running, aren't counted.
const pagedRelayId = "3".repeat(12)

// A Relay holding `journal`, answering a page of `size` tasks at a time from
// where Hearth asks, as a Relay does; `asked` keeps where each request began.
const pagingRelay = (
  journal: Array<ReturnType<typeof scheduled>>,
  size: number,
  asked: Array<{ taskId: string; updatedAt: number } | undefined>,
  failOn?: number
) => {
  let requests = 0
  return (payload: unknown, relayId: string) => {
    if (relayId !== pagedRelayId)
      return { changed: [], current: [], next: null }
    requests += 1
    if (requests === failOn) throw new Error("The Relay stopped answering")
    const after = (payload as { after?: { taskId: string; updatedAt: number } })
      .after
    asked.push(after)
    const ordered = [...journal].sort(
      (a, b) => a.updatedAt - b.updatedAt || a.taskId.localeCompare(b.taskId)
    )
    const changed = ordered.filter(
      (task) =>
        !after ||
        task.updatedAt > after.updatedAt ||
        (task.updatedAt === after.updatedAt && task.taskId > after.taskId)
    )
    const page = changed.slice(0, size)
    const last = page.at(-1)
    const askedIds = new Set(
      (payload as { taskIds?: Array<string> }).taskIds ?? []
    )
    return {
      changed: page,
      // Every page carries what's unfinished and what Hearth asks after.
      current: journal.filter(
        (task) =>
          task.status === "queued" ||
          task.status === "running" ||
          askedIds.has(task.taskId)
      ),
      next:
        changed.length > size && last
          ? { taskId: last.taskId, updatedAt: last.updatedAt }
          : null,
    }
  }
}

const readAt = Effect.map(
  selectRows<{ backup_tasks_read_at: number | string | null }>("relay"),
  ([row]) =>
    row?.backup_tasks_read_at === null ||
    row?.backup_tasks_read_at === undefined
      ? null
      : Number(row.backup_tasks_read_at)
)
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
          relay.list = null
          yield* insertRelay(relayId, { enabled: 1 })
          const [persisted] = yield* Effect.promise(listPersistedRelays)

          yield* Effect.promise(() => reconcileRelayBackups(persisted!))

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

    it.effect(
      "reads a Relay's journal a page at a time, and the next pass from where it left off",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay(pagedRelayId, { enabled: 1 })
          const [persisted] = yield* Effect.promise(listPersistedRelays)
          const journal = Array.from({ length: 12 }, (_, index) =>
            scheduled(index + 1, at + index * 1_000)
          )
          const asked: Array<
            { taskId: string; updatedAt: number } | undefined
          > = []
          relay.list = pagingRelay(journal, 5, asked)

          yield* Effect.promise(() => reconcileRelayBackups(persisted!))

          assert.lengthOf(yield* selectRows("backup"), 12)
          assert.lengthOf(asked, 3)
          assert.isUndefined(asked[0])
          assert.strictEqual(yield* readAt, at + 11_000)

          // Made later; the next pass starts a minute before where it left
          // off, and finds it.
          journal.push(scheduled(13, at + 200_000))
          asked.length = 0
          yield* Effect.promise(() => reconcileRelayBackups(persisted!))

          assert.lengthOf(yield* selectRows("backup"), 13)
          assert.deepStrictEqual(asked[0], {
            taskId: "",
            updatedAt: at + 11_000 - 60_000,
          })
          assert.strictEqual(yield* readAt, at + 200_000)
        })
    )

    it.effect(
      "starts again after the last page it applied when a page fails",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay(pagedRelayId, { enabled: 1 })
          const [persisted] = yield* Effect.promise(listPersistedRelays)
          const journal = Array.from({ length: 12 }, (_, index) =>
            scheduled(index + 1, at + index * 100_000)
          )
          const asked: Array<
            { taskId: string; updatedAt: number } | undefined
          > = []
          relay.list = pagingRelay(journal, 5, asked, 2)

          const failed = yield* Effect.promise(() =>
            reconcileRelayBackups(persisted!).then(
              () => false,
              () => true
            )
          )

          // The first page is applied; what Hearth has read stops there.
          assert.isTrue(failed)
          assert.lengthOf(yield* selectRows("backup"), 5)
          assert.strictEqual(yield* readAt, at + 400_000)

          relay.list = pagingRelay(journal, 5, asked)
          yield* Effect.promise(() => reconcileRelayBackups(persisted!))

          assert.lengthOf(yield* selectRows("backup"), 12)
        })
    )
  })
})
