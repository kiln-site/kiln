import type { RowDataPacket } from "mysql2/promise"
import type { RelayInstanceImageCheckResult } from "@workspace/contracts"
import { Clock, Effect } from "effect"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

// Whether each instance's image tag names a newer image than the one it
// runs, and what its people asked Kiln to do about it: an App deployed
// from an image, a database, a game server. The Relay compares digests;
// Hearth keeps when it first saw each one, which is how long an update has
// been out, since registries don't say when a tag moved.

/** The kinds that take updates, as a deployment names its kind. */
export type InstanceUpdateKind = "app" | "database" | "server"

/** Off, tell who can deploy it, or deploy it once it's waited. */
export type InstanceUpdateMode = "auto" | "notify" | "off"

/**
 * What the last check found: it runs what its tag names (`current`), the
 * tag names another image (`available`), it runs another image than the
 * one named (`changed`), or Kiln can't tell which digest it runs until it
 * deploys again (`untracked`).
 */
export type InstanceUpdateState =
  | "available"
  | "changed"
  | "current"
  | "not_deployed"
  | "untracked"

/**
 * What Kiln knows of an instance's Brick: the revision it was installed
 * from, and a newer one its catalog has, while there is one.
 */
export interface InstanceBrickUpdate {
  /** When the check that found this was asked. */
  checkedAt: number | null
  latestRevision: number | null
  /** When Kiln first saw `latestRevision`; the wait counts from here. */
  latestSeenAt: number | null
  revision: number
  /** A revision someone chose not to take. */
  skippedRevision: number | null
  source: string
}

export interface InstanceUpdate {
  /** Null until a check says which Brick it runs, or when it runs none. */
  brick: InstanceBrickUpdate | null
  checkedAt: number | null
  checkError: string | null
  delayHours: number
  /** The image the last check named, by its tag. */
  image: string | null
  instanceId: string
  kind: InstanceUpdateKind
  /** The digest the tag names, while it isn't the one running. */
  latestDigest: string | null
  /** When Kiln first saw `latestDigest`; the wait counts from here. */
  latestSeenAt: number | null
  mode: InstanceUpdateMode
  runningDigest: string | null
  /** A digest someone chose not to deploy; it neither notifies nor deploys. */
  skippedDigest: string | null
  state: InstanceUpdateState | null
}

export const defaultInstanceUpdatePolicy = {
  delayHours: 72,
  mode: "notify",
} as const satisfies Pick<InstanceUpdate, "delayHours" | "mode">

interface UpdateRow extends RowDataPacket {
  brick_checked_at: number | string | null
  brick_revision: number | null
  brick_source: string | null
  latest_revision: number | null
  revision_seen_at: number | string | null
  skipped_revision: number | null
  instance_id: string
  instance_kind: InstanceUpdateKind
  check_error: string | null
  checked_at: number | string | null
  delay_hours: number
  image: string | null
  latest_digest: string | null
  latest_seen_at: number | string | null
  mode: InstanceUpdateMode
  running_digest: string | null
  skipped_digest: string | null
  state: InstanceUpdateState | null
}

const updateColumns = `instance_id, instance_kind, mode, delay_hours, state, image,
  running_digest, latest_digest, latest_seen_at, skipped_digest, checked_at,
  check_error, brick_source, brick_revision, latest_revision, revision_seen_at,
  skipped_revision, brick_checked_at`

/** What Kiln knows of each instance's updates, by its ID. */
export const loadInstanceUpdatesEffect = Effect.fn("instances.updates.load")(
  function* (instanceIds: ReadonlyArray<string>) {
    if (instanceIds.length === 0) return new Map<string, InstanceUpdate>()
    const database = yield* Database
    const rows = yield* database.queryRows<UpdateRow>(
      "instances.updates.load",
      `SELECT ${updateColumns}
         FROM ${databaseTable("instance_update")}
        WHERE instance_id IN (${instanceIds.map(() => "?").join(", ")})`,
      [...instanceIds]
    )
    return new Map(rows.map((row) => [row.instance_id, toUpdate(row)]))
  }
)

export const loadInstanceUpdateEffect = (instanceId: string) =>
  loadInstanceUpdatesEffect([instanceId]).pipe(
    Effect.map((updates) => updates.get(instanceId) ?? null)
  )

/** Sets what Kiln does when the instance's tag moves. */
export const saveInstanceUpdatePolicyEffect = Effect.fn(
  "instances.updates.policy"
)(function* (
  kind: InstanceUpdateKind,
  instanceId: string,
  policy: Pick<InstanceUpdate, "delayHours" | "mode">
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "instances.updates.policy",
    `INSERT INTO ${databaseTable("instance_update")}
       (instance_id, instance_kind, mode, delay_hours, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       mode = VALUES(mode),
       delay_hours = VALUES(delay_hours),
       updated_at = VALUES(updated_at)`,
    [instanceId, kind, policy.mode, policy.delayHours, now]
  )
})

/** Forgets an instance's updates, as when it is deleted. */
export const deleteInstanceUpdatesEffect = Effect.fn(
  "instances.updates.delete"
)(function* (instanceId: string) {
  const database = yield* Database
  yield* database.execute(
    "instances.updates.delete",
    `DELETE FROM ${databaseTable("instance_update")} WHERE instance_id = ?`,
    [instanceId]
  )
  yield* database.execute(
    "instances.updates.attempts.delete",
    `DELETE FROM ${databaseTable("instance_update_attempt")}
      WHERE instance_id = ?`,
    [instanceId]
  )
})

/**
 * Passes over the update the instance's tag names now, so it neither
 * notifies nor deploys on its own. False if that's no longer the update on
 * offer.
 */
export const skipInstanceUpdateEffect = Effect.fn("instances.updates.skip")(
  function* (instanceId: string, digest: string) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const result = yield* database.execute(
      "instances.updates.skip",
      `UPDATE ${databaseTable("instance_update")}
          SET skipped_digest = latest_digest, updated_at = ?
        WHERE instance_id = ? AND latest_digest = ?`,
      [now, instanceId, digest]
    )
    return result.affectedRows === 1
  }
)

/**
 * Records what a check of the instance found, against what the last one did.
 * `newlySeen` is a digest Kiln hasn't offered before, which restarts the
 * wait: a tag that moves again before an update deploys offers its newest
 * image, never one it has moved past.
 */
export const recordInstanceImageCheckEffect = Effect.fn(
  "instances.updates.record"
)(
  function* (
    kind: InstanceUpdateKind,
    instanceId: string,
    /** The image it names, or null to keep the one last recorded. */
    image: string | null,
    result: Exclude<RelayInstanceImageCheckResult, { status: "deploying" }>,
    askedAt: number
  ) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    return yield* database.transaction(
      "instances.updates.record",
      (transaction) =>
        Effect.gen(function* () {
          const [row] = yield* transaction.queryRows<UpdateRow>(
            `SELECT ${updateColumns}
               FROM ${databaseTable("instance_update")}
              WHERE instance_id = ?
                FOR UPDATE`,
            [instanceId]
          )
          const previous = row ? toUpdate(row) : null
          // One asked before what's recorded, answering later, says less
          // than it: kept out, its effects with it.
          if (previous?.checkedAt != null && askedAt < previous.checkedAt) {
            return {
              changed: false,
              newFailure: false,
              newlySeen: false,
              update: previous,
            }
          }
          // Checked when it was asked, which is what what it found
          // describes; a deployment since makes it stale.
          const next = nextUpdate(
            previous,
            kind,
            instanceId,
            image,
            result,
            askedAt
          )
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("instance_update")}
               (instance_id, instance_kind, mode, delay_hours, state, image,
                running_digest, latest_digest, latest_seen_at, skipped_digest,
                checked_at, check_error, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
              instanceId,
              kind,
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
          // A registry that keeps failing fails every check: only a new
          // failure is worth reporting.
          const newFailure =
            next.checkError !== null && previous?.checkError !== next.checkError
          return { changed, newFailure, newlySeen, update: next }
        })
    )
  }
)

function nextUpdate(
  previous: InstanceUpdate | null,
  kind: InstanceUpdateKind,
  instanceId: string,
  named: string | null,
  result: Exclude<RelayInstanceImageCheckResult, { status: "deploying" }>,
  now: number
): InstanceUpdate {
  const base: InstanceUpdate = previous ?? {
    ...defaultInstanceUpdatePolicy,
    brick: null,
    checkedAt: null,
    checkError: null,
    image: null,
    instanceId,
    kind,
    latestDigest: null,
    latestSeenAt: null,
    runningDigest: null,
    skippedDigest: null,
    state: null,
  }
  const image = named ?? base.image
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
    // A digest never moves, so there is never an update to offer.
    case "pinned":
      return { ...checked, ...cleared, runningDigest: null, state: "current" }
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
 * What a check found, if it still describes the instance: it asked about
 * the image it names now, and no deployment has started since it asked,
 * which may have changed what runs. Checks take no lock, so what one
 * recorded is judged here, where it's used, rather than kept from being
 * recorded.
 */
export function currentImageUpdate(
  update: InstanceUpdate | null,
  image: string | null,
  latestDeploymentStartedAt: string | null
): InstanceUpdate | null {
  return update && describesInstance(update, image, latestDeploymentStartedAt)
    ? update
    : null
}

/**
 * Whether a check's record still describes the instance, as above. A kind
 * whose image Hearth doesn't keep passes none, and is judged by its
 * deployments alone.
 */
export function describesInstance(
  checked: { readonly checkedAt: number | null; readonly image: string | null },
  image: string | null,
  latestDeploymentStartedAt: string | null
): boolean {
  return (
    (image === null || checked.image === image) &&
    !(
      latestDeploymentStartedAt !== null &&
      checked.checkedAt !== null &&
      Date.parse(latestDeploymentStartedAt) >= checked.checkedAt
    )
  )
}

/**
 * When an update deploys on its own: once it's been out the app's wait,
 * and the last check got through, so it's still what the tag names.
 */
export function autoUpdateAt(update: InstanceUpdate): number | null {
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
 * Records which revision of its Brick an instance runs, and the newer one
 * its catalog has (`catalogRevision`, null when the catalog no longer has
 * the Brick). `newlySeen` is a revision Kiln hasn't offered before, which
 * starts its wait. Checks overlap: one asked before what is already
 * recorded says less than it, and is kept out (`stale`), decided with the
 * row held so two recording at once agree.
 */
export const recordInstanceBrickCheckEffect = Effect.fn(
  "instances.updates.recordBrick"
)(function* (
  kind: InstanceUpdateKind,
  instanceId: string,
  installed: { revision: number; source: string },
  catalogRevision: number | null,
  askedAt: number
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  return yield* database.transaction(
    "instances.updates.recordBrick",
    (transaction) =>
      Effect.gen(function* () {
        const [row] = yield* transaction.queryRows<UpdateRow>(
          `SELECT ${updateColumns}
             FROM ${databaseTable("instance_update")}
            WHERE instance_id = ?
              FOR UPDATE`,
          [instanceId]
        )
        const previous = row ? toUpdate(row).brick : null
        if (previous?.checkedAt != null && askedAt < previous.checkedAt) {
          return {
            brick: previous,
            changed: false,
            newlySeen: false,
            stale: true,
          }
        }
        const latestRevision =
          catalogRevision !== null && catalogRevision > installed.revision
            ? catalogRevision
            : null
        const same =
          previous !== null &&
          previous.source === installed.source &&
          previous.latestRevision === latestRevision
        const brick: InstanceBrickUpdate = {
          checkedAt: askedAt,
          latestRevision,
          latestSeenAt:
            latestRevision === null
              ? null
              : same
                ? previous.latestSeenAt
                : now,
          revision: installed.revision,
          // What was passed over stays passed over, for the same Brick.
          skippedRevision:
            previous?.source === installed.source
              ? previous.skippedRevision
              : null,
          source: installed.source,
        }
        yield* transaction.execute(
          `INSERT INTO ${databaseTable("instance_update")}
             (instance_id, instance_kind, mode, delay_hours, brick_source,
              brick_revision, latest_revision, revision_seen_at,
              skipped_revision, brick_checked_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             brick_checked_at = VALUES(brick_checked_at),
             brick_source = VALUES(brick_source),
             brick_revision = VALUES(brick_revision),
             latest_revision = VALUES(latest_revision),
             revision_seen_at = VALUES(revision_seen_at),
             skipped_revision = VALUES(skipped_revision),
             updated_at = VALUES(updated_at)`,
          [
            instanceId,
            kind,
            defaultInstanceUpdatePolicy.mode,
            defaultInstanceUpdatePolicy.delayHours,
            brick.source.slice(0, 2_048),
            brick.revision,
            brick.latestRevision,
            brick.latestSeenAt,
            brick.skippedRevision,
            brick.checkedAt,
            now,
          ]
        )
        return {
          brick,
          changed: !same || previous.revision !== installed.revision,
          newlySeen: latestRevision !== null && !same,
          stale: false,
        }
      })
  )
})

/**
 * Passes over the Brick revision on offer, so it neither notifies nor
 * installs on its own. False if that's no longer the one on offer.
 */
export const skipInstanceBrickUpdateEffect = Effect.fn(
  "instances.updates.skipBrick"
)(function* (instanceId: string, revision: number) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const result = yield* database.execute(
    "instances.updates.skipBrick",
    `UPDATE ${databaseTable("instance_update")}
        SET skipped_revision = latest_revision, updated_at = ?
      WHERE instance_id = ? AND latest_revision = ?`,
    [now, instanceId, revision]
  )
  return result.affectedRows === 1
})

/**
 * What a check found of an instance's Brick, if it still describes the
 * instance: no deployment has started since it was asked, which may have
 * changed the Brick it runs, as a change of Brick does.
 */
export function currentBrickUpdate(
  update: InstanceUpdate | null,
  latestDeploymentStartedAt: string | null
): InstanceBrickUpdate | null {
  const brick = update?.brick ?? null
  return brick &&
    !(
      latestDeploymentStartedAt !== null &&
      brick.checkedAt !== null &&
      Date.parse(latestDeploymentStartedAt) >= brick.checkedAt
    )
    ? brick
    : null
}

/** The Brick revision on offer: newer than what runs, and not passed over. */
export function offeredBrickRevision(update: InstanceUpdate): number | null {
  const brick = update.brick
  return update.mode !== "off" &&
    brick !== null &&
    brick.latestRevision !== null &&
    brick.latestRevision !== brick.skippedRevision
    ? brick.latestRevision
    : null
}

/** When a Brick revision installs on its own: once it has waited. */
export function autoBrickUpdateAt(update: InstanceUpdate): number | null {
  if (
    update.mode !== "auto" ||
    offeredBrickRevision(update) === null ||
    update.brick?.latestSeenAt == null
  ) {
    return null
  }
  return update.brick.latestSeenAt + update.delayHours * 3_600_000
}

/**
 * Claims `digest` for the image update `deploymentId` deploys, before it's
 * sent to the Relay. False if another update already claimed it, however
 * that went, so an automatic update never deploys the same digest twice;
 * the same deployment claiming again, as when its step runs again after a
 * restart, still has it. Kept apart from the deployment history, which is
 * pruned.
 */
export const claimImageUpdateEffect = Effect.fn("instances.updates.claim")(
  function* (instanceId: string, digest: string, deploymentId: string) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "instances.updates.claim",
      `INSERT IGNORE INTO ${databaseTable("instance_update_attempt")}
         (instance_id, digest, attempted_at, deployment_id)
       VALUES (?, ?, ?, ?)`,
      [instanceId, digest, now, deploymentId]
    )
    const [claim] = yield* database.queryRows<
      RowDataPacket & { deployment_id: string | null }
    >(
      "instances.updates.claim",
      `SELECT deployment_id FROM ${databaseTable("instance_update_attempt")}
        WHERE instance_id = ? AND digest = ?`,
      [instanceId, digest]
    )
    return claim?.deployment_id === deploymentId
  }
)

function toUpdate(row: UpdateRow): InstanceUpdate {
  const time = (value: number | string | null) =>
    value === null ? null : Number(value)
  return {
    brick:
      row.brick_source === null || row.brick_revision === null
        ? null
        : {
            checkedAt: time(row.brick_checked_at),
            latestRevision:
              row.latest_revision === null ? null : Number(row.latest_revision),
            latestSeenAt: time(row.revision_seen_at),
            revision: Number(row.brick_revision),
            skippedRevision:
              row.skipped_revision === null
                ? null
                : Number(row.skipped_revision),
            source: row.brick_source,
          },
    checkError: row.check_error,
    checkedAt: time(row.checked_at),
    delayHours: Number(row.delay_hours),
    image: row.image,
    instanceId: row.instance_id,
    kind: row.instance_kind,
    latestDigest: row.latest_digest,
    latestSeenAt: time(row.latest_seen_at),
    mode: row.mode,
    runningDigest: row.running_digest,
    skippedDigest: row.skipped_digest,
    state: row.state,
  }
}
