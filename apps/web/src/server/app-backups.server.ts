import {
  appBackupVolumes,
  backupUnfinishedRestoresSchema,
  relayVolumesSchema,
  type BackupTarget,
  type BackupUnfinishedRestore,
  type RelayVolumes,
} from "@workspace/contracts"

import {
  getBackupForTaskEffect,
  listTargetBackupsEffect,
  type BackupCatalogRecord,
} from "@/effect/backups"
import { loadAppConfigEffect } from "@/effect/managed-apps"
import { recoverPromise } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import {
  isPlatformAdmin,
  listUserGrants,
  requireRelayPermission,
} from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { configuredVolumeIds } from "@/lib/app-volume-references.server"
import { publishBackupChange } from "@/lib/backup-realtime.server"
import { reconcileRelayBackups } from "@/lib/backup-reconciliation"
import type { BackupRun } from "@/lib/backup-runs"
import { grantsAllowBackup } from "@/lib/backup-target-permissions"
import { relayRpc } from "@/lib/relay-connection"
import {
  activeRelay,
  listPersistedRelays,
  type PersistedRelay,
} from "@/lib/relay-registry"
import { requireBackupTargetRestore } from "@/server/backup-target-access.server"

// Server-only work behind an App's backup settings and unfinished restores; the
// server functions in ./backups authenticate the caller first.

type ResourceTarget = BackupTarget & { kind: "volume" }

/** What an App's backup settings show: what's backed up, and what isn't. */
export async function getAppBackupsHandler(
  user: AuthenticatedUser,
  data: { appId: string; relayId: string }
) {
  const relay = await activeRelay(data.relayId)
  // What an App keeps is shown to those who may read the App.
  await requireRelayPermission({
    appId: data.appId,
    permission: "app.read",
    relayId: relay.id,
    user,
  })
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
  const { available, latest, restores } = await runAppEffect(
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
    missing:
      listing && plan
        ? missingAppVolumes(data.appId, plan.configured, listing)
        : [],
    targets: targets.map((target) => {
      const shown = readable(target)
      const backup = latest.find((record) =>
        same(target, { id: record.targetId, kind: record.targetKind })
      )
      return {
        ...target,
        // When its newest backup that finished was made: what says it is
        // backed up, which one that failed or still runs doesn't.
        backedUpAt:
          available.find((record) =>
            same(target, { id: record.targetId, kind: record.targetKind })
          )?.createdAt ?? null,
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
    missing: missingAppVolumes(appId, configured, listing),
    targets: appTargets(appId, listing, configured),
  }
}

/**
 * The Kiln volumes an App's configuration mounts, or its Compose file
 * declares, that its Relay doesn't have. A backup that went ahead would
 * leave their data out without saying.
 */
export function missingAppVolumes(
  appId: string,
  configured: ReadonlyArray<string>,
  listing: RelayVolumes
): Array<string> {
  const known = new Set(listing.volumes.map((volume) => volume.id))
  return [
    ...new Set([
      ...configured.filter((id) => !known.has(id)),
      // What the Relay knows the App names, its Compose file's included.
      ...listing.missing.flatMap((gone) =>
        gone.appId === appId ? [gone.volumeId] : []
      ),
    ]),
  ]
}

/**
 * Restores of volumes whose swap didn't finish, fencing
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
 * do. An App is a group of what it keeps: each volume it uses, whichever
 * other Apps use that one too, and nothing of its own. One its saved
 * configuration mounts counts whether or not its Relay has heard.
 */
export function appTargets(
  appId: string,
  listing: RelayVolumes | null,
  configured: ReadonlyArray<string> = []
): Array<{ id: string; kind: "volume"; name: string }> {
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
  return [...taken, ...named].map((volume) => ({
    id: volume.id,
    kind: "volume" as const,
    name: volume.name,
  }))
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
