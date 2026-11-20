import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect, Option, Schema } from "effect"

import { Database } from "@/effect/database"
import { runAppEffect } from "@/effect/runtime"
import { databaseTable } from "@/lib/database-config"

// When the Relay hosting Kiln restored it from a platform backup
// (`kiln-relay platform restore`), it tells Hearth so in KILN_RESTORED_AT,
// and Hearth records the restore it has heard, so the first start after
// each restore is told apart from the ones after it.

const restoreSettingId = "00000000-0000-4000-8000-000000000007"
const restoreSettingKey = "platform-restore-heard"

const HeardRestore = Schema.Struct({ restoredAt: Schema.String })
const decodeHeard = Schema.decodeUnknownOption(HeardRestore)
const decodeHeardJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(HeardRestore)
)

/**
 * Whether this is Hearth's first start since Kiln was restored from a
 * backup, and a way to record that it has been heard once what depends on
 * it is done.
 */
export function firstStartAfterRestore(): Promise<{
  readonly heard: () => Promise<void>
  readonly restored: boolean
}> {
  const restoredAt = process.env.KILN_RESTORED_AT?.trim() || null
  const heard = () =>
    restoredAt === null
      ? Promise.resolve()
      : runAppEffect("platform.restore.heard", recordHeard(restoredAt))
  if (restoredAt === null) return Promise.resolve({ heard, restored: false })
  return runAppEffect(
    "platform.restore.read",
    Effect.gen(function* () {
      const database = yield* Database
      const [row] = yield* database.queryRows<
        RowDataPacket & { setting_value: unknown }
      >(
        "platform.restore.read",
        `SELECT setting_value FROM ${databaseTable("setting")}
          WHERE id = ? AND user_id IS NULL AND setting_key = ?
          LIMIT 1`,
        [restoreSettingId, restoreSettingKey]
      )
      const value = row?.setting_value
      const seen = (
        typeof value === "string" ? decodeHeardJson(value) : decodeHeard(value)
      ).pipe(
        Option.map((heardRestore) => heardRestore.restoredAt),
        Option.getOrNull
      )
      return { heard, restored: seen !== restoredAt }
    })
  )
}

const recordHeard = Effect.fnUntraced(function* (restoredAt: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "platform.restore.heard",
    `INSERT INTO ${databaseTable("setting")}
       (id, user_id, setting_key, setting_value, created_at, updated_at)
     VALUES (?, NULL, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
                             updated_at = VALUES(updated_at)`,
    [
      restoreSettingId,
      restoreSettingKey,
      JSON.stringify({ restoredAt } satisfies typeof HeardRestore.Type),
      now,
      now,
    ]
  )
})
