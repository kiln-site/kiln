import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import { expiredBackupsEffect } from "@/effect/backup-retention"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertBackup, insertRows } from "@/test/seed"

const now = Date.UTC(2026, 5, 1)
const day = 24 * 60 * 60_000

const insertPolicy = (row: Record<string, number | string | null>) =>
  insertRows("backup_policy", {
    relay_id: "relay-one",
    target_kind: "instance",
    target_id: "instance-one",
    exclude_patterns: "[]",
    created_at: now,
    updated_at: now,
    ...row,
  })

// A backup of instance-one, made `age` days ago.
const insertAged = (
  id: string,
  age: number,
  bytes: number,
  row: Record<string, string | number> = {}
) => insertBackup(id, { bytes, created_at: now - age * day, ...row })

const expired = expiredBackupsEffect(now).pipe(
  Effect.map((backups) => backups.map((backup) => backup.backupId))
)

describeMysql("backup retention", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "deletes the oldest backups past a target's number, space, or age, and keeps the newest",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertPolicy({
            quantity_limit: 3,
            retention_days: 30,
            size_limit_bytes: 10_000,
          })
          yield* insertAged("newest", 1, 4_000)
          yield* insertAged("second", 2, 4_000)
          yield* insertAged("third", 3, 1_000)
          // The fourth newest, past the three kept.
          yield* insertAged("fourth", 4, 100)
          // Older than 30 days.
          yield* insertAged("aged", 40, 100)
          // Never retention's: a deleted server's last backup, a failed
          // one, and another target's.
          yield* insertAged("final", 50, 100, { reason: "final_delete" })
          yield* insertAged("failed", 50, 100, { status: "failed" })
          yield* insertAged("other", 50, 100, { target_id: "instance-two" })

          assert.deepStrictEqual(yield* expired, ["aged", "fourth"])
        })
    )

    it.effect(
      "takes the lower of the owner's limit and the platform ceiling, and keeps the newest past both",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertPolicy({
            admin_size_limit_bytes: 1_000,
            size_limit_bytes: 5_000,
          })
          yield* insertAged("newest", 1, 3_000)
          yield* insertAged("older", 2, 10)

          assert.deepStrictEqual(yield* expired, ["older"])
        })
    )

    it.effect("keeps every backup of a target without retention", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertPolicy({})
        yield* insertAged("newest", 1, 100)
        yield* insertAged("ancient", 4_000, 100)

        assert.deepStrictEqual(yield* expired, [])
      })
    )
  })
})
