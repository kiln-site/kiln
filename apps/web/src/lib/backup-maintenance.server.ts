import { randomUUID } from "node:crypto"

import { logException } from "@workspace/telemetry"
import { Cause, Clock, Effect, Fiber, Schedule } from "effect"

import {
  expiredBackupsEffect,
  scheduledBackupRelayIdsEffect,
} from "@/effect/backup-retention"
import {
  interruptedBackupDeletesEffect,
  reserveBackupDeleteEffect,
} from "@/effect/backups"
import { promiseEffect } from "@/effect/promise"
import { forkAppWorker } from "@/effect/runtime"
import { backupKey } from "@/lib/backup-lanes"
import { publishBackupChange } from "@/lib/backup-realtime.server"
import {
  listPersistedRelaysEffect,
  type PersistedRelay,
} from "@/lib/relay-registry"
import { outsideOperation } from "@/operations/current"
import { exclusive } from "@/operations/lanes"
import { inLanes } from "@/operations/operation"

// Looks after backups between runs: creates a fresh installation's daily
// Kiln backup once it can, catalogs what Relays backed up on their own, and
// deletes the backups each target's retention no longer keeps. It sweeps on
// an interval, and soon after a backup finishes or a retention changes.

const SWEEP_INTERVAL = "10 minutes"
// Coalesces the backups and edits that ask for a sweep around the same time.
const REQUESTED_SWEEP_DELAY_MS = 5_000
// A target long over its retention catches up over several sweeps.
const MAX_DELETES_PER_SWEEP = 50

declare global {
  var kilnBackupMaintenance: Fiber.Fiber<void> | undefined
  var kilnBackupRetentionRequest: ReturnType<typeof setTimeout> | undefined
}

const seedDefaultSchedule = Effect.fn("backupMaintenance.seedDefault")(
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
const catalogScheduledBackups = Effect.fn("backupMaintenance.catalog")(
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

// Deletes one backup as Hearth's own work, holding it as a person deleting
// or restoring it does, so it waits for them rather than racing them.
// Whether a delete started: one no longer deletable, such as mid-restore,
// doesn't, and a later sweep looks again.
const deleteBackup = (
  name: "backup.delete.resume" | "backup.retention.delete",
  relay: PersistedRelay,
  backupId: string,
  unanswering?: Set<string>
) =>
  inLanes(
    name,
    "Deleting this backup",
    [exclusive(backupKey(backupId))],
    Effect.gen(function* () {
      // Taken up again only if it still wants it: the operation it waited
      // for here may have seen the delete through, or ended it.
      if (name === "backup.delete.resume") {
        const [interrupted] = yield* interruptedBackupDeletesEffect({
          backupId,
          limit: 1,
          relayIds: [relay.id],
        })
        if (!interrupted) return false
      }
      const reservation = yield* reserveBackupDeleteEffect({
        backupId,
        requestedBy: null,
        taskId: randomUUID(),
      })
      publishBackupChange(relay.id, backupId)
      // Neither expires a backup still being made, so none waits on a
      // create.
      if (reservation.kind === "dispatch") {
        const { carryOutBackupDelete } = yield* promiseEffect(
          () => import("@/lib/backup-reconciliation")
        )
        yield* promiseEffect(() =>
          carryOutBackupDelete(relay, reservation, { unanswering })
        )
      }
      return true
    })
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`Couldn't delete backup ${backupId} yet`, cause).pipe(
        Effect.as(false)
      )
    )
  )

const applyRetention = Effect.fn("backupMaintenance.applyRetention")(
  function* () {
    const relays = new Map(
      (yield* listPersistedRelaysEffect()).map((relay) => [relay.id, relay])
    )
    // Deletes Hearth stopped in the middle of, before more are started.
    const interrupted = yield* interruptedBackupDeletesEffect({
      limit: MAX_DELETES_PER_SWEEP,
      relayIds: [...relays.values()].flatMap((relay) =>
        relay.enabled ? [relay.id] : []
      ),
    })
    for (const backup of interrupted) {
      const relay = relays.get(backup.relayId)
      if (relay) yield* deleteBackup("backup.delete.resume", relay, backup.backupId)
    }
    // Destinations that didn't answer in this sweep, which it doesn't ask
    // again: one that is down costs it one wait.
    const unanswering = new Set<string>()
    const expired = yield* expiredBackupsEffect(yield* Clock.currentTimeMillis)
    // Only deletes that start count, so ones a disabled Relay or a restore
    // holds up never crowd out the rest.
    let started = 0
    for (const backup of expired) {
      if (started >= MAX_DELETES_PER_SWEEP) break
      const relay = relays.get(backup.relayId)
      if (!relay?.enabled) continue
      if (
        yield* deleteBackup(
          "backup.retention.delete",
          relay,
          backup.backupId,
          unanswering
        )
      ) {
        started += 1
      }
    }
  }
)

function logFailure(operation: string) {
  return Effect.catchCause((cause: Cause.Cause<unknown>) =>
    logException(Cause.squash(cause), { operation })
  )
}

const applyRetentionLogged = Effect.suspend(applyRetention).pipe(
  logFailure("backupMaintenance.applyRetention")
)

export function startBackupMaintenance(): void {
  const sweep = seedDefaultSchedule().pipe(
    logFailure("backupMaintenance.seedDefault"),
    Effect.andThen(
      catalogScheduledBackups().pipe(logFailure("backupMaintenance.catalog"))
    ),
    Effect.andThen(applyRetentionLogged)
  )
  // The first sweep waits a little, so Relays have connected.
  globalThis.kilnBackupMaintenance ??= forkAppWorker(
    Effect.sleep("1 minute").pipe(
      Effect.andThen(
        sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)))
      ),
      Effect.asVoid
    )
  )
}

/**
 * Applies retention soon: after a backup finishes, or a target's retention
 * changes. Requests close together share one pass.
 */
export function requestBackupRetention(): void {
  if (globalThis.kilnBackupRetentionRequest) return
  // Asked for by an operation, such as changing a retention, which doesn't
  // wait for the sweep: it takes its own lanes.
  const timer = outsideOperation(() =>
    setTimeout(() => {
      globalThis.kilnBackupRetentionRequest = undefined
      forkAppWorker(applyRetentionLogged)
    }, REQUESTED_SWEEP_DELAY_MS)
  )
  timer.unref()
  globalThis.kilnBackupRetentionRequest = timer
}

export function stopBackupMaintenance(): Promise<void> {
  const worker = globalThis.kilnBackupMaintenance
  globalThis.kilnBackupMaintenance = undefined
  clearTimeout(globalThis.kilnBackupRetentionRequest)
  globalThis.kilnBackupRetentionRequest = undefined
  return worker ? Effect.runPromise(Fiber.interrupt(worker)) : Promise.resolve()
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => stopBackupMaintenance())
}
