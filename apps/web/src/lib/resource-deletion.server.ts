import { randomUUID } from "node:crypto"

import {
  relayControlDeadlineMs,
  relaySnapshotSchema,
  relayVolumesSchema,
} from "@workspace/contracts"
import { Cause, Duration, Effect, Schema } from "effect"
import { Activity, DurableClock } from "effect/workflow"
import { z } from "zod"

import {
  purgeInstanceBackupRepositoriesEffect,
  reserveDatabaseBackupEffect,
  reserveInstanceBackupEffect,
  reserveResourceBackupEffect,
} from "@/effect/backups"
import { promiseEffect } from "@/effect/promise"
import {
  finalBackupStateEffect,
  findResourceDeletionEffect,
  listResourceDeletionsToReconcileEffect,
  loadResourceDeletionEffect,
  recordRelayDeletedEffect,
  recordRelayDeletingEffect,
  recordResourceDeletionStatusEffect,
  requestResourceDeletionRowEffect,
  requestResourceKeepRowEffect,
  unfinishedDeletionStatuses,
  type ResourceDeletion,
  type ResourceDeletionKind,
  type ResourceDeletionStatus,
} from "@/effect/resource-deletions"
import { runAppEffect } from "@/effect/runtime"
import { requireRelayPermissionsEffect } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { timestampedBackupName } from "@/lib/backup-name"
import { publishBackupChange } from "@/lib/backup-realtime.server"
import { resolveAuthorizedBackupStorageSelection } from "@/lib/backup-storage-selection.server"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { relayRpc } from "@/lib/relay-connection"
import { activeRelay } from "@/lib/relay-registry"
import { currentActingUser } from "@/operations/acting-user"
import { durableOperation, startDurableOperation } from "@/operations/durable"
import { RelayCommandError, relayCommand } from "@/operations/relay-command"
import { requireBackupTargetPermission } from "@/server/backup-target-access.server"
import { cleanUpDeletedResourceEffect } from "@/server/resource-deletion-cleanup"
import { deliverPendingSchedules } from "@/server/schedule-deployment.server"

// Deleting a game server, database, App, or Kiln volume, as one durable
// operation per attempt (docs/resource-unification.md, Deletion): check the
// person who asked may still delete it, freeze it on its Relay, take its
// final backup if one was asked for, delete it on the Relay, then clean up
// after it in Hearth. Each
// step is safe to run again after a restart, and a finished one doesn't run
// again. Its row (`resource_deletion`) says how far it got; a failure stops
// there with the resource still frozen, for its person to try again, delete
// it without a final backup, or keep it. Once the Relay has deleted it,
// cleanup always finishes, as system work, whoever asked.
//
// Keeping a resource after its deletion failed is an operation of its own,
// `resource.delete.cancel`: it lets the resource go on its Relay, then
// records it kept. Each attempt at either is recorded on the row before its
// operation starts, and every write an operation makes names its attempt and
// the statuses it may move from, so an attempt that's been replaced changes
// nothing. A reconciler starts any attempt whose operation is missing.
//
// A final backup is taken as steps of this operation, never as an operation
// of its own: an App's folder, then each of its volumes, one after another.

/** A step of a deletion that stopped it, with what to tell its person. */
export class ResourceDeletionError extends Schema.TaggedError<ResourceDeletionError>()(
  "ResourceDeletionError",
  { message: Schema.String }
) {}

const DeletionInput = Schema.Struct({
  attempt: Schema.Number,
  deletionId: Schema.String,
  kind: Schema.Literals(["instance", "database", "app", "volume"]),
  relayId: Schema.String,
  resourceId: Schema.String,
})
type DeletionInput = typeof DeletionInput.Type

/** One backup a deletion's final backup is made of. */
const FinalBackupPart = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["instance", "database", "app", "volume"]),
})
type FinalBackupPart = typeof FinalBackupPart.Type

/**
 * What a deletion takes, decided once, after the freeze, and kept in its
 * journal: what its final backup is made of, if it takes one, and the
 * volumes of an App's own its Relay may delete. Nothing that comes to use
 * them later adds to either; a volume something else came to use stays.
 */
const DeletionPlan = Schema.Struct({
  parts: Schema.Array(FinalBackupPart),
  volumeIds: Schema.Array(Schema.String),
})
type DeletionPlan = typeof DeletionPlan.Type

const AppDeleted = Schema.Struct({ deleted: Schema.Literal(true) })

// How long to wait before looking at the final backup again: soon at first,
// then every half minute while it runs.
const backupCheckDelay = (check: number) =>
  Duration.millis(Math.min(30_000, Math.round(2_000 * 1.5 ** (check - 1))))

// Cleanup that failed is tried again after each of these, then the deletion
// stops for someone to look, with the Relay's part done.
const CLEANUP_RETRY_AFTER: ReadonlyArray<Duration.Input> = [
  "5 seconds",
  "30 seconds",
  "2 minutes",
  "10 minutes",
]

const Start = Schema.Struct({
  current: Schema.Boolean,
  finalBackup: Schema.Boolean,
  relayDeleted: Schema.Boolean,
  // What an earlier attempt asked the Relay to delete, if it got that far.
  relayDeleting: Schema.NullOr(
    Schema.Struct({ volumeIds: Schema.Array(Schema.String) })
  ),
})

const BackupCheck = Schema.Struct({
  error: Schema.NullOr(Schema.String),
  state: Schema.Literals(["available", "failed", "missing", "running"]),
})

export const deleteResource = durableOperation({
  error: ResourceDeletionError,
  input: DeletionInput,
  kind: "resource.delete",
  run: (input) =>
    deletionSteps(input).pipe(
      // Recorded on the deletion, for its person to see and act on. A run
      // waiting to resume isn't over.
      Effect.onError((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Activity.make({
              name: "failed",
              execute: recordStatus(input, "failed", causeMessage(cause)),
            })
      )
    ),
  version: 1,
})

const deletionSteps = (input: DeletionInput) =>
  Effect.gen(function* () {
    const start = yield* Activity.make({
      name: "start",
      success: Start,
      execute: loadResourceDeletionEffect(input.deletionId).pipe(
        Effect.map((deletion) => ({
          // Started again for an attempt that's been replaced or finished,
          // as by a restart's carry-over: nothing to do.
          current:
            deletion !== null &&
            deletion.attempt === input.attempt &&
            unfinishedDeletionStatuses.some(
              (status) => status === deletion.status
            ),
          finalBackup: deletion?.finalBackup ?? false,
          relayDeleted: deletion?.relayDeletedAt != null,
          relayDeleting:
            deletion?.relayDeletingAt != null
              ? { volumeIds: deletion.volumeIds ?? [] }
              : null,
        })),
        Effect.orDie
      ),
    })
    if (!start.current) return
    if (!start.relayDeleted) {
      // Once its Relay was asked to delete it, what's left of it can only be
      // deleted: finished as it was asked, with the volumes it named, and no
      // new final backup, which couldn't be of what's gone.
      const plan = start.relayDeleting
        ? { parts: [], volumeIds: start.relayDeleting.volumeIds }
        : yield* prepare(input, start.finalBackup)
      yield* Activity.make({
        name: "deleting",
        execute: recordStatus(input, "deleting", null),
      })
      // Recorded before it's sent: from here it can't be kept.
      yield* Activity.make({
        name: "relay-deleting",
        execute: recordRelayDeletingEffect({
          id: input.deletionId,
          volumeIds: plan.volumeIds,
        }).pipe(Effect.orDie),
      })
      yield* deleteOnRelay(input, plan)
      yield* Activity.make({
        name: "relay-deleted",
        execute: recordRelayDeletedEffect(input.deletionId).pipe(Effect.orDie),
      })
    }
    for (let round = 1; ; round++) {
      const failure = yield* Activity.make({
        name: `cleanup/${round}`,
        success: Schema.NullOr(Schema.String),
        execute: cleanUp(input),
      })
      if (failure === null) break
      const retryAfter = CLEANUP_RETRY_AFTER[round - 1]
      if (!retryAfter) {
        return yield* new ResourceDeletionError({
          message: `The ${noun(input.kind)} was deleted, but cleaning up after it failed: ${failure}`,
        })
      }
      yield* DurableClock.sleep({
        duration: retryAfter,
        name: `cleanup/retry/${round}`,
      })
    }
    yield* Activity.make({
      name: "completed",
      execute: recordStatus(input, "completed", null).pipe(
        Effect.tap(() => Effect.sync(() => publishDeleted(input)))
      ),
    })
  })

// Checks the person may still delete it, freezes it, decides what the
// deletion takes, and takes its final backup if one was asked for.
const prepare = (input: DeletionInput, takeFinalBackup: boolean) =>
  Effect.gen(function* () {
    yield* Activity.make({
      name: "access",
      error: ResourceDeletionError,
      execute: checkAccess(input),
    })
    yield* relayCommand({
      name: "freeze",
      operation: "resource.freeze",
      payload: {
        deletionId: input.deletionId,
        id: input.resourceId,
        kind: input.kind,
      },
      relayId: input.relayId,
      // It went through: the resource is frozen for this deletion.
      recover: Effect.succeed({ frozen: true }),
      timeoutMs: relayControlDeadlineMs("resource.freeze"),
    }).pipe(Effect.mapError(asDeletionError))
    const plan = yield* Activity.make({
      name: "plan",
      success: DeletionPlan,
      error: ResourceDeletionError,
      execute: deletionPlan(input),
    })
    if (takeFinalBackup) yield* finalBackup(input, plan.parts)
    return plan
  })

// The person who asked may still delete it, and back it up where they
// chose, as their account and access are now.
const checkAccess = (input: DeletionInput) =>
  Effect.gen(function* () {
    const deletion = yield* loadResourceDeletionEffect(input.deletionId)
    if (!deletion) return yield* Effect.die("The deletion is gone")
    const user = yield* currentActingUser(deletion.requestedBy, deletion.actor)
    if (input.kind === "instance" || input.kind === "database") {
      yield* requireRelayPermissionsEffect({
        permissions: [
          input.kind === "instance" ? "instance.delete" : "database.delete",
          ...(deletion.finalBackup ? (["backup.create"] as const) : []),
        ],
        relayId: input.relayId,
        user,
        ...(input.kind === "instance"
          ? { instanceId: input.resourceId }
          : { databaseId: input.resourceId }),
      })
    } else {
      // A Kiln volume is the Relay's, shared by design. An App's own
      // volumes are backed up as the App is.
      yield* requireRelayPermissionsEffect({
        permissions: [input.kind === "app" ? "app.delete" : "relay.configure"],
        relayId: input.relayId,
        user,
        ...(input.kind === "app" ? { appId: input.resourceId } : {}),
      })
      if (deletion.finalBackup) {
        yield* promiseEffect(() =>
          requireBackupTargetPermission(
            user,
            input.relayId,
            { id: input.resourceId, kind: input.kind },
            "backup.create"
          )
        )
      }
    }
    if (deletion.finalBackup && deletion.storageId !== null) {
      yield* promiseEffect(() =>
        resolveAuthorizedBackupStorageSelection({
          relayId: input.relayId,
          storageId: deletion.storageId,
          targetId: input.resourceId,
          targetKind: input.kind,
          user,
        })
      )
    }
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ResourceDeletionError({
          message: `Nothing was deleted: ${messageOf(cause)}`,
        })
    )
  )

// Takes the final backup, part by part, and follows each to its end by its
// ID: one that fails, or goes, stops the deletion with the resource frozen,
// and nothing deleted. Each part is reserved once, recording it on the
// deletion.
const finalBackup = (
  input: DeletionInput,
  parts: ReadonlyArray<FinalBackupPart>
) =>
  Effect.gen(function* () {
    let previous: string | null = null
    for (const [index, part] of parts.entries()) {
      const backupId: string = yield* Activity.make({
        name: `backup/${index}/reserve`,
        success: Schema.String,
        error: ResourceDeletionError,
        execute: reserveFinalBackup(input, part, previous),
      })
      for (let check = 1; ; check++) {
        const state = yield* Activity.make({
          name: `backup/${index}/check/${check}`,
          success: BackupCheck,
          execute: checkFinalBackup(input, backupId),
        })
        if (state.state === "available") break
        if (state.state !== "running") {
          return yield* new ResourceDeletionError({
            message:
              state.error ??
              (state.state === "missing"
                ? `The final backup is gone; the ${noun(input.kind)} was not deleted`
                : `The final backup failed; the ${noun(input.kind)} was not deleted`),
          })
        }
        yield* DurableClock.sleep({
          duration: backupCheckDelay(check),
          name: `backup/${index}/wait/${check}`,
        })
      }
      previous = backupId
    }
  })

// What a deletion takes: the resource itself, or for an App, its folder and
// each volume its Compose project made that nothing else uses, which its
// Relay may delete with it. One another App or container also mounts stays
// when the App goes; backing it up would stop what else uses it for good,
// as a final backup doesn't start what it stopped again.
const deletionPlan = (
  input: DeletionInput
): Effect.Effect<DeletionPlan, ResourceDeletionError> =>
  input.kind !== "app"
    ? Effect.succeed({
        parts: [{ id: input.resourceId, kind: input.kind }],
        volumeIds: [],
      })
    : promiseEffect(async () => {
        const relay = await activeRelay(input.relayId)
        const { volumes } = relayVolumesSchema.parse(
          await relayRpc(relay, "relay.volumes.read", {}, 30_000)
        )
        const ownOnly = (volume: (typeof volumes)[number]) =>
          volume.owner?.appId === input.resourceId &&
          volume.users.every((user) => user.appId === input.resourceId) &&
          volume.mounts.every(
            (mount) =>
              mount.kind === "app" && mount.resourceId === input.resourceId
          )
        const volumeIds = volumes.flatMap((volume) =>
          volume.id !== null && ownOnly(volume) ? [volume.id] : []
        )
        return {
          parts: [
            { id: input.resourceId, kind: "app" as const },
            ...volumeIds.map((id) => ({ id, kind: "volume" as const })),
          ],
          volumeIds,
        }
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ResourceDeletionError({
              message: `The App's volumes couldn't be read, so nothing was deleted: ${messageOf(cause)}`,
            })
        )
      )

const reserveFinalBackup = (
  input: DeletionInput,
  part: FinalBackupPart,
  previous: string | null
) =>
  Effect.gen(function* () {
    const deletion = yield* loadResourceDeletionEffect(input.deletionId).pipe(
      Effect.orDie
    )
    if (!deletion) return yield* Effect.die("The deletion is gone")
    // Reserved before, by this attempt or one before it while the resource
    // stayed frozen: followed, not taken again.
    if (deletion.backupId !== null && deletion.backupId !== previous) {
      return deletion.backupId
    }
    const reservation = {
      backupId: randomUUID(),
      createdBy: deletion.requestedBy,
      deletionId: deletion.id,
      name: timestampedBackupName("final"),
      previousFinalBackupId: previous,
      reason: "final_delete" as const,
      relayId: input.relayId,
      requestedMaxBytes: null,
      storageIds: [deletion.storageId],
      targetId: part.id,
      taskId: randomUUID(),
    }
    const dispatch = yield* promiseEffect(() =>
      runAppEffect(
        "resourceDeletions.reserveBackup",
        part.kind === "instance"
          ? reserveInstanceBackupEffect(reservation)
          : part.kind === "database"
            ? reserveDatabaseBackupEffect(reservation)
            : // Taken of the frozen resource, stopped as freezing left it.
              reserveResourceBackupEffect({
                ...reservation,
                consistency: "stopped",
                targetKind: part.kind,
              })
      )
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ResourceDeletionError({
            message: `The final backup couldn't start, so nothing was deleted: ${messageOf(cause)}`,
          })
      )
    )
    publishBackupChange(input.relayId, dispatch.backupId)
    publishDeletionChange(input)
    // Queued on the Relay now if it answers; otherwise reconciling the
    // Relay's backups, as each check does, queues it.
    yield* promiseEffect(async () => {
      const relay = await activeRelay(input.relayId)
      const { dispatchBackupTask } = await import("@/lib/backup-reconciliation")
      await dispatchBackupTask(relay, dispatch, deletion.requestedBy)
    }).pipe(Effect.ignore)
    return dispatch.backupId
  })

const checkFinalBackup = (input: DeletionInput, backupId: string) =>
  Effect.gen(function* () {
    // The Relay's tasks are read in, and a backup not yet queued there is.
    yield* promiseEffect(async () => {
      const relay = await activeRelay(input.relayId)
      const { reconcileRelayBackups } =
        await import("@/lib/backup-reconciliation")
      await reconcileRelayBackups(relay)
    }).pipe(Effect.ignore)
    return yield* finalBackupStateEffect(backupId)
  }).pipe(
    // Not read this time: looked at again on the next check.
    Effect.catch(() =>
      Effect.succeed({ error: null, state: "running" as const })
    )
  )

// Deletes the resource on its Relay. A refusal where the Relay in fact no
// longer has it, as when an earlier delete's reply was lost, counts as
// deleted; anything else stops the deletion with the resource frozen.
const deleteOnRelay = (input: DeletionInput, plan: DeletionPlan) =>
  Effect.gen(function* () {
    if (input.kind === "app") return yield* deleteAppOnRelay(input, plan)
    // A database the Relay lists nothing of, as when an earlier delete
    // stopped partway, keeps what's left of its data: nothing could back it
    // up.
    const deleteData =
      input.kind !== "database" ||
      (yield* Activity.make({
        name: "delete/inspect",
        success: Schema.Boolean,
        error: ResourceDeletionError,
        execute: resourceOnRelay(input).pipe(Effect.mapError(asDeletionError)),
      }))
    const gone = resourceOnRelay(input).pipe(
      Effect.flatMap((present) =>
        present
          ? Effect.fail(
              new RelayCommandError({
                code: "still_present",
                message: `The Relay still has this ${noun(input.kind)}`,
                retryable: false,
              })
            )
          : Effect.void
      )
    )
    const command =
      input.kind === "instance"
        ? {
            operation: "instance.delete" as const,
            payload: { deleteData: true, instanceId: input.resourceId },
          }
        : input.kind === "database"
          ? {
              operation: "database.delete" as const,
              payload: { databaseId: input.resourceId, deleteData },
            }
          : {
              operation: "relay.volumes.delete" as const,
              payload: { id: input.resourceId },
            }
    yield* relayCommand({
      name: "delete",
      relayId: input.relayId,
      ...command,
      timeoutMs: relayControlDeadlineMs(command.operation),
      recover: gone,
    }).pipe(
      Effect.catchTag("RelayCommandError", (refused) =>
        Activity.make({
          name: "delete/verify",
          success: Schema.Boolean,
          error: ResourceDeletionError,
          execute: resourceOnRelay(input).pipe(
            Effect.mapError(asDeletionError)
          ),
        }).pipe(
          Effect.flatMap((present) =>
            present ? Effect.fail(asDeletionError(refused)) : Effect.void
          )
        )
      )
    )
  })

// Deletes an App on its Relay: its folder and the volumes its plan names,
// never a Kiln volume or one something else mounts. An App whose containers
// and network are gone may still have its folder and the Relay's records of
// it, as when the Relay stopped partway, so its absence from the Relay's
// Apps isn't taken as deleted. Deleting it is safe to send again, and the
// Relay says it's deleted only once its folder is gone, so one that failed,
// or whose outcome is lost, is sent again once.
const deleteAppOnRelay = (input: DeletionInput, plan: DeletionPlan) => {
  const send = (name: string) =>
    relayCommand({
      name,
      operation: "app.delete",
      payload: {
        appId: input.resourceId,
        deleteData: true,
        volumeIds: plan.volumeIds,
      },
      relayId: input.relayId,
      // It went through: the Relay said it's deleted.
      recover: Effect.succeed({ deleted: true as const }),
      success: AppDeleted,
      timeoutMs: relayControlDeadlineMs("app.delete"),
    })
  return send("delete").pipe(
    Effect.catchTag("RelayCommandError", () => send("delete/again")),
    Effect.mapError(asDeletionError),
    Effect.asVoid
  )
}

// Whether the Relay still has anything of the resource. Asked again while
// the Relay is away; an answer is final.
const resourceOnRelay = (input: DeletionInput) =>
  promiseEffect(async () => {
    const relay = await activeRelay(input.relayId)
    if (input.kind === "instance") {
      const snapshot = relaySnapshotSchema.parse(
        await relayRpc(relay, "relay.snapshot", {}, 15_000)
      )
      return snapshot.instances.some(
        (instance) => instance.id === input.resourceId
      )
    }
    if (input.kind === "volume") {
      const { volumes } = relayVolumesSchema.parse(
        await relayRpc(relay, "relay.volumes.read", {}, 30_000)
      )
      return volumes.some((volume) => volume.id === input.resourceId)
    }
    // An App is never asked after: see deleteAppOnRelay.
    const [item] = z
      .array(z.unknown())
      .parse(
        await relayRpc(
          relay,
          "database.list",
          { requests: [{ id: input.resourceId, view: "detail" }] },
          30_000
        )
      )
    return item !== undefined
  }).pipe(
    Effect.mapError(
      (cause) =>
        new RelayCommandError({
          code: "unreadable",
          message: messageOf(cause),
          retryable: false,
        })
    )
  )

// Cleans up after the deleted resource in Hearth. Returns why it failed,
// or null once it's done.
const cleanUp = (input: DeletionInput) =>
  Effect.gen(function* () {
    const deletion = yield* loadResourceDeletionEffect(input.deletionId)
    const subject = deletion?.requestedBy ?? "system"
    if (input.kind === "instance") {
      // Its incremental snapshots go with it; its archives, the final
      // backup among them, stay until they're deleted as backups are.
      yield* promiseEffect(() =>
        runAppEffect(
          "resourceDeletions.purgeRepositories",
          purgeInstanceBackupRepositoriesEffect(input.relayId, input.resourceId)
        )
      )
    }
    // Hearth keeps nothing of a Kiln volume but its backups, which stay.
    if (input.kind !== "volume") {
      const resource = {
        id: input.resourceId,
        kind: input.kind,
        relayId: input.relayId,
      }
      yield* promiseEffect(() =>
        runAppEffect(
          "resourceDeletions.cleanUp",
          cleanUpDeletedResourceEffect(resource, subject)
        )
      )
    }
    return null
  }).pipe(Effect.catch((cause) => Effect.succeed(messageOf(cause))))

// Starting or ending a deletion marked the schedules backing the resource
// up as owed to its Relay, in its own transaction; this sends them now.
// Whatever doesn't arrive, the sweep sends again.
const deliverSchedules = Effect.sync(() => deliverPendingSchedules())

const recordStatus = (
  input: DeletionInput,
  status: ResourceDeletionStatus,
  error: string | null,
  from?: ReadonlyArray<ResourceDeletionStatus>
) =>
  recordResourceDeletionStatusEffect({
    attempt: input.attempt,
    error,
    ...(from ? { from } : {}),
    id: input.deletionId,
    status,
  }).pipe(
    Effect.tap(() => Effect.sync(() => publishDeletionChange(input))),
    Effect.tap(deliverSchedules),
    Effect.orDie,
    Effect.asVoid
  )

export const keepResource = durableOperation({
  error: ResourceDeletionError,
  input: DeletionInput,
  kind: "resource.delete.cancel",
  run: (input) =>
    Effect.gen(function* () {
      const current = yield* Activity.make({
        name: "start",
        success: Schema.Boolean,
        execute: loadResourceDeletionEffect(input.deletionId).pipe(
          Effect.map(
            (deletion) =>
              deletion !== null &&
              deletion.attempt === input.attempt &&
              deletion.status === "cancelling"
          ),
          Effect.orDie
        ),
      })
      if (!current) return
      yield* relayCommand({
        name: "unfreeze",
        operation: "resource.unfreeze",
        payload: {
          deletionId: input.deletionId,
          id: input.resourceId,
          kind: input.kind,
        },
        relayId: input.relayId,
        // It went through: the resource is let go.
        recover: Effect.succeed({ frozen: false }),
        timeoutMs: relayControlDeadlineMs("resource.unfreeze"),
      }).pipe(Effect.mapError(asDeletionError))
      yield* Activity.make({
        name: "kept",
        execute: recordStatus(input, "cancelled", null, ["cancelling"]),
      })
    }).pipe(
      // Still frozen, perhaps, and stopped again: its person can try to keep
      // it again, or delete it, which takes a new final backup.
      Effect.onError((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Activity.make({
              name: "failed",
              execute: recordStatus(
                input,
                "failed",
                `Keeping it didn't finish: ${causeMessage(cause)}`,
                ["cancelling"]
              ),
            })
      )
    ),
  version: 1,
})

// Admits the operation that carries out a deletion's current attempt. One
// already admitted under its key is the same operation.
const startAttempt = (deletion: ResourceDeletion) =>
  startDurableOperation(
    deletion.status === "cancelling" ? keepResource : deleteResource,
    {
      attempt: deletion.attempt,
      deletionId: deletion.id,
      kind: deletion.kind,
      relayId: deletion.relayId,
      resourceId: deletion.resourceId,
    },
    {
      actorId: deletion.requestedBy,
      idempotencyKey: `${deletion.id}:${deletion.attempt}`,
    }
  )

/**
 * Admits every running attempt whose operation is missing, as after Hearth
 * stopped between recording one and admitting it, or an upgrade from the
 * final-delete worker. One whose operation ended without recording how is
 * marked failed, for its person to try again. Run at startup and then every
 * so often; it costs one query when there's nothing to do.
 */
export const reconcileResourceDeletions = Effect.fnUntraced(function* () {
  const found = yield* listResourceDeletionsToReconcileEffect()
  if (found.length === 0) return
  yield* Effect.forEach(
    found,
    ({ deletion, operationEnded }) =>
      operationEnded
        ? recordResourceDeletionStatusEffect({
            attempt: deletion.attempt,
            error: "It stopped before it finished. Try again.",
            from: [deletion.status],
            id: deletion.id,
            status: "failed",
          }).pipe(
            Effect.tap(() =>
              Effect.sync(() => publishDeletionChange(deletion))
            ),
            Effect.tap(deliverSchedules),
            Effect.asVoid
          )
        : startAttempt(deletion).pipe(Effect.asVoid),
    { discard: true }
  ).pipe(
    Effect.withSpan("ResourceDeletions.reconcile", {
      attributes: { "resource_deletion.count": found.length },
    })
  )
})

/**
 * Asks to delete a game server or database, for `user`, who the caller has
 * checked may delete it. A new deletion, or one that failed or was
 * cancelled, starts its next attempt; one already running is returned as
 * it is. With a final backup, `storageId` names where it goes, null for the
 * Relay's own disk, or the resource's usual destination when left out.
 */
export const requestResourceDeletionEffect = Effect.fn(
  "ResourceDeletions.request"
)(function* (input: {
  finalBackup: boolean
  kind: ResourceDeletionKind
  relayId: string
  resourceId: string
  /** The failed attempt a retry read: it goes ahead only from that one. */
  retryOf?: number
  storageId?: string | null
  user: AuthenticatedUser
}) {
  const [storageId = null] = input.finalBackup
    ? yield* promiseEffect(() =>
        resolveAuthorizedBackupStorageSelection({
          relayId: input.relayId,
          targetId: input.resourceId,
          targetKind: input.kind,
          user: input.user,
          ...(input.storageId === undefined
            ? {}
            : { storageId: input.storageId }),
        })
      )
    : []
  const deletion = yield* requestResourceDeletionRowEffect({
    finalBackup: input.finalBackup,
    kind: input.kind,
    relayId: input.relayId,
    resourceId: input.resourceId,
    ...(input.retryOf === undefined ? {} : { retryOf: input.retryOf }),
    storageId,
    user: input.user,
  })
  yield* deliverSchedules
  if (unfinishedDeletionStatuses.some((status) => status === deletion.status)) {
    yield* startAttempt(deletion)
  }
  publishDeletionChange(deletion)
  return deletion
})

export function requestResourceDeletion(
  input: Parameters<typeof requestResourceDeletionEffect>[0]
): Promise<ResourceDeletion> {
  return runAppEffect(
    "resourceDeletions.request",
    requestResourceDeletionEffect(input)
  )
}

/**
 * Waits for a deletion's attempt to end, up to `timeoutMs`: returns once
 * it's done, throws with why it stopped, or says it carries on in the
 * background.
 */
export function awaitResourceDeletion(
  deletion: Pick<ResourceDeletion, "attempt" | "id" | "kind">,
  timeoutMs = 10 * 60_000
): Promise<void> {
  return awaitAttempt(deletion, "completed", timeoutMs)
}

async function awaitAttempt(
  deletion: Pick<ResourceDeletion, "attempt" | "id" | "kind">,
  done: "cancelled" | "completed",
  timeoutMs: number
): Promise<void> {
  const subject = noun(deletion.kind)
  const deadline = Date.now() + timeoutMs
  let current: ResourceDeletion | null = null
  while (Date.now() < deadline) {
    current = await loadResourceDeletion(deletion.id)
    if (!current) throw new Error("The deletion is gone")
    if (current.status === done) return
    if (current.attempt !== deletion.attempt) break
    if (current.status === "failed") {
      throw new Error(current.error ?? `The ${subject} was not deleted`)
    }
    if (current.status === "cancelled") {
      throw new Error(`Deleting this ${subject} was cancelled`)
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
  }
  throw new Error(
    done === "cancelled"
      ? `Keeping this ${subject} continues in the background.`
      : current?.status === "backing_up"
        ? `The final backup is still running. Deleting this ${subject} continues in the background.`
        : `Deleting this ${subject} continues in the background.`
  )
}

/**
 * Keeps a resource whose deletion failed before the Relay deleted it:
 * records that first, so the attempt survives Hearth stopping and no retry
 * starts meanwhile, then admits the operation that lets it go on its Relay,
 * in the deletion's own lane.
 */
export const cancelResourceDeletionEffect = Effect.fn(
  "ResourceDeletions.cancel"
)(function* (input: {
  kind: ResourceDeletionKind
  relayId: string
  resourceId: string
  user: AuthenticatedUser
}) {
  const deletion = yield* requestResourceKeepRowEffect(
    input.relayId,
    input.kind,
    input.resourceId
  )
  yield* startAttempt(deletion)
  publishDeletionChange(deletion)
  return deletion
})

/** Keeps a resource whose deletion failed, and waits a while for it. */
export async function cancelResourceDeletion(
  input: Parameters<typeof cancelResourceDeletionEffect>[0]
): Promise<void> {
  const deletion = await runAppEffect(
    "resourceDeletions.cancel",
    cancelResourceDeletionEffect(input)
  )
  await awaitAttempt(deletion, "cancelled", 60_000)
}

export function loadResourceDeletion(id: string) {
  return runAppEffect("resourceDeletions.load", loadResourceDeletionEffect(id))
}

export function findResourceDeletion(
  relayId: string,
  kind: ResourceDeletionKind,
  resourceId: string
) {
  return runAppEffect(
    "resourceDeletions.find",
    findResourceDeletionEffect(relayId, kind, resourceId)
  )
}

function publishDeletionChange(resource: {
  kind: ResourceDeletionKind
  relayId: string
  resourceId: string
}): void {
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [resource.relayId] },
    scope:
      resource.kind === "instance"
        ? { instanceId: resource.resourceId, relayId: resource.relayId }
        : resource.kind === "database"
          ? { databaseId: resource.resourceId, relayId: resource.relayId }
          : { relayId: resource.relayId },
    topics: ["resource-deletions"],
    type: "hearth.invalidate",
  })
}

// Whoever has the resource open sees it go, whether or not the request
// that asked is still waiting.
function publishDeleted(input: DeletionInput): void {
  if (input.kind === "instance") {
    publishRealtimeChange({
      instanceId: input.resourceId,
      relayId: input.relayId,
      type: "instance.delete",
    })
    return
  }
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [input.relayId] },
    ...(input.kind === "database"
      ? { scope: { databaseId: input.resourceId, relayId: input.relayId } }
      : { scope: { relayId: input.relayId } }),
    topics:
      input.kind === "database"
        ? ["databases", "database-directory", "database-credentials"]
        : input.kind === "app"
          ? // Its own volumes went with it.
            ["apps", "app-directory", "relay-volumes"]
          : ["relay-volumes"],
    type: "hearth.invalidate",
  })
}

function noun(kind: ResourceDeletionKind): string {
  return kind === "instance"
    ? "game server"
    : kind === "database"
      ? "database"
      : kind === "app"
        ? "App"
        : "volume"
}

function asDeletionError(error: { readonly message: string }) {
  return new ResourceDeletionError({ message: error.message })
}

function causeMessage(cause: Cause.Cause<unknown>): string {
  return messageOf(Cause.squash(cause))
}

function messageOf(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : Schema.is(ResourceDeletionError)(cause)
      ? cause.message
      : String(cause)
}
