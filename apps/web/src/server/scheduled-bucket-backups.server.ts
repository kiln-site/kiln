import { Effect, Schema } from "effect"

import type { BackupArtifactKind, BackupTargetKind } from "@workspace/contracts"
import {
  resolveScheduleBackupName,
  scheduledBackupId,
  scheduleStableId,
  type ScheduledBucketBackupReply,
  type ScheduledBucketBackupRequest,
} from "@workspace/contracts/schedules"

import { reserveScheduledBucketBackupsEffect } from "@/effect/backups"
import { BackupStorageError } from "@/effect/errors"
import { kilnInstallationId } from "@/effect/installation"
import { promiseEffect } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { backupStorageSettingsKey, backupTargetKey } from "@/lib/backup-lanes"
import { publishBackupChanges } from "@/lib/backup-realtime.server"
import { scheduleBackupReconciliation } from "@/lib/backup-reconciliation"
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
      relay,
      request.members
    )
  )
  if (!step) {
    return yield* refuse(
      "Hearth has no step sending this Relay's backups to a bucket here"
    )
  }
  const { action, scheduleName, storageId } = step
  const stopped = action.consistency === "stopped"
  const batchId = request.batchId ?? null
  const members = new Map(
    request.members.map((member) => [
      `${member.targetKind}:${member.targetId}`,
      member,
    ])
  )
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
    const backupId = scheduledBackupId({
      ...member,
      actionId: action.id,
      scheduledAt: request.scheduledAt,
      scheduleId: request.scheduleId,
    })
    backups.push({
      artifactKind: artifactKinds[targetKind],
      backupId,
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
    })
  }
  return { backups, relay, storageId }
})

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
  run: ({ context, input }) =>
    reserveScheduledBucketBackupsEffect({
      backups: context.backups,
      relayId: input.relayId,
      storageId: context.storageId,
    }).pipe(Effect.as(context.relay)),
  publish: ({ context, input }) =>
    publishBackupChanges(
      input.relayId,
      context.backups.map(({ backupId }) => backupId)
    ),
})

/**
 * Answers a Relay that asked Hearth to take a step's bucket backups: taken,
 * all of them, and on their way to it as tasks; or none, and why.
 */
export function takeScheduledBucketBackups(
  relayId: string,
  request: ScheduledBucketBackupRequest
): Promise<ScheduledBucketBackupReply> {
  return runAppEffect(
    "ScheduledBackups.take",
    runOperation(takeBackups, { relayId, request }, { user: null }).pipe(
      Effect.map((relay: PersistedRelay): ScheduledBucketBackupReply => {
        // Sent as every queued backup is, on the Relay's next pass.
        scheduleBackupReconciliation(relay)
        return { taken: true }
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
  )
}
