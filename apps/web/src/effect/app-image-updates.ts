import type { RowDataPacket } from "mysql2/promise"
import type { RelayAppImageCheckResult } from "@workspace/contracts"
import { Clock, Effect } from "effect"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

// Whether each image app's tag names a newer image than the one it runs,
// and what its people asked Kiln to do about it. The Relay compares
// digests; Hearth keeps when it first saw each one, which is how long an
// update has been out, since registries don't say when a tag moved.

/** Off, tell who can deploy the app, or deploy it once it's waited. */
export type AppImageUpdateMode = "auto" | "notify" | "off"

/**
 * What the last check found: the app runs what its tag names (`current`),
 * the tag names another image (`available`), the app runs another image
 * than its config names (`changed`), or Kiln can't tell which digest it
 * runs until it deploys again (`untracked`).
 */
export type AppImageUpdateState =
  | "available"
  | "changed"
  | "current"
  | "not_deployed"
  | "untracked"

export interface AppImageUpdate {
  appId: string
  checkedAt: number | null
  checkError: string | null
  delayHours: number
  /** The image the last check named, as the app's config gave it. */
  image: string | null
  /** The digest the tag names, while it isn't the one running. */
  latestDigest: string | null
  /** When Kiln first saw `latestDigest`; the wait counts from here. */
  latestSeenAt: number | null
  mode: AppImageUpdateMode
  runningDigest: string | null
  /** A digest someone chose not to deploy; it neither notifies nor deploys. */
  skippedDigest: string | null
  state: AppImageUpdateState | null
}

export const defaultAppImageUpdatePolicy = {
  delayHours: 72,
  mode: "notify",
} as const satisfies Pick<AppImageUpdate, "delayHours" | "mode">

interface UpdateRow extends RowDataPacket {
  app_id: string
  check_error: string | null
  checked_at: number | string | null
  delay_hours: number
  image: string | null
  latest_digest: string | null
  latest_seen_at: number | string | null
  mode: AppImageUpdateMode
  running_digest: string | null
  skipped_digest: string | null
  state: AppImageUpdateState | null
}

const updateColumns = `app_id, mode, delay_hours, state, image,
  running_digest, latest_digest, latest_seen_at, skipped_digest, checked_at,
  check_error`

export const loadAppImageUpdatesEffect = Effect.fn("apps.imageUpdates.load")(
  function* (appIds: ReadonlyArray<string>) {
    if (appIds.length === 0) return new Map<string, AppImageUpdate>()
    const database = yield* Database
    const rows = yield* database.queryRows<UpdateRow>(
      "apps.imageUpdates.load",
      `SELECT ${updateColumns}
         FROM ${databaseTable("app_image_update")}
        WHERE app_id IN (${appIds.map(() => "?").join(", ")})`,
      [...appIds]
    )
    return new Map(rows.map((row) => [row.app_id, toUpdate(row)]))
  }
)

export const loadAppImageUpdateEffect = (appId: string) =>
  loadAppImageUpdatesEffect([appId]).pipe(
    Effect.map((updates) => updates.get(appId) ?? null)
  )

/** Sets what Kiln does when the app's tag moves. */
export const saveAppImageUpdatePolicyEffect = Effect.fn(
  "apps.imageUpdates.policy"
)(function* (
  appId: string,
  policy: Pick<AppImageUpdate, "delayHours" | "mode">
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "apps.imageUpdates.policy",
    `INSERT INTO ${databaseTable("app_image_update")}
       (app_id, mode, delay_hours, updated_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       mode = VALUES(mode),
       delay_hours = VALUES(delay_hours),
       updated_at = VALUES(updated_at)`,
    [appId, policy.mode, policy.delayHours, now]
  )
})

/**
 * Passes over the update the app's tag names now, so it neither notifies
 * nor deploys on its own. False if that's no longer the update on offer.
 */
export const skipAppImageUpdateEffect = Effect.fn("apps.imageUpdates.skip")(
  function* (appId: string, digest: string) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const result = yield* database.execute(
      "apps.imageUpdates.skip",
      `UPDATE ${databaseTable("app_image_update")}
          SET skipped_digest = latest_digest, updated_at = ?
        WHERE app_id = ? AND latest_digest = ?`,
      [now, appId, digest]
    )
    return result.affectedRows === 1
  }
)

/**
 * Records what a check of the app found, against what the last one did.
 * `newlySeen` is a digest Kiln hasn't offered before, which restarts the
 * wait: a tag that moves again before an update deploys offers its newest
 * image, never one it has moved past.
 */
export const recordAppImageCheckEffect = Effect.fn("apps.imageUpdates.record")(
  function* (
    appId: string,
    image: string,
    result: Exclude<RelayAppImageCheckResult, { status: "deploying" }>
  ) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    return yield* database.transaction(
      "apps.imageUpdates.record",
      (transaction) =>
        Effect.gen(function* () {
          const [row] = yield* transaction.queryRows<UpdateRow>(
            `SELECT ${updateColumns}
               FROM ${databaseTable("app_image_update")}
              WHERE app_id = ?
                FOR UPDATE`,
            [appId]
          )
          const previous = row ? toUpdate(row) : null
          const next = nextUpdate(previous, appId, image, result, now)
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("app_image_update")}
               (app_id, mode, delay_hours, state, image, running_digest,
                latest_digest, latest_seen_at, skipped_digest, checked_at,
                check_error, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               state = VALUES(state),
               image = VALUES(image),
               running_digest = VALUES(running_digest),
               latest_digest = VALUES(latest_digest),
               latest_seen_at = VALUES(latest_seen_at),
               checked_at = VALUES(checked_at),
               check_error = VALUES(check_error),
               updated_at = VALUES(updated_at)`,
            [
              appId,
              next.mode,
              next.delayHours,
              next.state,
              next.image,
              next.runningDigest,
              next.latestDigest,
              next.latestSeenAt,
              next.skippedDigest,
              next.checkedAt,
              next.checkError?.slice(0, 500) ?? null,
              now,
            ]
          )
          const newlySeen =
            next.state === "available" &&
            (previous?.latestDigest !== next.latestDigest ||
              previous?.image !== next.image)
          const changed =
            newlySeen ||
            previous?.state !== next.state ||
            previous?.checkError !== next.checkError
          return { changed, newlySeen, update: next }
        })
    )
  }
)

function nextUpdate(
  previous: AppImageUpdate | null,
  appId: string,
  image: string,
  result: Exclude<RelayAppImageCheckResult, { status: "deploying" }>,
  now: number
): AppImageUpdate {
  const base: AppImageUpdate = previous ?? {
    ...defaultAppImageUpdatePolicy,
    appId,
    checkedAt: null,
    checkError: null,
    image: null,
    latestDigest: null,
    latestSeenAt: null,
    runningDigest: null,
    skippedDigest: null,
    state: null,
  }
  const checked = { ...base, checkError: null, checkedAt: now, image }
  const cleared = { latestDigest: null, latestSeenAt: null }
  switch (result.status) {
    // Whatever it found before stands, including how long an update has
    // been out, until a check gets through.
    case "error":
      return { ...base, checkError: result.error, checkedAt: now }
    case "changed":
    case "not_deployed":
      return {
        ...checked,
        ...cleared,
        runningDigest: null,
        state: result.status,
      }
    case "checked": {
      const running = result.runningDigests
      if (running.length === 0) {
        return {
          ...checked,
          ...cleared,
          runningDigest: null,
          state: "untracked",
        }
      }
      if (running.includes(result.latestDigest)) {
        return {
          ...checked,
          ...cleared,
          runningDigest: result.latestDigest,
          state: "current",
        }
      }
      const same =
        base.latestDigest === result.latestDigest && base.image === image
      return {
        ...checked,
        latestDigest: result.latestDigest,
        latestSeenAt: same ? base.latestSeenAt : now,
        runningDigest: running[0] ?? null,
        state: "available",
      }
    }
  }
}

/**
 * When an update deploys on its own: once it's been out the app's wait,
 * and the last check got through, so it's still what the tag names.
 */
export function autoUpdateAt(update: AppImageUpdate): number | null {
  if (
    update.mode !== "auto" ||
    update.state !== "available" ||
    update.checkError !== null ||
    update.latestDigest === null ||
    update.latestSeenAt === null ||
    update.latestDigest === update.skippedDigest
  ) {
    return null
  }
  return update.latestSeenAt + update.delayHours * 3_600_000
}

/**
 * Claims `digest` for an image update to deploy, before it's sent to the
 * Relay. False if an update already claimed it, however that went, so an
 * automatic update never deploys the same digest twice. Kept apart from
 * the deployment history, which is pruned.
 */
export const claimImageUpdateEffect = Effect.fn("apps.imageUpdates.claim")(
  function* (appId: string, digest: string) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const result = yield* database.execute(
      "apps.imageUpdates.claim",
      `INSERT IGNORE INTO ${databaseTable("app_image_update_attempt")}
         (app_id, digest, attempted_at)
       VALUES (?, ?, ?)`,
      [appId, digest, now]
    )
    return result.affectedRows === 1
  }
)

function toUpdate(row: UpdateRow): AppImageUpdate {
  const time = (value: number | string | null) =>
    value === null ? null : Number(value)
  return {
    appId: row.app_id,
    checkError: row.check_error,
    checkedAt: time(row.checked_at),
    delayHours: Number(row.delay_hours),
    image: row.image,
    latestDigest: row.latest_digest,
    latestSeenAt: time(row.latest_seen_at),
    mode: row.mode,
    runningDigest: row.running_digest,
    skippedDigest: row.skipped_digest,
    state: row.state,
  }
}
