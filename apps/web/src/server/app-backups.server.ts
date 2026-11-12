import { randomUUID } from "node:crypto"

import {
  appBackupVolumes,
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
import { configuredVolumeIds } from "@/lib/app-volume-references.server"
import { publishBackupChange } from "@/lib/backup-realtime.server"
import {
  dispatchBackupTask,
  reconcileRelayBackups,
} from "@/lib/backup-reconciliation"
import type { BackupRun } from "@/lib/backup-runs"
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
  const [listing, unfinished, plan] = await Promise.all([
    recoverPromise(
      () => readRelayVolumes(relay, user.id),
      () => null
    ),
    unfinishedRestores(relay, user.id),
    appBackupPlan(relay.id, data.appId),
  ])
  const targets = appTargets(data.appId, listing, plan?.configured)
  // A volume's backups are its own to see, whichever App's backup made
  // them: someone who may only see the App's is shown the volume without
  // them.
  const grants = isPlatformAdmin(user)
    ? null
    : await listUserGrants(user.id, relay.id)
  const readable = (target: BackupTarget) =>
    grants === null ||
    grantsAllowBackup(grants, { ...target, relayId: relay.id }, "backup.read")
  const { latest, restores } = await runAppEffect(
    "backups.appTargets",
    listTargetBackupsEffect(relay.id, targets.filter(readable))
  )
  const same = (left: BackupTarget, right: BackupTarget) =>
    left.kind === right.kind && left.id === right.id
  return {
    // The Relay's volumes, unless it couldn't be asked.
    available: listing !== null,
    // A volume its configuration mounts that its Relay doesn't have: its
    // backup would leave that data out, so none is made until it's back.
    missing: listing && plan ? missingAppVolumes(plan.configured, listing) : [],
    targets: targets.map((target) => {
      const shown = readable(target)
      const backup = latest.find((record) =>
        same(target, { id: record.targetId, kind: record.targetKind })
      )
      return {
        ...target,
        latest: backup ? publicBackup(backup) : null,
        readable: shown,
        restore: (() => {
          const restore = restores.find((record) =>
            same(target, { id: record.targetId, kind: record.targetKind })
          )
          return restore ? publicBackup(restore) : null
        })(),
        unfinished: shown
          ? (unfinished.find((restore) => same(target, restore.target)) ??
            null)
          : null,
      }
    }),
    uncovered:
      listing?.uncovered.filter((mount) => mount.appId === data.appId) ?? [],
  }
}

/**
 * What decides which volumes an App's backup takes besides what its Relay
 * lists: the Kiln volumes its saved configuration mounts. Null when Hearth
 * keeps no such App.
 */
async function appBackupPlan(relayId: string, appId: string) {
  const app = await runAppEffect(
    "backups.appTarget",
    loadAppConfigEffect(relayId, appId)
  )
  return app ? { configured: configuredVolumeIds(app.config) } : null
}

/**
 * What a scheduled backup of an App takes, as its Relay lists its volumes
 * now, and a volume its configuration mounts that the Relay doesn't have:
 * with one missing, the backup is refused rather than run short.
 */
export async function scheduledAppTargets(
  relayId: string,
  appId: string,
  listing: RelayVolumes
) {
  const plan = await appBackupPlan(relayId, appId)
  const configured = plan?.configured ?? []
  return {
    missing: missingAppVolumes(configured, listing)[0] ?? null,
    targets: appTargets(appId, listing, configured),
  }
}

/**
 * The Kiln volumes an App's configuration mounts that its Relay doesn't
 * have. A backup that went ahead would leave their data out without saying.
 */
export function missingAppVolumes(
  configured: ReadonlyArray<string>,
  listing: RelayVolumes
): Array<string> {
  const known = new Set(listing.volumes.map((volume) => volume.id))
  return configured.filter((id) => !known.has(id))
}

/**
 * Settles what backing up an App takes before its operation runs, for
 * someone who may back it up: the volumes are lanes it holds too.
 */
export async function settleAppBackup<
  Input extends { appId: string; relayId: string },
>(user: AuthenticatedUser, data: Input) {
  const relay = await activeRelay(data.relayId)
  await requireBackupTargetPermission(
    user,
    relay.id,
    { id: data.appId, kind: "app" },
    "backup.create"
  )
  const { targets } = await coveredAppTargets(relay, data.appId, user.id)
  return {
    ...data,
    volumeIds: targets.flatMap((target) =>
      target.kind === "volume" ? [target.id] : []
    ),
  }
}

// Everything an App's backup takes, or why it can't take all the App keeps.
async function coveredAppTargets(
  relay: PersistedRelay,
  appId: string,
  userId: string
) {
  const plan = await appBackupPlan(relay.id, appId)
  if (!plan) throw new Error("App not found on this Relay")
  const listing = await readRelayVolumes(relay, userId)
  const [missing] = missingAppVolumes(plan.configured, listing)
  if (missing !== undefined) {
    throw new Error(
      `A volume this App mounts is missing on its Relay (${missing.slice(0, 8)}). Restore it or remove its mount, then back up again.`
    )
  }
  return { listing, targets: appTargets(appId, listing, plan.configured) }
}

/**
 * Backs up an App: its folder and each volume it uses, each a backup of its
 * own, started together as one batch. Stopped, each stops and starts again
 * every App that uses what it backs up.
 */
export async function createAppBackupsHandler(
  user: AuthenticatedUser,
  data: {
    appId: string
    consistency: BackupConsistency
    name: string
    relayId: string
    storageIds: Array<string | null>
    /** The volumes it was settled to take, which its operation holds. */
    volumeIds: ReadonlyArray<string>
  }
) {
  const relay = await activeRelay(data.relayId)
  const app = { id: data.appId, kind: "app" as const }
  await requireBackupTargetPermission(user, relay.id, app, "backup.create")
  const { listing, targets } = await coveredAppTargets(
    relay,
    data.appId,
    user.id
  )
  const taken = targets.flatMap((target) =>
    target.kind === "volume" ? [target.id] : []
  )
  if ([...taken].sort().join() !== [...data.volumeIds].sort().join()) {
    throw new Error(
      "This App's volumes changed while its backup was starting. Try again."
    )
  }
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
      "instance.power.stop",
      "A stopped backup stops and starts every App that uses what it backs up; you need permission to stop each"
    )
  }
  // A personal destination exports each member, the volumes among them.
  for (const { id, kind } of targets) {
    await requirePersonalStorage(data.storageIds, user, relay.id, { id, kind })
  }
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
        storageIds: data.storageIds,
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
 * What backing up an App backs up, as manual and scheduled backups both
 * do: its folder, then each volume its Compose project made and each Kiln
 * volume it uses, whichever other Apps use that one too. A Kiln volume its
 * saved configuration mounts counts whether or not its Relay has heard.
 */
export function appTargets(
  appId: string,
  listing: RelayVolumes | null,
  configured: ReadonlyArray<string> = []
): Array<ResourceTarget & { name: string | null }> {
  const volumes = listing?.volumes ?? []
  const taken = appBackupVolumes(appId, volumes)
  const named = volumes.flatMap((volume) =>
    volume.id !== null &&
    volume.kind === "kiln" &&
    configured.includes(volume.id) &&
    !taken.some((member) => member.id === volume.id)
      ? [{ ...volume, id: volume.id }]
      : []
  )
  return [
    { id: appId, kind: "app", name: null },
    ...[...taken, ...named].map((volume) => ({
      id: volume.id,
      kind: "volume" as const,
      name: volume.owner?.volume ?? volume.name,
    })),
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
