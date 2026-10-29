import { randomUUID } from "node:crypto"

import {
  backupUnfinishedRestoresSchema,
  relayVolumesSchema,
  type BackupConsistency,
  type BackupTarget,
  type BackupUnfinishedRestore,
  type RelayVolumes,
} from "@workspace/contracts"

import { loadBackupStorageEffect } from "@/backups/destinations/s3"
import {
  getBackupForTaskEffect,
  listTargetBackupsEffect,
  reserveBackupBatchEffect,
  type BackupCatalogRecord,
} from "@/effect/backups"
import { loadAppConfigEffect } from "@/effect/managed-apps"
import { recoverPromise } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { isPlatformAdmin, listUserGrants } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { publishBackupChange } from "@/lib/backup-realtime.server"
import {
  dispatchBackupTask,
  reconcileRelayBackups,
} from "@/lib/backup-reconciliation"
import type { BackupRun } from "@/lib/backup-runs"
import { resolveBackupStorageSelection } from "@/lib/backup-storage-selection.server"
import { grantsAllowBackup } from "@/lib/backup-target-permissions"
import { relayRpc } from "@/lib/relay-connection"
import {
  activeRelay,
  listPersistedRelays,
  type PersistedRelay,
} from "@/lib/relay-registry"
import {
  requireAppsPermission,
  requireBackupTargetPermission,
  requireBackupTargetRestore,
} from "@/server/backup-target-access.server"

// Server-only work behind an App's backup settings and unfinished restores; the
// server functions in ./backups authenticate the caller first.

type ResourceTarget = BackupTarget & { kind: "app" | "volume" }

/** What an App's backup settings show: what's backed up, and what isn't. */
export async function getAppBackupsHandler(
  user: AuthenticatedUser,
  data: { appId: string; relayId: string }
) {
  const relay = await activeRelay(data.relayId)
  await requireBackupTargetPermission(
    user,
    relay.id,
    { id: data.appId, kind: "app" },
    "backup.read"
  )
  const [listing, unfinished] = await Promise.all([
    recoverPromise(
      () => readRelayVolumes(relay, user.id),
      () => null
    ),
    unfinishedRestores(relay, user.id),
  ])
  const targets = appTargets(data.appId, listing)
  const { batch, latest, restores } = await runAppEffect(
    "backups.appTargets",
    listTargetBackupsEffect(relay.id, targets)
  )
  const same = (left: BackupTarget, right: BackupTarget) =>
    left.kind === right.kind && left.id === right.id
  return {
    // The Relay's volumes, unless it couldn't be asked.
    available: listing !== null,
    batch: batch.map(publicBackup),
    targets: targets.map((target) => {
      const backup = latest.find((record) =>
        same(target, { id: record.targetId, kind: record.targetKind })
      )
      return {
        ...target,
        latest: backup ? publicBackup(backup) : null,
        restore: (() => {
          const restore = restores.find((record) =>
            same(target, { id: record.targetId, kind: record.targetKind })
          )
          return restore ? publicBackup(restore) : null
        })(),
        unfinished:
          unfinished.find((restore) => same(target, restore.target)) ?? null,
      }
    }),
    uncovered:
      listing?.uncovered.filter((mount) => mount.appId === data.appId) ?? [],
    // Kiln volumes it uses, which are backed up on their own.
    used:
      listing?.volumes.flatMap((volume) =>
        volume.kind === "kiln" &&
        volume.id !== null &&
        volume.users.some((user) => user.appId === data.appId)
          ? [{ id: volume.id, name: volume.name }]
          : []
      ) ?? [],
  }
}

/**
 * Backs up an App: its folder and each volume its Compose project owns, each
 * a backup of its own, started together as one batch. Stopped, each stops
 * and starts again every App that uses what it backs up.
 */
export async function createAppBackupsHandler(
  user: AuthenticatedUser,
  data: {
    appId: string
    consistency: BackupConsistency
    name: string
    relayId: string
    storageIds?: Array<string | null> | undefined
  }
) {
  const relay = await activeRelay(data.relayId)
  const app = { id: data.appId, kind: "app" as const }
  await requireBackupTargetPermission(user, relay.id, app, "backup.create")
  if (
    !(await runAppEffect(
      "backups.appTarget",
      loadAppConfigEffect(relay.id, data.appId)
    ))
  ) {
    throw new Error("App not found on this Relay")
  }
  const listing = await readRelayVolumes(relay, user.id)
  const targets = appTargets(data.appId, listing)
  if (data.consistency === "stopped") {
    if (!listing.protection.ready) {
      throw new Error(
        `The Relay doesn't know yet which Apps use this App's volumes${listing.protection.reason ? `: ${listing.protection.reason}` : ""}`
      )
    }
    const users = new Set([data.appId])
    for (const volume of listing.volumes) {
      if (!targets.some((target) => target.id === volume.id)) continue
      for (const user of volume.users) users.add(user.appId)
    }
    await requireAppsPermission(
      user,
      relay.id,
      [...users],
      "app.manage",
      "A stopped backup stops and starts every App that uses what it backs up; you need permission to manage each"
    )
  }
  const storageIds = await resolveBackupStorageSelection({
    relayId: relay.id,
    storageIds: data.storageIds,
    targetId: data.appId,
    targetKind: "app",
  })
  await requirePersonalStorage(storageIds, user, relay.id, app)
  const batchId = randomUUID()
  // All of the App's backups, or none: one refused, as by a ceiling of no
  // backups, refuses the batch rather than leave it short of a member.
  const reserved = await runAppEffect(
    "backups.reserveAppBatch",
    reserveBackupBatchEffect(
      targets.map((target) => ({
        artifactKind: "tar_archive" as const,
        backupId: randomUUID(),
        batchId,
        batchSize: targets.length,
        consistency: data.consistency,
        createdBy: user.id,
        exclude: [],
        mode: "full" as const,
        name: data.name,
        relayId: relay.id,
        requestedMaxBytes: null,
        storageIds,
        targetId: target.id,
        targetKind: target.kind,
        taskId: randomUUID(),
      }))
    )
  )
  for (const input of reserved) publishBackupChange(relay.id, input.backupId)
  const dispatched = await Promise.allSettled(
    reserved.map((input) => dispatchBackupTask(relay, input, user.id))
  )
  return {
    backupIds: reserved.map((input) => input.backupId),
    batchId,
    relayAccepted: dispatched.every((result) => result.status === "fulfilled"),
  }
}

/**
 * Restores of Apps' folders and volumes whose swap didn't finish, fencing
 * their targets, on every Relay the user can see backups of them on.
 */
export async function listUnfinishedRestoresHandler(user: AuthenticatedUser) {
  const relays = (await listPersistedRelays()).filter((relay) => relay.enabled)
  const admin = isPlatformAdmin(user)
  const grants = admin ? [] : await listUserGrants(user.id)
  const found = await Promise.all(
    relays.map(async (relay) =>
      (await unfinishedRestores(relay, user.id)).map((restore) => ({
        ...restore,
        relay,
      }))
    )
  )
  const visible = found
    .flat()
    .filter(
      ({ relay, target }) =>
        admin ||
        grantsAllowBackup(
          grants,
          { ...target, relayId: relay.id },
          "backup.read"
        )
    )
  return Promise.all(
    visible.map(async ({ phase, relay, target, taskId }) => {
      const backup = await runAppEffect(
        "backups.unfinishedRestoreBackup",
        getBackupForTaskEffect(taskId)
      )
      return {
        backupName: backup?.name ?? null,
        canResolve:
          admin ||
          grantsAllowBackup(
            grants,
            { ...target, relayId: relay.id },
            "backup.restore"
          ),
        phase,
        relayId: relay.id,
        relayName: relay.name,
        target,
        taskId,
      }
    })
  )
}

/**
 * Finishes or abandons an unfinished restore, which takes the authority
 * restoring its target does: over every App that uses it.
 */
export async function resolveUnfinishedRestoreHandler(
  user: AuthenticatedUser,
  data: { action: "abandon" | "finish"; relayId: string; taskId: string }
) {
  const relay = await activeRelay(data.relayId)
  const restore = (await unfinishedRestores(relay, user.id, true)).find(
    (candidate) => candidate.taskId === data.taskId
  )
  if (!restore) {
    throw new Error("This restore has already finished or been abandoned")
  }
  await requireBackupTargetRestore(user, relay, restore.target)
  await relayRpc(
    relay,
    "backup.restore.resolve",
    { action: data.action, taskId: data.taskId },
    30 * 60_000,
    user.id
  )
  await recoverPromise(
    () => reconcileRelayBackups(relay, user.id),
    () => undefined
  )
  const backup = await runAppEffect(
    "backups.resolvedRestoreBackup",
    getBackupForTaskEffect(data.taskId)
  )
  if (backup) publishBackupChange(relay.id, backup.id)
  return { resolved: true as const }
}

export async function readRelayVolumes(
  relay: PersistedRelay,
  // Who asks, for the Relay's audit; none when Hearth asks for itself.
  userId?: string
): Promise<RelayVolumes> {
  return relayVolumesSchema.parse(
    await relayRpc(relay, "relay.volumes.read", {}, 30_000, userId)
  )
}

// A Relay that can't be asked, or doesn't know the request, has none to
// show; resolving one needs an answer.
async function unfinishedRestores(
  relay: PersistedRelay,
  userId: string,
  required = false
): Promise<Array<BackupUnfinishedRestore & { target: ResourceTarget }>> {
  const read = async () =>
    backupUnfinishedRestoresSchema
      .parse(
        await relayRpc(relay, "backup.restore.unfinished", {}, 15_000, userId)
      )
      .map((restore) => ({
        ...restore,
        target: restore.target as ResourceTarget,
      }))
  return required ? read() : recoverPromise(read, () => [])
}

/**
 * What backing up an App backs up: its folder, then each volume its Compose
 * project owns that has an ID, as manual and scheduled backups both do.
 */
export function appTargets(
  appId: string,
  listing: RelayVolumes | null
): Array<ResourceTarget & { name: string | null }> {
  return [
    { id: appId, kind: "app", name: null },
    ...(listing?.volumes ?? []).flatMap((volume) =>
      volume.owner?.appId === appId && volume.id !== null
        ? [
            {
              id: volume.id,
              kind: "volume" as const,
              name: volume.owner.volume,
            },
          ]
        : []
    ),
  ]
}

// A personal destination exports the backup, so it takes download too.
async function requirePersonalStorage(
  storageIds: ReadonlyArray<string | null>,
  user: AuthenticatedUser,
  relayId: string,
  target: ResourceTarget
) {
  for (const storageId of new Set(storageIds)) {
    if (storageId === null) continue
    const storage = await runAppEffect(
      "backups.loadSelectedStorage",
      loadBackupStorageEffect(storageId)
    )
    if (
      !storage ||
      !storage.enabled ||
      storage.deleting ||
      (storage.ownerUserId !== null && storage.ownerUserId !== user.id)
    ) {
      throw new Error("Backup destination is unavailable")
    }
    if (storage.ownerUserId !== null) {
      await requireBackupTargetPermission(
        user,
        relayId,
        target,
        "backup.download"
      )
    }
  }
}

function publicBackup(record: BackupCatalogRecord): BackupRun {
  const { createdBy: _, objectKey: __, ...rest } = record
  return {
    ...rest,
    artifacts: rest.artifacts.map(
      ({ objectKey: ___, ...artifact }) => artifact
    ),
    orderKey: { id: rest.id, value: null },
    relayPresent: true,
  }
}
