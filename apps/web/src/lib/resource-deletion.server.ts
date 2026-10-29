import { randomUUID } from "node:crypto"

import {
  relayControlDeadlineMs,
  relaySnapshotSchema,
} from "@workspace/contracts"
import { exclusive, shared } from "@workspace/operations"
import { Cause, Duration, Effect, Schema } from "effect"
import { Activity, DurableClock } from "effect/workflow"
import { z } from "zod"

import {
  purgeInstanceBackupRepositoriesEffect,
  reserveDatabaseBackupEffect,
  reserveInstanceBackupEffect,
} from "@/effect/backups"
import { promiseEffect } from "@/effect/promise"
import {
  finalBackupStateEffect,
  findResourceDeletionEffect,
  listResourceDeletionsToReconcileEffect,
  loadResourceDeletionEffect,
  recordRelayDeletedEffect,
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
import { cleanUpDeletedResourceEffect } from "@/server/resource-deletion-cleanup"
import { deliverPendingSchedules } from "@/server/schedule-deployment.server"

// Deleting a game server or database, as one durable operation per attempt
// (docs/resource-unification.md, Deletion): check the person who asked may
// still delete it, freeze it on its Relay, take its final backup if one was
// asked for, delete it on the Relay, then clean up after it in Hearth. Each
// step is safe to run again after a restart, and a finished one doesn't run
// again. Its row (`resource_deletion`) says how far it got; a failure stops
// there with the resource still frozen, for its person to try again, delete
// it without a final backup, or keep it. Once the Relay has deleted it,
// cleanup always finishes, as system work, whoever asked.
//
// Keeping a resource after its deletion failed is an operation of its own,
// `resource.delete.cancel`, in the same lane, so it never runs alongside a
// deletion of it: it lets the resource go on its Relay, then records it kept.
// Each attempt at either is recorded on the row before its operation is
// admitted, and a reconciler admits any attempt whose operation is missing.
//
// Both hold the resource shared and its deletion exclusive, not the whole
// resource: cleanup changes the resource's DNS, which takes the resource
// shared and its DNS exclusive, and would otherwise wait for it. The final
// backup takes no Hearth locks. Keep it that way as Apps and volumes plug
// in: a deletion must never wait on a child operation that needs the whole
// resource exclusively (an App's volumes, say), since it holds the resource
// shared and the child would wait for it forever. Do such work as steps of
// this operation instead.

/** A step of a deletion that stopped it, with what to tell its person. */
export class ResourceDeletionError extends Schema.TaggedError<ResourceDeletionError>()(
  "ResourceDeletionError",
  { message: Schema.String }
) {}

const DeletionInput = Schema.Struct({
  attempt: Schema.Number,
  deletionId: Schema.String,
  kind: Schema.Literals(["instance", "database"]),
  relayId: Schema.String,
  resourceId: Schema.String,
})
type DeletionInput = typeof DeletionInput.Type

const deletionLocks = (resource: {
  kind: ResourceDeletionKind
  relayId: string
  resourceId: string
}) => {
  const whole = `${resource.kind}:${resource.relayId}/${resource.resourceId}`
  return [shared(whole), exclusive(`${whole}/delete`)]
}

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
})

const BackupCheck = Schema.Struct({
  error: Schema.NullOr(Schema.String),
  state: Schema.Literals(["available", "failed", "missing", "running"]),
})

export const deleteResource = durableOperation({
  error: ResourceDeletionError,
  input: DeletionInput,
  kind: "resource.delete",
  locks: deletionLocks,
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
        })),
        Effect.orDie
      ),
    })
    if (!start.current) return
    if (!start.relayDeleted) {
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
      if (start.finalBackup) yield* finalBackup(input)
      yield* Activity.make({
        name: "deleting",
        execute: recordStatus(input, "deleting", null),
      })
      yield* deleteOnRelay(input)
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

// The person who asked may still delete it, and back it up where they
// chose, as their account and access are now.
const checkAccess = (input: DeletionInput) =>
  Effect.gen(function* () {
    const deletion = yield* loadResourceDeletionEffect(input.deletionId)
    if (!deletion) return yield* Effect.die("The deletion is gone")
    const user = yield* currentActingUser(deletion.requestedBy, deletion.actor)
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

// Reserves the final backup once, recording it on the deletion, and follows
// it to its end by its ID. One that fails, or goes, stops the deletion with
// the resource frozen.
const finalBackup = (input: DeletionInput) =>
  Effect.gen(function* () {
    const backupId = yield* Activity.make({
      name: "backup/reserve",
      success: Schema.String,
      error: ResourceDeletionError,
      execute: reserveFinalBackup(input),
    })
    for (let check = 1; ; check++) {
      const state = yield* Activity.make({
        name: `backup/check/${check}`,
        success: BackupCheck,
        execute: checkFinalBackup(input, backupId),
      })
      if (state.state === "available") return
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
        name: `backup/wait/${check}`,
      })
    }
  })

const reserveFinalBackup = (input: DeletionInput) =>
  Effect.gen(function* () {
    const deletion = yield* loadResourceDeletionEffect(input.deletionId).pipe(
      Effect.orDie
    )
    if (!deletion) return yield* Effect.die("The deletion is gone")
    // Reserved before, by this attempt or one before it while the resource
    // stayed frozen: followed, not taken again.
    if (deletion.backupId) return deletion.backupId
    const reservation = {
      backupId: randomUUID(),
      createdBy: deletion.requestedBy,
      deletionId: deletion.id,
      name: timestampedBackupName("final"),
      reason: "final_delete" as const,
      relayId: input.relayId,
      requestedMaxBytes: null,
      storageIds: [deletion.storageId],
      targetId: input.resourceId,
      taskId: randomUUID(),
    }
    const dispatch = yield* promiseEffect(() =>
      runAppEffect(
        "resourceDeletions.reserveBackup",
        input.kind === "instance"
          ? reserveInstanceBackupEffect(reservation)
          : reserveDatabaseBackupEffect(reservation)
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
const deleteOnRelay = (input: DeletionInput) =>
  Effect.gen(function* () {
    // A database the Relay lists nothing of, as when an earlier delete
    // stopped partway, keeps what's left of its data: nothing could back it
    // up.
    const deleteData =
      input.kind === "instance" ||
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
    yield* relayCommand({
      name: "delete",
      relayId: input.relayId,
      ...(input.kind === "instance"
        ? {
            operation: "instance.delete" as const,
            payload: { deleteData: true, instanceId: input.resourceId },
            timeoutMs: relayControlDeadlineMs("instance.delete"),
          }
        : {
            operation: "database.delete" as const,
            payload: { databaseId: input.resourceId, deleteData },
            timeoutMs: relayControlDeadlineMs("database.delete"),
          }),
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
    yield* promiseEffect(() =>
      runAppEffect(
        "resourceDeletions.cleanUp",
        cleanUpDeletedResourceEffect(
          { id: input.resourceId, kind: input.kind, relayId: input.relayId },
          subject
        )
      )
    )
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
  locks: deletionLocks,
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
        : { databaseId: resource.resourceId, relayId: resource.relayId },
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
    scope: { databaseId: input.resourceId, relayId: input.relayId },
    topics: ["databases", "database-directory", "database-credentials"],
    type: "hearth.invalidate",
  })
}

function noun(kind: ResourceDeletionKind): string {
  return kind === "instance" ? "game server" : "database"
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
