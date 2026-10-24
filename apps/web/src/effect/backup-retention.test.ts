import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import { expiredScheduledBackupsEffect } from "@/effect/backup-retention"
import { reserveBackupDeleteEffect } from "@/effect/backups"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertBackup,
  insertBackupStorage,
  insertRelay,
  insertRows,
  selectRows,
} from "@/test/seed"

const now = Date.UTC(2026, 5, 1)
const day = 24 * 60 * 60_000
const installationId = "installation-one"

// A schedule backing Kiln up on relay-one, with each action's retention.
const insertKilnSchedule = (
  id: string,
  retentions: ReadonlyArray<{
    bytes: number | null
    days: number | null
  } | null>,
  row: { deleted_at?: number } = {}
) =>
  Effect.gen(function* () {
    yield* insertRows("schedule", {
      id,
      name: id,
      cron_expression: "0 3 * * *",
      timezone: "UTC",
      created_by: "user-one",
      created_at: now,
      updated_at: now,
      ...row,
    })
    yield* insertRows(
      "schedule_action",
      retentions.map((retention, position) => ({
        id: crypto.randomUUID(),
        schedule_id: id,
        position,
        action_type: "backup",
        action_config: JSON.stringify({
          destination: { kind: "local" },
          id: crypto.randomUUID(),
          mode: "full",
          name: "Kiln backup",
          ...(retention ? { retention } : {}),
          type: "backup",
        }),
        created_at: now,
      }))
    )
    yield* insertRows("schedule_target", {
      schedule_id: id,
      relay_id: "relay-one",
      target_kind: "relay",
      target_id: "relay-one",
      target_name: "Kiln",
      created_at: now,
    })
  })

// A scheduled Kiln backup, available on the Relay, made `age` days ago.
const insertKilnBackup = (
  id: string,
  age: number,
  bytes: number,
  row: Record<string, string | number> = {}
) =>
  insertBackup(id, {
    target_kind: "platform",
    target_id: installationId,
    artifact_kind: "platform_bundle",
    reason: "scheduled",
    bytes,
    created_at: now - age * day,
    ...row,
  })

const expired = expiredScheduledBackupsEffect({ installationId, now }).pipe(
  Effect.map((backups) => backups.map((backup) => backup.backupId))
)

describeMysql("scheduled backup retention", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "deletes backups past the days or the size, oldest first, and keeps the newest",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay("relay-one")
          yield* insertKilnSchedule("schedule-one", [
            { bytes: 10_000, days: 30 },
          ])
          yield* insertKilnBackup("newest", 1, 4_000)
          yield* insertKilnBackup("second", 2, 4_000)
          // Past 10,000 bytes together with the two newer ones.
          yield* insertKilnBackup("third", 3, 4_000)
          // Older than 30 days.
          yield* insertKilnBackup("aged", 40, 100)
          // Not the schedule's to delete: made by hand, failed, or another
          // target's.
          yield* insertKilnBackup("manual", 50, 100, { reason: "manual" })
          yield* insertKilnBackup("failed", 50, 100, { status: "failed" })
          yield* insertKilnBackup("other-target", 50, 100, {
            target_id: "installation-two",
          })
          // Copied to S3 as well: deleting it would delete that copy too.
          yield* insertBackupStorage("storage-one")
          yield* insertKilnBackup("copied", 60, 100)
          yield* insertRows("backup_artifact", [
            {
              id: "copied-local",
              backup_id: "copied",
              destination_key: "local",
              storage_id: null,
              status: "available",
              created_at: now,
              updated_at: now,
            },
            {
              id: "copied-s3",
              backup_id: "copied",
              destination_key: "storage-one",
              storage_id: "storage-one",
              status: "available",
              created_at: now,
              updated_at: now,
            },
          ])

          assert.deepStrictEqual(yield* expired, ["aged", "third"])
        })
    )

    it.effect("keeps the newest even when it alone passes the size", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay("relay-one")
        yield* insertKilnSchedule("schedule-one", [
          { bytes: 1_000, days: null },
        ])
        yield* insertKilnBackup("newest", 1, 5_000)
        yield* insertKilnBackup("older", 2, 10)

        assert.deepStrictEqual(yield* expired, ["older"])
      })
    )

    it.effect(
      "ignores a deleted schedule, and keeps what another schedule of the same target keeps",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay("relay-one")
          yield* insertKilnBackup("newest", 1, 100)
          yield* insertKilnBackup("aged", 30, 100)
          yield* insertKilnSchedule("schedule-gone", [{ bytes: 1, days: 1 }], {
            deleted_at: now,
          })
          assert.deepStrictEqual(yield* expired, [])

          yield* insertKilnSchedule("schedule-one", [{ bytes: null, days: 7 }])
          assert.deepStrictEqual(yield* expired, ["aged"])

          // A second schedule of Kiln to the Relay keeps everything.
          yield* insertKilnSchedule("schedule-two", [null])
          assert.deepStrictEqual(yield* expired, [])
        })
    )

    it.effect(
      "won't start deleting a backup copied elsewhere since retention chose it",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay("relay-one")
          yield* insertKilnBackup("chosen", 40, 100)
          yield* insertBackupStorage("storage-one")
          yield* insertRows("backup_artifact", [
            {
              id: "chosen-local",
              backup_id: "chosen",
              destination_key: "local",
              storage_id: null,
              status: "available",
              created_at: now,
              updated_at: now,
            },
            {
              id: "chosen-s3",
              backup_id: "chosen",
              destination_key: "storage-one",
              storage_id: "storage-one",
              status: "available",
              created_at: now,
              updated_at: now,
            },
          ])

          const refused = yield* Effect.flip(
            reserveBackupDeleteEffect({
              backupId: "chosen",
              onlyAt: { storageId: null },
              requestedBy: null,
              taskId: crypto.randomUUID(),
            })
          )
          assert.strictEqual(
            refused._tag === "BackupStorageError" && refused.code,
            "backup_copied"
          )
          const [backup] = yield* selectRows<{ status: string }>("backup")
          assert.strictEqual(backup?.status, "available")
        })
    )
  })
})
