import { z } from "zod"
import { Effect } from "effect"
import { logException } from "@workspace/telemetry"

import {
  backupFailureCodeFromMessage,
  backupTaskAwaitsHearth,
  relayBackupTaskSchema,
  type RelayBackupTask,
} from "@workspace/contracts"

import {
  BackupCopyKept,
  deleteStoredFullBackupCopy,
} from "@/backups/destinations"
import {
  cancelUnsentCreateEffect,
  createsOfDeletedBackupsEffect,
  listDispatchableBackupTasksEffect,
  reconcileBackupTaskEffect,
  recordStoredCopyDeleteEffect,
  settleUndispatchableBackupTaskEffect,
  type BackupCopyDeleteOutcome,
  type BackupDeleteReservation,
  type BackupDispatch,
  type BackupDispatchArtifact,
} from "@/effect/backups"
import { isDeadlock } from "@/effect/database-deadlocks"
import { BackupStorageError, CredentialError } from "@/effect/errors"
import { promiseEffect } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import {
  publishBackupChange,
  publishBackupChanges,
} from "@/lib/backup-realtime.server"
import { prepareBackupTaskEffect } from "@/lib/backup-task-prepare"
import { relayRpc } from "@/lib/relay-connection"
import { listPersistedRelays, type PersistedRelay } from "@/lib/relay-registry"

const reconciliationTimers = new Map<
  string,
  { readonly at: number; readonly timer: ReturnType<typeof setTimeout> }
>()
// How soon a Relay's tasks are read again: while one is under way, and
// while the only ones left are taken and waiting on the Relay for a Hearth.
const RECONCILE_SOON_MS = 1_000
const RECONCILE_WAITING_MS = 30_000

const relayTasksSchema = z.array(relayBackupTaskSchema)

export async function reconcileBackupsAfterRelayConnect(
  relayId: string
): Promise<void> {
  const relay = (await listPersistedRelays()).find(
    (candidate) => candidate.enabled && candidate.id === relayId
  )
  if (relay) await reconcileRelayBackups(relay)
}

/**
 * Reads a Relay's tasks soon, and keeps reading until none is under way:
 * as when the Relay asks to send a backup it had been waiting with, which
 * Hearth was reading only now and then.
 */
export async function followRelayBackups(relayId: string): Promise<void> {
  const relay = (await listPersistedRelays()).find(
    (candidate) => candidate.enabled && candidate.id === relayId
  )
  if (relay) scheduleBackupReconciliation(relay)
}

export function reconcileRelayBackups(
  relay: PersistedRelay,
  subject?: string
): Promise<void> {
  return runAppEffect(
    "Backups.reconcileRelay",
    reconcileRelayBackupsEffect(relay, subject)
  )
}

export function dispatchBackupTask(
  relay: PersistedRelay,
  input: BackupDispatch,
  subject?: string
): Promise<void> {
  return runAppEffect(
    "Backups.dispatch",
    dispatchBackupTaskEffect(relay, input, subject)
  )
}

/**
 * Carries out a delete of a backup nothing is still making, for the
 * operation that reserved it and holds the backup.
 *
 * Hearth first deletes the stored copies it reaches itself, those in a
 * bucket, whose keys it holds, one at a time. Nothing writes a stored copy
 * again, so no upload can cross its delete, and holding the backup keeps a
 * second delete out. What each bucket said is recorded as it answers, and
 * only once they all have is the Relay sent what is left: a copy on its
 * own disk, or one that was never stored. With nothing left the delete
 * ends here, whether or not the Relay is connected, and a bucket that
 * keeps a copy ends it with what it said.
 *
 * `unanswering` are destinations that didn't answer earlier in the same
 * pass, as retention's, which aren't asked again in it: one that is down
 * costs a pass one wait, not one for every backup it holds.
 */
export function carryOutBackupDelete(
  relay: PersistedRelay,
  reservation: Extract<BackupDeleteReservation, { kind: "dispatch" }>,
  options: { subject?: string; unanswering?: Set<string> } = {}
): Promise<{
  /** What a destination said as it kept a copy, which ended the delete. */
  kept: string | null
  /** Whether what was left for the Relay, if anything, reached it. */
  sent: boolean
}> {
  return runAppEffect(
    "Backups.carryOutDelete",
    carryOutBackupDeleteEffect(relay, reservation, options)
  )
}

const carryOutBackupDeleteEffect = Effect.fnUntraced(function* (
  relay: PersistedRelay,
  { dispatch, stored }: Extract<BackupDeleteReservation, { kind: "dispatch" }>,
  options: { subject?: string; unanswering?: Set<string> }
) {
  yield* Effect.annotateCurrentSpan(dispatchAttributes(relay, dispatch))
  for (const copy of stored) {
    const outcome = yield* deleteStoredCopy(
      relay,
      dispatch.backupId,
      copy,
      options.unanswering
    )
    const next = yield* recordStoredCopyDeleteEffect({
      backupId: dispatch.backupId,
      outcome,
      taskId: dispatch.taskId,
    })
    publishBackupChange(relay.id, dispatch.backupId)
    if (next !== "open") return { kept: outcome.error, sent: true }
  }
  const gone = new Set(stored.map((copy) => copy.artifactId))
  const rest = {
    ...dispatch,
    artifacts: dispatch.artifacts.filter(
      (artifact) => !gone.has(artifact.artifactId)
    ),
  }
  // Undelivered, what is left waits queued: the Relay's next reconciliation
  // sends it.
  const sent = yield* dispatchBackupTaskEffect(
    relay,
    rest,
    options.subject
  ).pipe(
    Effect.withSpan("Backups.dispatch"),
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false))
  )
  return { kept: null, sent }
})

// How long one copy's delete may take, the client's own tries and all.
const STORED_COPY_DELETE_TIMEOUT = "1 minute"

// One copy, in a span of its own, so a bucket that is slow or refuses shows
// in the delete's trace. Its failure is the copy's outcome.
const deleteStoredCopy = (
  relay: PersistedRelay,
  backupId: string,
  copy: BackupDispatchArtifact,
  unanswering: Set<string> | undefined
) => {
  const destination = copy.storageId ?? ""
  const unanswered = new BackupCopyKept({
    answered: false,
    reason: "the destination didn't answer in time",
  })
  const attempt = unanswering?.has(destination)
    ? Effect.fail(unanswered)
    : (
        deleteStoredFullBackupCopy({ ...copy, relayId: relay.id }) ??
        Effect.fail(
          new BackupCopyKept({
            answered: true,
            reason: "only its Relay can reach it",
          })
        )
      ).pipe(
        Effect.timeoutOrElse({
          duration: STORED_COPY_DELETE_TIMEOUT,
          orElse: () => Effect.fail(unanswered),
        })
      )
  return attempt.pipe(
    Effect.withSpan("Backups.deleteCopy", {
      attributes: {
        "relay.id": relay.id,
        "backup.id": backupId,
        "backup.artifact.id": copy.artifactId,
        "backup.storage.id": destination,
      },
    }),
    Effect.as<BackupCopyDeleteOutcome>({
      artifactId: copy.artifactId,
      error: null,
      errorCode: null,
      status: "deleted",
    }),
    Effect.catch((kept) => {
      if (!kept.answered) unanswering?.add(destination)
      const error = `The backup's copy could not be deleted from its destination: ${kept.reason}`
      return Effect.succeed<BackupCopyDeleteOutcome>({
        artifactId: copy.artifactId,
        error,
        errorCode: backupFailureCodeFromMessage(error),
        status: "failed",
      })
    })
  )
}

/**
 * Asks a Relay to stop a create whose backup is being deleted, so the delete
 * waiting on it can go. A create the Relay never received is cancelled in
 * Hearth instead. Either way the Relay's backups are then reconciled, which
 * sends the delete once the create has ended.
 */
export function cancelCreateForDelete(
  relay: PersistedRelay,
  createTaskId: string,
  subject?: string
): Promise<void> {
  return runAppEffect(
    "Backups.cancelCreateForDelete",
    cancelCreateEffect(relay, createTaskId, subject).pipe(
      Effect.andThen(
        reconcileRelayBackupsEffect(relay, subject).pipe(
          Effect.withSpan("Backups.reconcileRelay")
        )
      )
    )
  )
}

export { prepareBackupTaskEffect }

/**
 * Brings Hearth's catalog in line with what a Relay holds: its tasks are
 * read in first, so tasks interrupted there can be refreshed and sent again
 * in the same pass; creates of backups being deleted are stopped; then every
 * queued task is sent, each on its own, so one Hearth can't send never holds
 * up the rest.
 */
// Untraced: each caller runs it in a `Backups.reconcileRelay` span of its own.
const reconcileRelayBackupsEffect = Effect.fnUntraced(
  function* (relay: PersistedRelay, subject?: string) {
    yield* Effect.annotateCurrentSpan({ "relay.id": relay.id })
    const tasks = relayTasksSchema.parse(
      yield* promiseEffect(() =>
        relayRpc(relay, "backup.task.list", {}, 15_000, subject)
      )
    )
    const relayTasksById = new Map(tasks.map((task) => [task.taskId, task]))
    // Tasks Hearth hasn't seen, as a schedule's backups whose news never
    // reached it, are cataloged side by side, each locking where its rows
    // will go, and MySQL ends one of two that wait on each other. Those run
    // again one at a time, where none is left to wait on another: without
    // that the pass failed the same way every time, and none of a batch was
    // ever cataloged.
    const settled = yield* Effect.forEach(
      // A prune is no backup's task: nothing of the catalog follows it.
      tasks.filter((task) => task.kind !== "prune"),
      (task) =>
        reconcileBackupTaskEffect(task, relay.id).pipe(
          Effect.map((updated) => ({ ended: false, task, updated })),
          Effect.catchIf(isDeadlock, () =>
            Effect.succeed({ ended: true, task, updated: false })
          )
        ),
      { concurrency: 8 }
    )
    const again = yield* Effect.forEach(
      settled.filter(({ ended }) => ended),
      ({ task }) =>
        reconcileBackupTaskEffect(task, relay.id).pipe(
          // Another pass may still be cataloging beside this one.
          Effect.retry({ times: 3, while: isDeadlock }),
          Effect.map((updated) => ({ task, updated }))
        ),
      { concurrency: 1 }
    )
    const changed = [...settled, ...again].flatMap(({ task, updated }) =>
      updated ? [task] : []
    )
    publishBackupChanges(
      relay.id,
      changed.map((task) => task.backupId)
    )
    // A finished backup can push its target past its retention.
    if (
      changed.some(
        (task) => task.kind === "create" && task.status === "succeeded"
      )
    ) {
      const { requestBackupRetention } = yield* promiseEffect(
        () => import("@/lib/backup-maintenance.server")
      )
      requestBackupRetention()
    }
    // A prune Hearth admitted is open until it ends.
    yield* closeEndedPrunes(
      relay.id,
      tasks.flatMap((task) =>
        task.kind === "prune" &&
        task.status !== "queued" &&
        task.status !== "running"
          ? [task.taskId]
          : []
      )
    )
    yield* stopCreatesOfDeletedBackups(relay, relayTasksById, subject)
    const dispatchable = yield* listDispatchableBackupTasksEffect(relay.id)
    let pending = 0
    for (const task of dispatchable) {
      if (task.kind === "undispatchable") {
        yield* settleUndispatchable(relay, task.taskId, task.backupId, {
          code: "invalid_backup_destination",
          reason: task.reason,
        })
        continue
      }
      const relayTask = relayTasksById.get(task.taskId)
      if (relayTask && !relayTask.inputRefreshRequired) continue
      pending += 1
      // Each on its own: one that fails is logged and tried again on the
      // next pass, or settled if it never can be sent.
      yield* dispatchBackupTaskEffect(relay, task, subject).pipe(
        Effect.withSpan("Backups.dispatch"),
        Effect.catch((cause) =>
          // Settled already, with a warning saying so.
          isSettled(cause)
            ? Effect.void
            : logException(cause, {
                operation: "Backups.dispatch",
                attributes: dispatchAttributes(relay, task),
              })
        )
      )
    }
    yield* Effect.annotateCurrentSpan({
      "backup.tasks.relay": tasks.length,
      "backup.tasks.changed": changed.length,
      "backup.tasks.dispatched": pending,
    })
    const unfinished = tasks.filter(
      (task) => task.status === "queued" || task.status === "running"
    )
    if (pending > 0 || unfinished.length > 0) {
      scheduleBackupReconciliation(
        relay,
        subject,
        // One taken and waiting on its Relay for a Hearth isn't moving, so
        // it is read less often. When the Relay sends it, it asks for
        // access first, which reads soon again (`followRelayBackups`); the
        // slow reading is for one that ends without asking.
        pending === 0 && unfinished.every(backupTaskAwaitsHearth)
          ? RECONCILE_WAITING_MS
          : RECONCILE_SOON_MS
      )
    }
  }
)

const closeEndedPrunes = Effect.fnUntraced(function* (
  relayId: string,
  taskIds: ReadonlyArray<string>
) {
  if (taskIds.length === 0) return
  const { closeRepositoryPrunesEffect } = yield* promiseEffect(
    () => import("@/server/backup-repository-access.server")
  )
  yield* closeRepositoryPrunesEffect(relayId, taskIds)
})

// Creates still running or queued for backups being deleted are stopped on
// the Relay, and ones the Relay never received are cancelled in Hearth, so
// each delete waiting on one can follow.
const stopCreatesOfDeletedBackups = Effect.fnUntraced(function* (
  relay: PersistedRelay,
  relayTasksById: ReadonlyMap<string, RelayBackupTask>,
  subject?: string
) {
  const activeRelayCreates = [...relayTasksById.values()].flatMap((task) =>
    task.kind === "create" &&
    (task.status === "queued" || task.status === "running")
      ? [task.taskId]
      : []
  )
  const creates = yield* createsOfDeletedBackupsEffect(
    relay.id,
    activeRelayCreates
  )
  for (const create of creates) {
    yield* (
      relayTasksById.has(create.id)
        ? cancelCreateEffect(relay, create.id, subject)
        : cancelUnsentCreateEffect(create.id)
    ).pipe(
      Effect.catch((cause) =>
        logException(cause, {
          operation: "Backups.cancelCreateForDelete",
          attributes: { "relay.id": relay.id, "backup.task.id": create.id },
        })
      )
    )
  }
})

const cancelCreateEffect = Effect.fn("Backups.cancelCreate")(function* (
  relay: PersistedRelay,
  createTaskId: string,
  subject?: string
) {
  yield* Effect.annotateCurrentSpan({
    "relay.id": relay.id,
    "backup.task.id": createTaskId,
  })
  const reply = yield* promiseEffect(() =>
    relayRpc(
      relay,
      "backup.task.cancel",
      { taskId: createTaskId },
      15_000,
      subject
    )
  )
  // The Relay doesn't have it: it never arrived, so nothing will run.
  if (reply === null || reply === undefined) {
    yield* cancelUnsentCreateEffect(createTaskId)
    return
  }
  const task = relayBackupTaskSchema.parse(reply)
  if (yield* reconcileBackupTaskEffect(task, relay.id)) {
    publishBackupChange(relay.id, task.backupId)
  }
})

// Untraced: run in a `Backups.dispatch` span by each caller.
const dispatchBackupTaskEffect = Effect.fnUntraced(function* (
  relay: PersistedRelay,
  input: BackupDispatch,
  subject?: string
) {
  yield* Effect.annotateCurrentSpan(dispatchAttributes(relay, input))
  const relayInput = yield* prepareBackupTaskEffect(input, relay.id).pipe(
    // What Hearth's own records lack stays lacking: the task is settled
    // rather than tried on every pass. The error still reaches the caller.
    Effect.tapError((cause) =>
      isSettled(cause)
        ? settleUndispatchable(relay, input.taskId, input.backupId, {
            code: cause instanceof BackupStorageError ? cause.code : "credential_unavailable",
            reason: cause.message,
          })
        : Effect.void
    )
  )
  const task = relayBackupTaskSchema.parse(
    yield* promiseEffect(() =>
      relayRpc(relay, "backup.task.enqueue", relayInput, 15_000, subject)
    )
  )
  scheduleBackupReconciliation(relay, subject)
  if (yield* reconcileBackupTaskEffect(task, relay.id)) {
    publishBackupChange(relay.id, task.backupId)
  }
})

const settleUndispatchable = (
  relay: PersistedRelay,
  taskId: string,
  backupId: string,
  failure: { code: string; reason: string }
) =>
  settleUndispatchableBackupTaskEffect({ ...failure, taskId }).pipe(
    Effect.tap((outcome) =>
      outcome === "unchanged"
        ? Effect.void
        : Effect.sync(() => publishBackupChange(relay.id, backupId)).pipe(
            Effect.andThen(
              Effect.logWarning("Settled a backup task Hearth can't send", {
                "relay.id": relay.id,
                "backup.id": backupId,
                "backup.task.id": taskId,
                "backup.task.settled": outcome,
                "backup.failure.code": failure.code,
              })
            )
          )
    )
  )

// What Hearth's own records lack stays lacking, so tasks failing this way
// are settled rather than tried again.
function isSettled(
  cause: unknown
): cause is BackupStorageError | CredentialError {
  return cause instanceof BackupStorageError || cause instanceof CredentialError
}

function dispatchAttributes(
  relay: PersistedRelay,
  task: { backupId: string; kind: string; taskId: string }
) {
  return {
    "relay.id": relay.id,
    "backup.id": task.backupId,
    "backup.task.id": task.taskId,
    "backup.task.kind": task.kind,
  }
}

export function scheduleBackupReconciliation(
  relay: PersistedRelay,
  subject?: string,
  delayMs = RECONCILE_SOON_MS
): void {
  const at = Date.now() + delayMs
  const scheduled = reconciliationTimers.get(relay.id)
  // The sooner of two readings is the one kept.
  if (scheduled && scheduled.at <= at) return
  if (scheduled) clearTimeout(scheduled.timer)
  const timer = setTimeout(() => {
    reconciliationTimers.delete(relay.id)
    void runAppEffect(
      "Backups.reconcileRelay",
      reconcileRelayBackupsEffect(relay, subject).pipe(
        Effect.catch((cause) =>
          logException(cause, {
            operation: "Backups.reconcileRelay",
            attributes: { "relay.id": relay.id },
          }).pipe(
            Effect.andThen(
              Effect.sync(() => scheduleBackupReconciliation(relay, subject))
            )
          )
        )
      )
    )
  }, delayMs)
  timer.unref()
  reconciliationTimers.set(relay.id, { at, timer })
}
