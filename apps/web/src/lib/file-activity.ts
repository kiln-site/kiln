import { createHash } from "node:crypto"

import {
  relayFileActivitySchema,
  type RelayFileActivity,
} from "@workspace/contracts"
import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect } from "effect"

import { Database } from "@/effect/database"
import { FilePinLimitError } from "@/effect/errors"
import { runAppEffect } from "@/effect/runtime"
import { databaseTable } from "@/lib/database-config"

const recentFileLimit = 12
const pinnedFileLimit = 48

interface FileActivityRow extends RowDataPacket {
  instance_id: string
  path: string
  pinned: boolean | number
  last_viewed_at: number
  last_edited_at: number | null
}

interface PinnedFilePathRow extends RowDataPacket {
  path: string
  path_hash: string
}

function pathHash(path: string): string {
  return createHash("sha256").update(path).digest("hex")
}

function activityFromRows(
  instanceId: string,
  rows: ReadonlyArray<FileActivityRow>
): RelayFileActivity {
  return relayFileActivitySchema.parse({
    instanceId,
    files: rows.map((row) => ({
      instanceId: row.instance_id,
      path: row.path,
      pinned: Boolean(row.pinned),
      lastViewedAt: new Date(row.last_viewed_at).toISOString(),
      lastEditedAt:
        row.last_edited_at === null
          ? null
          : new Date(row.last_edited_at).toISOString(),
    })),
  })
}

export const listFileActivityEffect = Effect.fn("files.activity.list")(
  function* (relayId: string, instanceId: string) {
    const database = yield* Database
    const [pinnedRows, recentRows] = yield* Effect.all(
      [
        database.queryRows<FileActivityRow>(
          "file_activity_pinned",
          `SELECT instance_id, path, pinned, last_viewed_at, last_edited_at
             FROM ${databaseTable("file_activity")}
            WHERE relay_id = ? AND instance_id = ? AND pinned = TRUE
            ORDER BY GREATEST(last_viewed_at, COALESCE(last_edited_at, last_viewed_at)) DESC
            LIMIT ${pinnedFileLimit}`,
          [relayId, instanceId]
        ),
        database.queryRows<FileActivityRow>(
          "file_activity_recent",
          `SELECT instance_id, path, pinned, last_viewed_at, last_edited_at
             FROM ${databaseTable("file_activity")}
            WHERE relay_id = ? AND instance_id = ? AND pinned = FALSE
            ORDER BY GREATEST(last_viewed_at, COALESCE(last_edited_at, last_viewed_at)) DESC
            LIMIT ${recentFileLimit}`,
          [relayId, instanceId]
        ),
      ],
      { concurrency: "unbounded" }
    )
    return activityFromRows(instanceId, [...pinnedRows, ...recentRows])
  }
)

const ensureActivityInstanceEffect = Effect.fn("files.activity.ensureInstance")(
  function* (relayId: string, instanceId: string, now: number) {
    const database = yield* Database
    yield* database.execute(
      "file_activity_ensure_instance",
      `INSERT IGNORE INTO ${databaseTable("instance")}
         (relay_id, instance_id, display_name, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?)`,
      [relayId, instanceId, now, now]
    )
  }
)

const recordFileViewedEffect = Effect.fn("files.activity.recordView")(
  function* (relayId: string, instanceId: string, path: string) {
    const now = yield* Clock.currentTimeMillis
    yield* ensureActivityInstanceEffect(relayId, instanceId, now)
    const database = yield* Database
    yield* database.execute(
      "file_activity_record_view",
      `INSERT INTO ${databaseTable("file_activity")}
         (relay_id, instance_id, path_hash, path, last_viewed_at, created_at,
          updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         path = VALUES(path),
         last_viewed_at = VALUES(last_viewed_at),
         updated_at = VALUES(updated_at)`,
      [relayId, instanceId, pathHash(path), path, now, now, now]
    )
  }
)

const recordFileEditedEffect = Effect.fn("files.activity.recordEdit")(
  function* (relayId: string, instanceId: string, path: string) {
    const now = yield* Clock.currentTimeMillis
    yield* ensureActivityInstanceEffect(relayId, instanceId, now)
    const database = yield* Database
    yield* database.execute(
      "file_activity_record_edit",
      `INSERT INTO ${databaseTable("file_activity")}
         (relay_id, instance_id, path_hash, path, last_viewed_at, last_edited_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         path = VALUES(path),
         last_viewed_at = VALUES(last_viewed_at),
         last_edited_at = VALUES(last_edited_at),
         updated_at = VALUES(updated_at)`,
      [relayId, instanceId, pathHash(path), path, now, now, now, now]
    )
  }
)

const setFilePinnedEffect = Effect.fn("files.activity.setPinned")(function* (
  relayId: string,
  instanceId: string,
  path: string,
  pinned: boolean,
  validPaths: ReadonlySet<string>
) {
  const database = yield* Database
  const hash = pathHash(path)
  const now = yield* Clock.currentTimeMillis
  yield* ensureActivityInstanceEffect(relayId, instanceId, now)
  const updated = yield* database.transaction(
    "file_activity_set_pinned",
    (transaction) =>
      Effect.gen(function* () {
        yield* transaction.queryRows(
          `SELECT instance_id
           FROM ${databaseTable("instance")}
          WHERE relay_id = ? AND instance_id = ?
          FOR UPDATE`,
          [relayId, instanceId]
        )
        if (pinned) {
          const pinnedFiles = yield* transaction.queryRows<PinnedFilePathRow>(
            `SELECT path_hash, path
             FROM ${databaseTable("file_activity")}
            WHERE relay_id = ?
              AND instance_id = ?
              AND pinned = TRUE
            LIMIT ${pinnedFileLimit}`,
            [relayId, instanceId]
          )
          const staleHashes: Array<string> = []
          for (const file of pinnedFiles) {
            if (!validPaths.has(file.path)) staleHashes.push(file.path_hash)
          }
          if (staleHashes.length) {
            yield* transaction.execute(
              `DELETE FROM ${databaseTable("file_activity")}
              WHERE relay_id = ?
                AND instance_id = ?
                AND path_hash IN (${staleHashes.map(() => "?").join(", ")})`,
              [relayId, instanceId, ...staleHashes]
            )
          }
          const activePinCount = pinnedFiles.filter(
            (file) => validPaths.has(file.path) && file.path_hash !== hash
          ).length
          if (activePinCount >= pinnedFileLimit) return false
        }
        yield* transaction.execute(
          `INSERT INTO ${databaseTable("file_activity")}
           (relay_id, instance_id, path_hash, path, pinned, last_viewed_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           path = VALUES(path),
           pinned = VALUES(pinned),
           updated_at = VALUES(updated_at)`,
          [relayId, instanceId, hash, path, pinned, now, now, now]
        )
        return true
      })
  )
  if (!updated) return yield* FilePinLimitError.make({ limit: pinnedFileLimit })
})

export function listFileActivity(
  relayId: string,
  instanceId: string
): Promise<RelayFileActivity> {
  return runAppEffect(
    "files.activity.list",
    listFileActivityEffect(relayId, instanceId)
  )
}

export function recordFileViewed(
  relayId: string,
  instanceId: string,
  path: string
): Promise<void> {
  return runAppEffect(
    "files.activity.recordView",
    recordFileViewedEffect(relayId, instanceId, path)
  )
}

export function recordFileEdited(
  relayId: string,
  instanceId: string,
  path: string
): Promise<void> {
  return runAppEffect(
    "files.activity.recordEdit",
    recordFileEditedEffect(relayId, instanceId, path)
  )
}

export async function setFilePinned(
  relayId: string,
  instanceId: string,
  path: string,
  pinned: boolean,
  validPaths: ReadonlySet<string>
): Promise<RelayFileActivity> {
  await runAppEffect(
    "files.activity.setPinned",
    setFilePinnedEffect(relayId, instanceId, path, pinned, validPaths)
  )
  return listFileActivity(relayId, instanceId)
}
