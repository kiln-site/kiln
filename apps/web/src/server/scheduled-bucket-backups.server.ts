import { createHmac } from "node:crypto"

import { Effect, Option, Schema, Semaphore } from "effect"
import type { RowDataPacket } from "mysql2/promise"

import type { BackupArtifactKind, BackupTargetKind } from "@workspace/contracts"
import {
  resolveScheduleBackupName,
  scheduleStableId,
  type ScheduledBucketBackupReply,
  type ScheduledBucketBackupRequest,
} from "@workspace/contracts/schedules"

import {
  listDispatchableBackupTasksEffect,
  reserveScheduledBucketBackupsEffect,
  type BackupDispatch,
} from "@/effect/backups"
import { Database } from "@/effect/database"
import { BackupStorageError } from "@/effect/errors"
import { kilnInstallationId } from "@/effect/installation"
import { promiseEffect } from "@/effect/promise"
import { forkAppEffect, runAppEffect } from "@/effect/runtime"
import { backupStorageSettingsKey, backupTargetKey } from "@/lib/backup-lanes"
import { databaseTable } from "@/lib/database-config"
import { betterAuthSecrets } from "@/lib/environment"
import { publishBackupChanges } from "@/lib/backup-realtime.server"
import {
  dispatchBackupTask,
  scheduleBackupReconciliation,
} from "@/lib/backup-reconciliation"
import { scheduleSettingsKey } from "@/lib/schedule-lanes"
import { listPersistedRelays, type PersistedRelay } from "@/lib/relay-registry"
import { shared } from "@/operations/lanes"
import {
  OperationBusyError,
  operation,
  runOperation,
} from "@/operations/operation"
import { scheduledBucketBackupStep } from "@/server/schedule-deployment.server"

// A schedule's full backups to a bucket. A Relay runs its schedules on its
// own, but only Hearth holds a bucket's keys, so when such a backup is due
// the Relay asks Hearth to take it. Hearth catalogs it and sends its task as
// it sends a manual backup's, signed upload and all; nothing of the bucket
// is ever the Relay's to hold or to say.

/** Why Hearth won't take what a Relay asked for, in words for its run. */
class ScheduledBackupRefused extends Schema.TaggedError<ScheduledBackupRefused>()(
  "ScheduledBackupRefused",
  { message: Schema.String }
) {}

const refuse = (message: string) => new ScheduledBackupRefused({ message })

interface Ask {
  /** The Relay asking, as its connection says, never as it says itself. */
  readonly relayId: string
  readonly request: ScheduledBucketBackupRequest
}

// The IDs a take gives what it catalogs, from the Relay asking, the run
// and what it backs up, keyed with Hearth's own secret: the same on every
// ask of one run, so asking again takes nothing twice, and none a Relay can
// work out ahead of Hearth to take first.
function takenId(...parts: ReadonlyArray<string | number>) {
  const [current] = betterAuthSecrets()
  const hex = createHmac("sha256", current!.value)
    .update(["kiln-scheduled-take", ...parts].join("\u001f"))
    .digest("hex")
    .slice(0, 32)
    .split("")
  hex[12] = "8"
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  const id = hex.join("")
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`
}

const artifactKinds = {
  database: "database_dump",
  instance: "archive",
  platform: "platform_bundle",
  volume: "tar_archive",
} as const satisfies Partial<Record<BackupTargetKind, BackupArtifactKind>>

// What the Relay asked for, read against Hearth's own schedule: the step
// must be one Hearth has for that Relay, sending full backups to a bucket,
// and each thing one the step backs up there and may, as Hearth would tell
// the Relay if it sent the schedule now. The Relay says only which run is
// due; the rest is Hearth's.
const admit = Effect.fn("ScheduledBackups.admit")(function* ({
  relayId,
  request,
}: Ask) {
  const relay = (yield* promiseEffect(listPersistedRelays)).find(
    (candidate) => candidate.enabled && candidate.id === relayId
  )
  if (!relay) return yield* refuse("Hearth doesn't know this Relay")
  const step = yield* promiseEffect(() =>
    scheduledBucketBackupStep(
      request.scheduleId,
      request.actionId,
      request.revision,
      relay,
      request.members
    )
  )
  if (step === "stale") return yield* refuse(stalePlan)
  if (!step) {
    return yield* refuse(
      "Hearth has no step sending this Relay's backups to a bucket here"
    )
  }
  const { action, scheduleName, storageId } = step
  const stopped = action.consistency === "stopped"
  const members = new Map(
    request.members.map((member) => [
      `${member.targetKind}:${member.targetId}`,
      member,
    ])
  )
  // Every target of a batch asks for all of it, so its name is the same
  // from each.
  const batchId = request.together
    ? takenId(
        "batch",
        relayId,
        request.scheduleId,
        action.id,
        request.scheduledAt,
        [...members.keys()].sort().join(",")
      )
    : null
  const backups = []
  for (const member of members.values()) {
    const execution = action.executions.find(
      ({ targetId, targetKind }) =>
        targetKind === member.targetKind && targetId === member.targetId
    )
    if (!execution) {
      return yield* refuse("This step doesn't back that up on this Relay")
    }
    if (execution.refusal || execution.destination?.kind !== "s3") {
      return yield* refuse(
        `Hearth won't take this backup: ${execution.refusal ?? "its destination is unavailable"}`
      )
    }
    const targetKind: keyof typeof artifactKinds =
      member.targetKind === "relay" ? "platform" : member.targetKind
    const backupId = takenId(
      "backup",
      relayId,
      request.scheduleId,
      action.id,
      request.scheduledAt,
      member.targetKind,
      member.targetId
    )
    backups.push({
      artifactId: takenId("artifact", backupId),
      artifactKind: artifactKinds[targetKind],
      backupId,
      // As the Relay asked for it, to answer it so.
      member,
      // Volumes are cataloged as the batch they were asked in, live or
      // stopped; a database only as one it stops within.
      batchId:
        targetKind === "volume" || (targetKind === "database" && stopped)
          ? batchId
          : null,
      consistency:
        targetKind === "volume"
          ? stopped
            ? ("stopped" as const)
            : ("live" as const)
          : targetKind === "database" && stopped && batchId
            ? ("stopped" as const)
            : null,
      maxBytes: execution.maxBytes ?? null,
      name: resolveScheduleBackupName(action.name, {
        backupId,
        // A volume's is named for the first App that uses it.
        instanceId:
          targetKind === "instance"
            ? member.targetId
            : targetKind === "volume"
              ? ([...(execution.appIds ?? [])].sort()[0] ?? member.targetId)
              : "",
        runId: scheduleStableId(
          request.scheduleId,
          request.scheduledAt,
          relayId
        ),
        scheduleId: request.scheduleId,
        scheduleName,
        timestamp: request.scheduledAt,
      }),
      targetId:
        targetKind === "platform" ? kilnInstallationId() : member.targetId,
      targetKind,
      taskId: takenId("task", backupId),
    })
  }
  return { backups, relay, storageId }
})

const stalePlan =
  "This schedule was saved after the run started; its next run is taken as saved"

const takeBackups = operation<Ask>()({
  name: "backup.scheduled.take",
  doing: "Taking a schedule's backups",
  authorize: ({ input }) => admit(input),
  // The Relay's step waits on the answer, so what is in its way refuses it
  // now, saying what, rather than taking the backup after the step gave up.
  onlyIfFree: true,
  // Held as a manual backup holds them: what each backs up, and the
  // destination, so neither is deleted or changed while it is reserved;
  // and the schedule as running it does, so it isn't saved meanwhile.
  locks: ({ context, input }) => [
    shared(scheduleSettingsKey(input.request.scheduleId)),
    ...[
      ...new Set(
        context.backups.map(({ targetId, targetKind }) =>
          backupTargetKey(input.relayId, { id: targetId, kind: targetKind })
        )
      ),
    ].map((key) => shared(key)),
    shared(backupStorageSettingsKey(context.storageId)),
  ],
  // Checked again under the schedule's lane, which a save takes whole: one
  // saved after it was first read, before its lanes were free, is refused.
  // The step as first read is otherwise what is taken; a destination is
  // checked again as it is reserved.
  run: ({ context, input }) =>
    Effect.gen(function* () {
      const database = yield* Database
      const [schedule] = yield* database.queryRows<
        { revision: number } & RowDataPacket
      >(
        "backup_scheduled_take_revision",
        `SELECT revision FROM ${databaseTable("schedule")}
          WHERE id = ? AND deleted_at IS NULL`,
        [input.request.scheduleId]
      )
      if (schedule?.revision !== input.request.revision) {
        return yield* refuse(stalePlan)
      }
      const made = yield* reserveScheduledBucketBackupsEffect({
        backups: context.backups,
        relayId: input.relayId,
        storageId: context.storageId,
      })
      return {
        backupIds: made,
        relay: context.relay,
        taken: context.backups.map(({ backupId, member, taskId }) => ({
          ...member,
          backupId,
          taskId,
        })),
      }
    }),
  publish: ({ context, input }) =>
    publishBackupChanges(
      input.relayId,
      context.backups.map(({ backupId }) => backupId)
    ),
})

// Sends the tasks of the backups just made, each on its own, together, so a
// stopped batch reaches the Relay whole. A Relay's control connection takes
// 32 requests at once, which other work shares, so a large batch goes 16 at
// a time. One that fails is left for the Relay's next pass.
const sendTaken = (relay: PersistedRelay, backupIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const taken = new Set(backupIds)
    const dispatches = (yield* listDispatchableBackupTasksEffect(
      relay.id
    )).filter(
      (task): task is BackupDispatch =>
        task.kind !== "undispatchable" && taken.has(task.backupId)
    )
    yield* Effect.forEach(
      dispatches,
      (task) =>
        promiseEffect(() => dispatchBackupTask(relay, task)).pipe(
          Effect.catch(() => Effect.void)
        ),
      { concurrency: 16, discard: true }
    )
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Sending a schedule's taken backups failed", cause)
    )
  )

// How many takes of one Relay Hearth works on at once, how many more wait
// for a turn, and how long one waits: the Relay waits 30 s for an answer.
// A take holds its turn from before it reads anything for it until the
// tasks it made are first sent (a later pass over the Relay's backups runs
// outside it); one past those waiting is refused at once. So one Relay's
// asks can't swamp Hearth, however many it sends.
const takesPerRelay = 4
const takesWaitingPerRelay = 12
const takeTurnWaitMs = 20_000
const takeTurns = new Map<string, Semaphore.Semaphore>()
const takesWaiting = new Map<string, number>()
const busy = {
  reason:
    "Hearth is busy with this Relay's other scheduled backups; its next run is taken as usual",
  taken: false,
} satisfies ScheduledBucketBackupReply
const turnsOf = (relayId: string) => {
  let turns = takeTurns.get(relayId)
  if (!turns) {
    turns = Semaphore.makeUnsafe(takesPerRelay)
    takeTurns.set(relayId, turns)
  }
  return turns
}

/**
 * Answers a Relay that asked Hearth to take a step's bucket backups: taken,
 * all of them, each by the IDs Hearth gave it, and on their way to it as
 * tasks; or none, and why.
 */
export function takeScheduledBucketBackups(
  relayId: string,
  request: ScheduledBucketBackupRequest
): Promise<ScheduledBucketBackupReply> {
  const turns = turnsOf(relayId)
  const release = Semaphore.release(turns, 1)
  return runAppEffect(
    "ScheduledBackups.take",
    Effect.gen(function* () {
      const waiting = takesWaiting.get(relayId) ?? 0
      if (waiting >= takesWaitingPerRelay) return busy
      takesWaiting.set(relayId, waiting + 1)
      const turn = yield* Semaphore.take(turns, 1).pipe(
        Effect.timeoutOption(`${takeTurnWaitMs} millis`),
        Effect.ensuring(
          Effect.sync(() =>
            takesWaiting.set(relayId, (takesWaiting.get(relayId) ?? 1) - 1)
          )
        )
      )
      if (Option.isNone(turn)) return busy
      return yield* runOperation(
        takeBackups,
        { relayId, request },
        { user: null }
      ).pipe(
        Effect.onError(() => release),
        Effect.map(({ backupIds, relay, taken }): ScheduledBucketBackupReply => {
          // Sent at once and together, as a manual run's are, so a stopped
          // batch reaches the Relay whole; any not sent now go on the
          // Relay's next pass, as every queued backup does. Its turn ends
          // once they are sent.
          forkAppEffect(
            "ScheduledBackups.dispatch",
            sendTaken(relay, backupIds).pipe(Effect.ensuring(release))
          )
          scheduleBackupReconciliation(relay)
          return { backups: taken, taken: true }
        }),
        Effect.catchIf(
          (cause) =>
            cause instanceof ScheduledBackupRefused ||
            cause instanceof BackupStorageError ||
            cause instanceof OperationBusyError,
          (cause) =>
            Effect.succeed<ScheduledBucketBackupReply>({
              reason: cause.message.slice(0, 300),
              taken: false,
            })
        )
      )
    })
  )
}
