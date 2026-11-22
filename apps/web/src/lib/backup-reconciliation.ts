import { z } from "zod"
import { Effect } from "effect"
import { logException } from "@workspace/telemetry"

import {
  relayBackupTaskSchema,
  type RelayBackupTask,
} from "@workspace/contracts"

import {
  cancelUnsentCreateEffect,
  createTaskIdentityEffect,
  createsOfDeletedBackupsEffect,
  listDispatchableBackupTasksEffect,
  reconcileBackupTaskEffect,
  settleUndispatchableBackupTaskEffect,
  type BackupDispatch,
} from "@/effect/backups"
import { isDeadlock } from "@/effect/database-deadlocks"
import { BackupStorageError, CredentialError } from "@/effect/errors"
import { promiseEffect } from "@/effect/promise"
import { forkAppEffect, runAppEffect } from "@/effect/runtime"
import {
  publishBackupChange,
  publishBackupChanges,
} from "@/lib/backup-realtime.server"
import { prepareBackupTaskEffect } from "@/lib/backup-task-prepare"
import { relayRpc } from "@/lib/relay-connection"
import { listPersistedRelays, type PersistedRelay } from "@/lib/relay-registry"

const reconciliationTimers = new Map<string, ReturnType<typeof setTimeout>>()

const relayTasksSchema = z.array(relayBackupTaskSchema)

export async function reconcileBackupsAfterRelayConnect(
  relayId: string
): Promise<void> {
  const relay = (await listPersistedRelays()).find(
    (candidate) => candidate.enabled && candidate.id === relayId
  )
  if (relay) await reconcileRelayBackups(relay)
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
      tasks,
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
    // A finished backup's bucket copies wait for Hearth to see them there.
    if (
      changed.some(
        (task) => task.kind === "create" && task.status === "succeeded"
      )
    ) {
      const { requestBucketCopyChecks } = yield* promiseEffect(
        () => import("@/lib/bucket-copy-checks.server")
      )
      requestBucketCopyChecks()
    }
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
      // The Relay holds another task under this one's ID, for another
      // backup, kind or resource: this one never arrived, and sending it
      // would only be refused. It is settled, saying so, rather than tried
      // on every pass.
      if (relayTask && !relayHoldsTask(relayTask, task)) {
        yield* settleUndispatchable(relay, task.taskId, task.backupId, {
          code: "task_identity_conflict",
          reason: "The Relay holds a different backup task under this task's ID",
        })
        continue
      }
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
    if (
      pending > 0 ||
      tasks.some((task) => task.status === "queued" || task.status === "running")
    ) {
      scheduleBackupReconciliation(relay, subject)
    }
  }
)

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
        ? cancelCreateEffect(
            relay,
            create.id,
            subject,
            relayTasksById.get(create.id)
          )
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

/**
 * Whether the task a Relay holds under an ID is the one Hearth sent under
 * it: for that backup, of that kind, for that resource.
 */
export function relayHoldsTask(
  relayTask: RelayBackupTask,
  sent: {
    backupId: string
    kind: string
    target: { id: string; kind: string }
  }
) {
  return (
    relayTask.backupId === sent.backupId &&
    relayTask.kind === sent.kind &&
    relayTask.input.target.id === sent.target.id &&
    relayTask.input.target.kind === sent.target.kind
  )
}

/**
 * A Relay's answer about the one task Hearth asked it about. An answer
 * about another is refused: applied, it would reach a record Hearth never
 * asked about.
 */
export const relayTaskReply = (reply: unknown, taskId: string) =>
  Effect.try({
    try: () => {
      const task = relayBackupTaskSchema.parse(reply)
      if (task.taskId !== taskId) {
        throw new Error("The Relay answered about another backup task")
      }
      return task
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  })

const cancelCreateEffect = Effect.fn("Backups.cancelCreate")(function* (
  relay: PersistedRelay,
  createTaskId: string,
  subject?: string,
  // What the Relay listed under the create's ID, when Hearth has read it.
  listed?: RelayBackupTask
) {
  yield* Effect.annotateCurrentSpan({
    "relay.id": relay.id,
    "backup.task.id": createTaskId,
  })
  const sent = yield* createTaskIdentityEffect(createTaskId)
  if (!sent) return
  // The Relay holds another task under the create's ID: Hearth's never
  // arrived, so nothing of it will run. It is ended here, as one that never
  // arrived is, and the delete waiting on it can go.
  const neverArrived = Effect.gen(function* () {
    // Said once, when it ends Hearth's create, not on every pass after.
    if (yield* cancelUnsentCreateEffect(createTaskId)) {
      yield* Effect.logWarning(
        "The Relay holds a different backup task under a create's ID",
        { "relay.id": relay.id, "backup.task.id": createTaskId }
      )
    }
  })
  if (listed && !relayHoldsTask(listed, sent)) return yield* neverArrived
  const reply = yield* promiseEffect(() =>
    relayRpc(
      relay,
      "backup.task.cancel",
      { backupId: sent.backupId, target: sent.target, taskId: createTaskId },
      15_000,
      subject
    )
  )
  // The Relay doesn't have it: it never arrived, so nothing will run.
  if (reply === null || reply === undefined) {
    yield* cancelUnsentCreateEffect(createTaskId)
    return
  }
  const task = yield* relayTaskReply(reply, createTaskId)
  if (!relayHoldsTask(task, sent)) return yield* neverArrived
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
  const relayInput = yield* prepareBackupTaskEffect(input).pipe(
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
  const reply = yield* promiseEffect(() =>
    relayRpc(relay, "backup.task.enqueue", relayInput, 15_000, subject)
  )
  // Read back again whatever it answered: an answer about another task is
  // refused below, and the Relay's list then says where this one stands.
  scheduleBackupReconciliation(relay, subject)
  const task = yield* relayTaskReply(reply, input.taskId)
  if (yield* reconcileBackupTaskEffect(task, relay.id)) {
    publishBackupChange(relay.id, task.backupId)
    if (task.kind === "create" && task.status === "succeeded") {
      const { requestBucketCopyChecks } = yield* promiseEffect(
        () => import("@/lib/bucket-copy-checks.server")
      )
      requestBucketCopyChecks()
    }
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

// A scheduled pass over a Relay's backups runs one at a time per Relay:
// asked for while one runs, another follows it once, however often it was
// asked for meanwhile.
const reconciling = new Set<string>()
const reconcileAgain = new Set<string>()

export function scheduleBackupReconciliation(
  relay: PersistedRelay,
  subject?: string
): void {
  if (reconciliationTimers.has(relay.id)) return
  if (reconciling.has(relay.id)) {
    reconcileAgain.add(relay.id)
    return
  }
  const timer = setTimeout(() => {
    reconciliationTimers.delete(relay.id)
    reconciling.add(relay.id)
    // A fiber of its own: stopped with the app, as on shutdown, it leaves
    // no promise to reject.
    forkAppEffect(
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
        ),
        Effect.ensuring(
          Effect.sync(() => {
            reconciling.delete(relay.id)
            if (reconcileAgain.delete(relay.id)) {
              scheduleBackupReconciliation(relay, subject)
            }
          })
        )
      )
    )
  }, 1_000)
  timer.unref()
  reconciliationTimers.set(relay.id, timer)
}
