import { randomUUID } from "node:crypto"

import { logException } from "@workspace/telemetry"
import { Cause, Clock, Effect, Fiber, Schedule } from "effect"

import {
  expiredScheduledBackupsEffect,
  scheduledBackupRelayIdsEffect,
} from "@/effect/backup-retention"
import { reserveBackupDeleteEffect } from "@/effect/backups"
import { kilnInstallationId } from "@/effect/installation"
import { promiseEffect } from "@/effect/promise"
import { forkAppWorker } from "@/effect/runtime"
import { publishBackupChange } from "@/lib/backup-realtime.server"
import { listPersistedRelaysEffect } from "@/lib/relay-registry"

// Looks after scheduled backups between runs: creates a fresh installation's
// daily Kiln backup once it can, catalogs what Relays backed up on their own,
// and deletes the backups each schedule's retention no longer keeps.

const SWEEP_INTERVAL = "10 minutes"
// A long-neglected schedule catches up over several sweeps.
const MAX_DELETES_PER_SWEEP = 50

declare global {
  var kilnScheduledBackupMaintenance: Fiber.Fiber<void> | undefined
}

const seedDefaultSchedule = Effect.fn("scheduledBackups.seedDefault")(
  function* () {
    const { redeployUnacknowledgedSchedules, seedDefaultKilnBackupSchedule } =
      yield* promiseEffect(() => import("@/server/schedule-deployment.server"))
    yield* promiseEffect(seedDefaultKilnBackupSchedule)
    // Including the one just seeded, if its Relay didn't take it.
    yield* promiseEffect(redeployUnacknowledgedSchedules)
  }
)

// A Relay makes scheduled backups on its own; Hearth catalogs them when it
// next lists the Relay's backups, which retention needs first.
const catalogScheduledBackups = Effect.fn("scheduledBackups.catalog")(
  function* () {
    const relayIds = new Set(yield* scheduledBackupRelayIdsEffect())
    const relays = (yield* listPersistedRelaysEffect()).filter(
      (relay) => relay.enabled && relayIds.has(relay.id)
    )
    const { reconcileRelayBackups } = yield* promiseEffect(
      () => import("@/lib/backup-reconciliation")
    )
    for (const relay of relays) {
      yield* promiseEffect(() => reconcileRelayBackups(relay)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`Couldn't list ${relay.name}'s backups`, cause)
        )
      )
    }
  }
)

const deleteExpiredBackups = Effect.fn("scheduledBackups.applyRetention")(
  function* () {
    yield* catalogScheduledBackups()
    const expired = yield* expiredScheduledBackupsEffect({
      installationId: kilnInstallationId(),
      now: yield* Clock.currentTimeMillis,
    })
    if (expired.length === 0) return
    const relays = new Map(
      (yield* listPersistedRelaysEffect()).map((relay) => [relay.id, relay])
    )
    const { dispatchBackupTask } = yield* promiseEffect(
      () => import("@/lib/backup-reconciliation")
    )
    // Only deletes that start count, so ones a disabled Relay or a restore
    // holds up never crowd out the rest.
    let started = 0
    for (const backup of expired) {
      if (started >= MAX_DELETES_PER_SWEEP) break
      const relay = relays.get(backup.relayId)
      if (!relay?.enabled) continue
      yield* Effect.gen(function* () {
        // Fails when it's no longer deletable, such as mid-restore, or
        // since copied elsewhere; a later sweep looks again.
        const input = yield* reserveBackupDeleteEffect({
          backupId: backup.backupId,
          onlyAt: { storageId: backup.storageId },
          requestedBy: null,
          taskId: randomUUID(),
        })
        started += 1
        publishBackupChange(relay.id, backup.backupId)
        // Undelivered, the delete waits queued; the Relay's next
        // reconciliation sends it.
        yield* promiseEffect(() => dispatchBackupTask(relay, input))
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `Retention couldn't delete backup ${backup.backupId} yet`,
            cause
          )
        )
      )
    }
  }
)

function logFailure(operation: string) {
  return Effect.catchCause((cause: Cause.Cause<unknown>) =>
    logException(Cause.squash(cause), { operation })
  )
}

export function startScheduledBackupMaintenance(): void {
  const sweep = seedDefaultSchedule().pipe(
    logFailure("scheduledBackups.seedDefault"),
    Effect.andThen(
      deleteExpiredBackups().pipe(logFailure("scheduledBackups.applyRetention"))
    )
  )
  // The first sweep waits a little, so Relays have connected.
  globalThis.kilnScheduledBackupMaintenance ??= forkAppWorker(
    Effect.sleep("1 minute").pipe(
      Effect.andThen(
        sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)))
      ),
      Effect.asVoid
    )
  )
}

export function stopScheduledBackupMaintenance(): Promise<void> {
  const worker = globalThis.kilnScheduledBackupMaintenance
  globalThis.kilnScheduledBackupMaintenance = undefined
  return worker ? Effect.runPromise(Fiber.interrupt(worker)) : Promise.resolve()
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => stopScheduledBackupMaintenance())
}
