import { z } from "zod"
import { Effect } from "effect"

import { relayBackupTaskSchema } from "@workspace/contracts"

import {
  listDispatchableBackupTasksEffect,
  reconcileBackupTaskEffect,
  type BackupDispatch,
} from "@/effect/backups"
import { runAppEffect } from "@/effect/runtime"
import { publishBackupChange } from "@/lib/backup-realtime.server"
import { prepareBackupTaskEffect } from "@/lib/backup-task-prepare"
import { relayRpc } from "@/lib/relay-connection"
import { listPersistedRelays, type PersistedRelay } from "@/lib/relay-registry"

const reconciliationTimers = new Map<string, ReturnType<typeof setTimeout>>()

export async function reconcileBackupsAfterRelayConnect(
  relayId: string
): Promise<void> {
  const relay = (await listPersistedRelays()).find(
    (candidate) => candidate.enabled && candidate.id === relayId
  )
  if (relay) await reconcileRelayBackups(relay)
}

export async function reconcileRelayBackups(
  relay: PersistedRelay,
  subject?: string
): Promise<void> {
  // Import Relay state first so interrupted tasks can be refreshed and
  // redispatched during this same reconciliation pass.
  const tasks = z
    .array(relayBackupTaskSchema)
    .parse(await relayRpc(relay, "backup.task.list", {}, 15_000, subject))
  const relayTasksById = new Map(tasks.map((task) => [task.taskId, task]))
  const reconciled = await Promise.all(
    tasks.map((task) =>
      runAppEffect(
        "backups.reconcileTask",
        reconcileBackupTaskEffect(task, relay.id)
      )
    )
  )
  reconciled.forEach((changed, index) => {
    const backupId = tasks[index]?.backupId
    if (changed && backupId) publishBackupChange(relay.id, backupId)
  })
  const dispatchable = await runAppEffect(
    "backups.dispatchable",
    listDispatchableBackupTasksEffect(relay.id)
  )
  for (const task of dispatchable) {
    const relayTask = relayTasksById.get(task.taskId)
    if (relayTask && !relayTask.inputRefreshRequired) continue
    await dispatchBackupTask(relay, task, subject)
  }
  const [instanceDeletion, databaseDeletion] = await Promise.all([
    import("@/lib/final-instance-deletion"),
    import("@/lib/final-database-deletion"),
  ])
  const [instancesPending, databasesPending] = await Promise.all([
    instanceDeletion.processFinalInstanceDeletions(relay),
    databaseDeletion.processFinalDatabaseDeletions(relay),
  ])
  if (
    instancesPending ||
    databasesPending ||
    dispatchable.length > 0 ||
    tasks.some((task) => task.status === "queued" || task.status === "running")
  ) {
    scheduleBackupReconciliation(relay, subject)
  }
}

export async function dispatchBackupTask(
  relay: PersistedRelay,
  input: BackupDispatch,
  subject?: string
): Promise<void> {
  const relayInput = await runAppEffect(
    "backups.prepareDispatch",
    prepareBackupTaskEffect(input)
  )
  const task = relayBackupTaskSchema.parse(
    await relayRpc(relay, "backup.task.enqueue", relayInput, 15_000, subject)
  )
  scheduleBackupReconciliation(relay, subject)
  const changed = await runAppEffect(
    "backups.reconcileEnqueue",
    reconcileBackupTaskEffect(task, relay.id)
  )
  if (changed) publishBackupChange(relay.id, task.backupId)
}

export { prepareBackupTaskEffect }

export function scheduleBackupReconciliation(
  relay: PersistedRelay,
  subject?: string
): void {
  if (reconciliationTimers.has(relay.id)) return
  const timer = setTimeout(() => {
    reconciliationTimers.delete(relay.id)
    void Effect.runPromise(
      Effect.tryPromise({
        try: () => reconcileRelayBackups(relay, subject),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            console.error(
              `Could not continue backup reconciliation on Relay ${relay.id}`,
              cause
            )
            scheduleBackupReconciliation(relay, subject)
          })
        )
      )
    )
  }, 1_000)
  timer.unref()
  reconciliationTimers.set(relay.id, timer)
}
