import { z } from "zod"
import { Effect } from "effect"
import { logException } from "@workspace/telemetry"

import {
  relayBackupTaskSchema,
  type RelayBackupTask,
} from "@workspace/contracts"

import {
  cancelUnsentCreateEffect,
  createsOfDeletedBackupsEffect,
  listDispatchableBackupTasksEffect,
  reconcileBackupTaskEffect,
  settleUndispatchableBackupTaskEffect,
  type BackupDispatch,
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
import { relayConnected, relayRpc } from "@/lib/relay-connection"
import { listPersistedRelays, type PersistedRelay } from "@/lib/relay-registry"

const reconciliationTimers = new Map<string, ReturnType<typeof setTimeout>>()

const relayTasksSchema = z.array(relayBackupTaskSchema)

export function reconcileBackupsAfterRelayConnect(
  relayId: string
): Promise<void> {
  return runAppEffect(
    "Backups.reconcileRelay",
    reconcileAfterConnectEffect(relayId)
  )
}

// The Relay as it is now, looked up each time: one that has moved is
// reached where it is, and one disabled or removed is left alone.
const reconcileAfterConnectEffect = (relayId: string) =>
  Effect.gen(function* () {
    const relay = (yield* promiseEffect(listPersistedRelays)).find(
      (candidate) => candidate.enabled && candidate.id === relayId
    )
    if (!relay) return
    yield* reconcileRelayBackupsEffect(relay)
  }).pipe(
    // A pass that fails anywhere, as when the Relay's tasks, or Hearth's
    // own record of the Relay, can't be read just after it connects, is
    // tried again. Nothing else reads its tasks for a Relay no schedule
    // backs up, and until they are read a delete that failed there still
    // looks under way, and a copy it sent has no size or checksum to be
    // restored by.
    Effect.tapError(() => Effect.sync(() => retryAfterConnect(relayId))),
    Effect.tap(() => Effect.sync(() => connectRetryCounts.delete(relayId)))
  )

const connectRetries = new Map<string, ReturnType<typeof setTimeout>>()
const connectRetryCounts = new Map<string, number>()
const CONNECT_RETRY_MS = 5_000
const CONNECT_RETRY_MAX_MS = 60_000

// Tries a Relay's first pass again a little later, one try at a time and
// further apart each time, for as long as the Relay stays connected. One
// that has gone again starts over as it next connects.
function retryAfterConnect(relayId: string): void {
  if (connectRetries.has(relayId)) return
  const tried = connectRetryCounts.get(relayId) ?? 0
  connectRetryCounts.set(relayId, tried + 1)
  const timer = setTimeout(
    () => {
      connectRetries.delete(relayId)
      if (!relayConnected(relayId)) {
        connectRetryCounts.delete(relayId)
        return
      }
      void runAppEffect(
        "Backups.reconcileRelay",
        reconcileAfterConnectEffect(relayId).pipe(
          Effect.catch((cause) =>
            logException(cause, {
              operation: "Backups.reconcileRelay",
              attributes: { "relay.id": relayId },
            })
          )
        )
      )
    },
    Math.min(CONNECT_RETRY_MAX_MS, CONNECT_RETRY_MS * 2 ** Math.min(tried, 4))
  )
  timer.unref()
  connectRetries.set(relayId, timer)
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
  subject?: string
): void {
  if (reconciliationTimers.has(relay.id)) return
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
  }, 1_000)
  timer.unref()
  reconciliationTimers.set(relay.id, timer)
}
