import type {
  BackupFailureCode,
  BackupTaskInput,
  RelayBackupTask,
} from "@workspace/contracts"
import { Cause, Effect, Exit, Metric } from "effect"

import { RelayBackupError } from "../effect/errors.js"
import { traceRelayEffect } from "../effect/runtime.js"
import { backupFailureCode } from "./failure.js"

/**
 * Backup work on this Relay: how each task ended and how long it and each
 * restic command took. Labels stay to small fixed sets; backup and task IDs
 * go on spans and logs, never here.
 */
const tasks = Metric.counter("relay.backup.tasks", {
  description: "Backup tasks the Relay finished, by how they ended",
  attributes: { unit: "{task}" },
  incremental: true,
})

const taskDuration = Metric.histogram("relay.backup.task.duration", {
  description: "Time a backup task ran, from its start to its end",
  attributes: { unit: "s" },
  boundaries: [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200],
})

const taskQueueTime = Metric.histogram("relay.backup.task.queue_time", {
  description: "Time a backup task waited in the queue before it started",
  attributes: { unit: "s" },
  boundaries: [0.1, 1, 5, 15, 60, 300, 900, 3600, 14400],
})

const resticDuration = Metric.histogram("relay.restic.command.duration", {
  description: "Time one restic command ran, from spawn to exit",
  attributes: { unit: "s" },
  boundaries: [0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900, 3600],
})

export type BackupTaskOutcome = "succeeded" | "failed" | "cancelled"

type BackupStorage = {
  /** Where the backup's data lives. */
  kind: "local" | "s3"
  /** A restic repository rather than a full archive. */
  restic: boolean
}

/** Where a task reads or writes its backup. */
export function backupTaskStorage(input: BackupTaskInput): BackupStorage {
  switch (input.kind) {
    case "create":
    case "delete":
      return input.destination.kind === "restic"
        ? { kind: input.destination.repository.kind, restic: true }
        : { kind: input.destination.kind, restic: false }
    case "restore":
      if (input.source.kind === "restic") {
        return { kind: input.source.repository.kind, restic: true }
      }
      return {
        kind: input.source.kind === "remote" ? "s3" : "local",
        restic: false,
      }
    case "export":
    case "prune":
      return { kind: input.repository.kind, restic: true }
  }
}

/** Span and log attributes naming a backup task. */
export function backupTaskAttributes(task: RelayBackupTask) {
  const storage = backupTaskStorage(task.input)
  return {
    "backup.id": task.backupId,
    "backup.task.id": task.taskId,
    "backup.task.kind": task.kind,
    "backup.target.kind": task.input.target.kind,
    "backup.storage.kind": storage.kind,
    "backup.storage.restic": storage.restic,
  }
}

/** Records how long a claimed task waited for its turn. */
export function recordBackupTaskQueued(
  relayId: string,
  task: RelayBackupTask,
  waitedMs: number
): Effect.Effect<void> {
  return Metric.update(
    Metric.withAttributes(taskQueueTime, {
      "relay.id": relayId,
      "backup.task.kind": task.kind,
    }),
    Math.max(0, waitedMs) / 1000
  )
}

/** Records how a task ended and how long it ran. */
export function recordBackupTask(
  relayId: string,
  task: RelayBackupTask,
  outcome: BackupTaskOutcome,
  failure: BackupFailureCode | null,
  elapsedMs: number
): Effect.Effect<void> {
  const storage = backupTaskStorage(task.input)
  const attributes = {
    "relay.id": relayId,
    "backup.task.kind": task.kind,
    "backup.storage.kind": storage.kind,
    "backup.storage.restic": String(storage.restic),
    outcome,
  }
  return Effect.all(
    [
      Metric.update(
        Metric.withAttributes(tasks, {
          ...attributes,
          "backup.failure.code": failure ?? "none",
        }),
        1
      ),
      Metric.update(
        Metric.withAttributes(taskDuration, attributes),
        elapsedMs / 1000
      ),
    ],
    { discard: true }
  )
}

/**
 * Runs one restic command in a `Restic.command` span, nested under the task
 * that ran it, and records how long it took and how it ended.
 */
export function traceResticCommand<T>(
  command: string,
  storageKind: "local" | "s3",
  run: () => Promise<T>
): Promise<T> {
  const startedAt = performance.now()
  return Effect.runPromise(
    traceRelayEffect(
      "Restic.command",
      Effect.tryPromise({ try: run, catch: (cause) => cause }).pipe(
        Effect.onExit((exit) => {
          const failure = Exit.isFailure(exit)
            ? Cause.squash(exit.cause)
            : undefined
          return Metric.update(
            Metric.withAttributes(resticDuration, {
              "restic.command": command,
              "backup.storage.kind": storageKind,
              outcome: Exit.isSuccess(exit) ? "succeeded" : "failed",
            }),
            (performance.now() - startedAt) / 1000
          ).pipe(
            Effect.andThen(
              Exit.isSuccess(exit)
                ? Effect.void
                : Effect.annotateCurrentSpan({
                    "restic.exit_code":
                      failure instanceof RelayBackupError
                        ? failure.exitCode
                        : undefined,
                    "backup.failure.code": backupFailureCode(failure),
                  })
            )
          )
        })
      ),
      { "restic.command": command, "backup.storage.kind": storageKind }
    )
  )
}
