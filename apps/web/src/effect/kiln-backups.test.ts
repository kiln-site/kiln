import { assert, layer } from "@effect/vitest"
import { Clock, Effect } from "effect"
import { TestClock } from "effect/testing"

import { warnOfOverdueKilnBackups } from "@/effect/kiln-backups"
import { kilnBackupOverdueMs } from "@/lib/recovery-code"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertBackup,
  insertBackupStorage,
  insertRelay,
  insertRows,
  insertUser,
  selectRows,
} from "@/test/seed"

const backupId = "00000000-0000-4000-8000-000000000001"
const storageId = "0000000000b1"

// A Kiln set up `age` ago, with a bucket.
const kiln = (age: number) =>
  Effect.gen(function* () {
    yield* resetDatabase
    yield* TestClock.setTime(Date.parse("2026-11-24T12:00:00.000Z"))
    const now = yield* Clock.currentTimeMillis
    yield* insertUser("admin", {
      createdAt: new Date(now - age),
      role: "admin",
    })
    yield* insertRelay("relay-one")
    yield* insertBackupStorage(storageId)
  })

const backedUp = (ago: number, row: { recoverable?: number } = {}) =>
  Effect.gen(function* () {
    const at = (yield* Clock.currentTimeMillis) - ago
    yield* insertBackup(backupId, {
      artifact_kind: "platform_bundle",
      completed_at: at,
      recoverable: 1,
      target_id: "kiln-test",
      target_kind: "platform",
      ...row,
    })
    yield* insertRows("backup_artifact", {
      id: "00000000-0000-4000-8000-0000000000a1",
      backup_id: backupId,
      destination_key: storageId,
      storage_id: storageId,
      status: "available",
      created_at: at,
      updated_at: at,
    })
  })

const open = Effect.map(
  Effect.suspend(() =>
    selectRows<{ dismissed_at: unknown; kind: string }>("notification")
  ),
  (rows) =>
    rows.flatMap(({ dismissed_at, kind }) =>
      dismissed_at === null ? [kind] : []
    )
)

describeMysql("Kiln's backups off its machine", () => {
  layer(TestDatabase)((it) => {
    it.effect("are missed once overdue, and no longer once there's one", () =>
      Effect.gen(function* () {
        yield* kiln(kilnBackupOverdueMs * 2)
        yield* warnOfOverdueKilnBackups()
        // Said once, however often it looks.
        yield* warnOfOverdueKilnBackups()
        assert.deepStrictEqual(yield* open, ["kiln.backup-overdue"])

        yield* backedUp(60_000)
        yield* warnOfOverdueKilnBackups()
        assert.deepStrictEqual(yield* open, [])
      })
    )

    it.effect("are missed when the last is old, or restores nowhere else", () =>
      Effect.gen(function* () {
        yield* kiln(kilnBackupOverdueMs * 2)
        yield* backedUp(kilnBackupOverdueMs + 60_000)
        yield* warnOfOverdueKilnBackups()
        assert.deepStrictEqual(yield* open, ["kiln.backup-overdue"])

        yield* kiln(kilnBackupOverdueMs * 2)
        yield* backedUp(60_000, { recoverable: 0 })
        yield* warnOfOverdueKilnBackups()
        assert.deepStrictEqual(yield* open, ["kiln.backup-overdue"])
      })
    )

    it.effect("aren't missed while Kiln is new", () =>
      Effect.gen(function* () {
        yield* kiln(60_000)
        yield* warnOfOverdueKilnBackups()
        assert.deepStrictEqual(yield* open, [])
      })
    )
  })
})
