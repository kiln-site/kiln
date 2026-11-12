import { randomUUID } from "node:crypto"

import {
  databaseEngineSupportsLogicalBackups,
  relaySnapshotSchema,
  type BackupConsistency,
} from "@workspace/contracts"

import { loadBackupStorageEffect } from "@/backups/destinations/s3"
import {
  reserveBackupBatchEffect,
  type BackupCreateReservation,
} from "@/effect/backups"
import { kilnInstallationId } from "@/effect/installation"
import { listManagedDatabaseRecordsEffect } from "@/effect/managed-databases"
import { runAppEffect } from "@/effect/runtime"
import { isPlatformAdmin, requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { publishBackupChange } from "@/lib/backup-realtime.server"
import { dispatchBackupTask } from "@/lib/backup-reconciliation"
import type { BackupAction } from "@/lib/backup-target-permissions"
import { relayRpc } from "@/lib/relay-connection"
import { activeRelay, type PersistedRelay } from "@/lib/relay-registry"
import { readRelayVolumes } from "@/server/app-backups.server"
import {
  requireAppsPermission,
  requireBackupTargetPermission,
} from "@/server/backup-target-access.server"

// A run: backups of several things, chosen together and started together.
// Each is a backup of its own, as if made alone, and they are reserved all
// or none, so a run never comes up short of one it was asked for without
// saying. What is chosen is what is backed up: a group picked in Hearth is
// sent as its members, never as itself.

/** One thing a run backs up. Kiln's own is `platform`, on the Relay it names. */
export interface BackupRunTarget {
  id: string
  kind: "database" | "instance" | "platform" | "volume"
  relayId: string
}

export interface BackupRunInput {
  /** For the volumes among them: live, or with what uses them stopped. */
  consistency: BackupConsistency
  /** For the game servers among them; a run of anything else is full. */
  mode?: "full" | "incremental" | undefined
  name: string
  storageIds: Array<string | null>
  targets: Array<BackupRunTarget>
}

/** Refuses an action on one of a run's targets this person may not take. */
export async function requireRunTargetPermission(
  user: AuthenticatedUser,
  target: BackupRunTarget,
  action: BackupAction
): Promise<void> {
  if (target.kind === "platform") {
    if (isPlatformAdmin(user)) return
    throw new Error("Platform backups require administrator access")
  }
  if (target.kind === "volume") {
    return requireBackupTargetPermission(user, target.relayId, target, action)
  }
  return requireRelayPermission({
    permission: action,
    relayId: target.relayId,
    user,
    ...(target.kind === "database"
      ? { databaseId: target.id }
      : { instanceId: target.id }),
  })
}

// The destinations a run goes to, each one this person may use. A personal
// one exports what it is sent, so each target takes download too; Kiln's
// own backup goes only where the platform keeps its own.
async function requireRunStorage(
  user: AuthenticatedUser,
  data: BackupRunInput
): Promise<void> {
  let personal = false
  for (const storageId of new Set(data.storageIds)) {
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
    personal ||= storage.ownerUserId !== null
  }
  if (!personal) return
  for (const target of data.targets) {
    if (target.kind === "platform") {
      throw new Error("Kiln platform backups require platform-owned destinations")
    }
    await requireRunTargetPermission(user, target, "backup.download")
  }
}

type Member = Pick<
  BackupCreateReservation,
  "artifactKind" | "consistency" | "mode" | "targetId" | "targetKind"
> & { relay: PersistedRelay }

// What one Relay's share of a run reserves, once each target is checked
// as backing it up alone checks it.
async function relayMembers(
  user: AuthenticatedUser,
  relay: PersistedRelay,
  targets: ReadonlyArray<BackupRunTarget>,
  data: BackupRunInput
): Promise<Array<Member>> {
  const of = <Kind extends BackupRunTarget["kind"]>(kind: Kind) =>
    targets.filter((target) => target.kind === kind)
  const members: Array<Member> = []

  const instances = of("instance")
  if (instances.length > 0) {
    const snapshot = relaySnapshotSchema.parse(
      await relayRpc(relay, "relay.snapshot", {}, 15_000, user.id)
    )
    const known = new Set(snapshot.instances.map((instance) => instance.id))
    for (const { id } of instances) {
      if (!known.has(id)) throw new Error("Server not found on this Relay")
      members.push({
        artifactKind: "archive",
        ...(data.mode === undefined ? {} : { mode: data.mode }),
        relay,
        targetId: id,
        targetKind: "instance",
      })
    }
  }

  const databases = of("database")
  if (databases.length > 0) {
    const records = await runAppEffect(
      "backups.databaseTarget",
      listManagedDatabaseRecordsEffect()
    )
    for (const { id } of databases) {
      const database = records.find(
        (record) => record.relayId === relay.id && record.databaseId === id
      )
      if (!database) throw new Error("Database not found on this Relay")
      if (!databaseEngineSupportsLogicalBackups(database.engine)) {
        throw new Error(
          `${database.engine} logical backups are not supported yet`
        )
      }
      members.push({
        artifactKind: "database_dump",
        relay,
        targetId: id,
        targetKind: "database",
      })
    }
  }

  const volumes = of("volume")
  if (volumes.length > 0 && data.consistency === "stopped") {
    // Every App that uses any of them stops, so each takes permission.
    const listing = await readRelayVolumes(relay, user.id)
    if (!listing.protection.ready) {
      throw new Error(
        `The Relay doesn't know yet which Apps use these volumes${listing.protection.reason ? `: ${listing.protection.reason}` : ""}`
      )
    }
    const users = new Set<string>()
    for (const { id } of volumes) {
      const volume = listing.volumes.find((candidate) => candidate.id === id)
      if (!volume) throw new Error("Volume not found on this Relay")
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
  for (const { id } of volumes) {
    members.push({
      artifactKind: "tar_archive",
      consistency: data.consistency,
      mode: "full",
      relay,
      targetId: id,
      targetKind: "volume",
    })
  }

  if (of("platform").length > 0) {
    members.push({
      artifactKind: "platform_bundle",
      relay,
      targetId: kilnInstallationId(),
      targetKind: "platform",
    })
  }
  return members
}

/**
 * Backs up everything chosen as one run: each a backup of its own, reserved
 * together or not at all, and started together. The volumes of a stopped
 * run on one Relay share one stopped window there, so every App that uses
 * any of them stops once.
 */
export async function createBackupRunHandler(
  user: AuthenticatedUser,
  data: BackupRunInput
) {
  for (const target of data.targets) {
    await requireRunTargetPermission(user, target, "backup.create")
  }
  if (
    data.mode === "incremental" &&
    data.targets.some((target) => target.kind !== "instance")
  ) {
    throw new Error(
      "Incremental backups are for game servers; choose a full archive to back up anything else with them"
    )
  }
  await requireRunStorage(user, data)
  const members: Array<Member> = []
  for (const relayId of new Set(data.targets.map((target) => target.relayId))) {
    members.push(
      ...(await relayMembers(
        user,
        await activeRelay(relayId),
        data.targets.filter((target) => target.relayId === relayId),
        data
      ))
    )
  }
  // One backup alone is no run; several are kept together by its ID.
  const batchId = members.length > 1 ? randomUUID() : undefined
  // How many of a Relay's share its stopped window waits for.
  const stopped = (relayId: string) =>
    members.filter(
      (member) =>
        member.relay.id === relayId && member.consistency === "stopped"
    ).length
  const reserved = await runAppEffect(
    "backups.reserveRun",
    reserveBackupBatchEffect(
      members.map(({ relay, ...member }) => ({
        ...member,
        backupId: randomUUID(),
        ...(batchId ? { batchId, batchSize: stopped(relay.id) } : {}),
        createdBy: user.id,
        exclude: [],
        name: data.name,
        relayId: relay.id,
        requestedMaxBytes: null,
        storageIds: data.storageIds,
        taskId: randomUUID(),
      }))
    )
  )
  reserved.forEach((input, index) =>
    publishBackupChange(members[index]!.relay.id, input.backupId)
  )
  const dispatched = await Promise.allSettled(
    reserved.map((input, index) =>
      dispatchBackupTask(members[index]!.relay, input, user.id)
    )
  )
  return {
    backupIds: reserved.map((input) => input.backupId),
    batchId: batchId ?? null,
    relayAccepted: dispatched.every((result) => result.status === "fulfilled"),
  }
}
