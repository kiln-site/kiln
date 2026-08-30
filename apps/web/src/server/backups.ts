import { createHash, randomBytes, randomUUID } from "node:crypto"

import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import {
  backupTargetSchema,
  databaseEngineSupportsLogicalBackups,
  relayBackupTaskSchema,
  relayIdSchema,
  relaySnapshotSchema,
  type BackupTarget,
} from "@workspace/contracts"

import { createBackupDownloadShareEffect } from "@/effect/backup-download-shares"
import {
  forgetBackupEffect,
  getBackupCatalogRecordEffect,
  listBackupCatalogPageEffect,
  getBackupPolicyEffect,
  reconcileBackupTaskEffect,
  renameBackupEffect,
  reserveBackupCopyEffect,
  reserveBackupDeleteEffect,
  reserveBackupExportEffect,
  reserveBackupRestoreEffect,
  reserveDatabaseBackupEffect,
  reserveInstanceBackupEffect,
  reservePlatformBackupEffect,
  updateBackupExcludesEffect,
  updateBackupLimitsEffect,
  type BackupCatalogRecord,
  type BackupCatalogPageRecord,
  type BackupDispatch,
} from "@/effect/backups"
import { listManagedDatabaseRecordsEffect } from "@/effect/managed-databases"
import { loadBackupStorageEffect } from "@/backups/destinations/s3"
import {
  prepareBackupDestinationDownload,
  resolveBackupRelayForOperation,
} from "@/backups/destinations"
import { runAppEffect } from "@/effect/runtime"
import {
  hasPlatformPermission,
  isPlatformAdmin,
  listUserGrants,
  requireRelayPermission,
} from "@/lib/access-control"
import { hasBackupPermission } from "@/lib/backup-access"
import { roleHasPermission } from "@/lib/permissions"
import { accessRoles } from "@/lib/permissions"
import { scheduleBackupCopyProcessing } from "@/lib/backup-copy"
import { selectBackupCopySource } from "@/lib/backup-copy-source"
import {
  publishBackupChange,
  publishBackupSettingsChange,
} from "@/lib/backup-realtime.server"
import { signLocalBackupDownload } from "@/backups/destinations/local"
import { relayRpc } from "@/lib/relay-connection"
import { kilnInstallationId, kilnPublicUrl } from "@/lib/environment"
import {
  dispatchBackupTask,
  reconcileRelayBackups,
} from "@/lib/backup-reconciliation"
import { listPersistedRelays, type PersistedRelay } from "@/lib/relay-registry"
import { requireAuthenticatedUser } from "@/server/auth"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  backupRunsQueryFingerprint,
  backupRunsQuerySchema,
  normalizeBackupRunsQuery,
  type BackupRun,
  type BackupRunsPage,
} from "@/lib/backup-runs"
import {
  decodeBackupRunCursor,
  encodeBackupRunCursor,
} from "@/lib/backup-run-cursor.server"

const instanceBackupInputSchema = z.strictObject({
  instanceId: z.string().min(1).max(120),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .optional(),
  mode: z.enum(["full", "incremental"]).optional(),
  name: z.string().trim().min(1).max(120),
  relayId: relayIdSchema,
  storageId: z.uuid().nullable().optional(),
  storageIds: z.array(z.uuid().nullable()).min(1).max(16).optional(),
})

const databaseBackupInputSchema = z.strictObject({
  databaseId: z.string().min(1).max(120),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .optional(),
  name: z.string().trim().min(1).max(120),
  relayId: relayIdSchema,
  storageId: z.uuid().nullable().optional(),
  storageIds: z.array(z.uuid().nullable()).min(1).max(16).optional(),
})

const platformBackupInputSchema = z.strictObject({
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .optional(),
  name: z.string().trim().min(1).max(120),
  relayId: relayIdSchema,
  storageId: z.uuid().nullable().optional(),
  storageIds: z.array(z.uuid().nullable()).min(1).max(16).optional(),
})

const backupIdInputSchema = z.strictObject({ backupId: z.uuid() })
const backupRunsPageSize = 50
const backupRunForQuerySchema = backupRunsQuerySchema.extend({
  backupId: z.uuid(),
})

const backupRemovalInputSchema = z.strictObject({
  backupId: z.uuid(),
  mode: z.enum(["delete", "forget"]),
})

const renameBackupInputSchema = z.strictObject({
  backupId: z.uuid(),
  name: z.string().trim().min(1).max(120),
})

const copyBackupInputSchema = z.strictObject({
  backupId: z.uuid(),
  storageId: z.uuid(),
})

const backupDownloadInputSchema = z.strictObject({
  artifactId: z.uuid().optional(),
  backupId: z.uuid(),
  expiresInSeconds: z
    .number()
    .int()
    .min(60)
    .max(7 * 24 * 60 * 60)
    .default(300),
  poll: z.boolean().default(false),
  preview: z.boolean().default(true),
})

const backupRestoreInputSchema = z.strictObject({
  backupId: z.uuid(),
  safetyBackup: z.boolean().default(true),
})

const backupLimitsInputSchema = z.strictObject({
  quantityLimit: z.number().int().nonnegative().max(1_000_000).nullable(),
  relayId: relayIdSchema,
  scope: z.enum(["platform", "user"]),
  sizeLimitBytes: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  target: backupTargetSchema,
})

const backupExcludesInputSchema = z.strictObject({
  exclude: z.array(z.string().trim().min(1).max(1_024)).max(1_000),
  relayId: relayIdSchema,
  target: backupTargetSchema,
})

const backupPolicyInputSchema = z.strictObject({
  relayId: relayIdSchema,
  target: backupTargetSchema,
})

export const createInstanceBackup = createServerFn({ method: "POST" })
  .validator(instanceBackupInputSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const relay = await requireBackupRelay(data.relayId)
    await requireRelayPermission({
      instanceId: data.instanceId,
      permission: "backup.create",
      relayId: relay.id,
      user,
    })
    const snapshot = relaySnapshotSchema.parse(
      await relayRpc(relay, "relay.snapshot", {}, 15_000, user.id)
    )
    if (
      !snapshot.instances.some((instance) => instance.id === data.instanceId)
    ) {
      throw new Error("Server not found on this Relay")
    }
    await validateRequestedStorage(data, user.id)

    const input = await runAppEffect(
      "backups.reserve",
      reserveInstanceBackupEffect({
        backupId: randomUUID(),
        createdBy: user.id,
        name: data.name,
        ...(data.mode === undefined ? {} : { mode: data.mode }),
        relayId: relay.id,
        requestedMaxBytes: data.maxBytes ?? null,
        ...(data.storageId === undefined ? {} : { storageId: data.storageId }),
        ...(data.storageIds === undefined
          ? {}
          : { storageIds: data.storageIds }),
        targetId: data.instanceId,
        taskId: randomUUID(),
      })
    )
    publishBackupChange(relay.id, input.backupId)
    return dispatchAndLoadReservedBackup(
      relay,
      input,
      user.id,
      "backups.getAfterCreate"
    )
  })

export const createDatabaseBackup = createServerFn({ method: "POST" })
  .validator(databaseBackupInputSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const relay = await requireBackupRelay(data.relayId)
    await requireRelayPermission({
      databaseId: data.databaseId,
      permission: "backup.create",
      relayId: relay.id,
      user,
    })
    const records = await runAppEffect(
      "backups.databaseTarget",
      listManagedDatabaseRecordsEffect()
    )
    const database = records.find(
      (record) =>
        record.relayId === relay.id && record.databaseId === data.databaseId
    )
    if (!database) {
      throw new Error("Database not found on this Relay")
    }
    if (!databaseEngineSupportsLogicalBackups(database.engine)) {
      throw new Error(
        `${database.engine} logical backups are not supported yet`
      )
    }
    await validateRequestedStorage(data, user.id)
    const input = await runAppEffect(
      "backups.reserveDatabase",
      reserveDatabaseBackupEffect({
        backupId: randomUUID(),
        createdBy: user.id,
        name: data.name,
        relayId: relay.id,
        requestedMaxBytes: data.maxBytes ?? null,
        ...(data.storageId === undefined ? {} : { storageId: data.storageId }),
        ...(data.storageIds === undefined
          ? {}
          : { storageIds: data.storageIds }),
        targetId: data.databaseId,
        taskId: randomUUID(),
      })
    )
    publishBackupChange(relay.id, input.backupId)
    return dispatchAndLoadReservedBackup(
      relay,
      input,
      user.id,
      "backups.getAfterDatabaseCreate"
    )
  })

export const createPlatformBackup = createServerFn({ method: "POST" })
  .validator(platformBackupInputSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    if (!isPlatformAdmin(user)) {
      throw new Error("Platform backups require administrator access")
    }
    const relay = await requireBackupRelay(data.relayId)
    await validateRequestedStorage(data, user.id, true)
    const input = await runAppEffect(
      "backups.reservePlatform",
      reservePlatformBackupEffect({
        backupId: randomUUID(),
        createdBy: user.id,
        name: data.name,
        relayId: relay.id,
        requestedMaxBytes: data.maxBytes ?? null,
        ...(data.storageId === undefined ? {} : { storageId: data.storageId }),
        ...(data.storageIds === undefined
          ? {}
          : { storageIds: data.storageIds }),
        targetId: kilnInstallationId(),
        taskId: randomUUID(),
      })
    )
    publishBackupChange(relay.id, input.backupId)
    return dispatchAndLoadReservedBackup(
      relay,
      input,
      user.id,
      "backups.getAfterPlatformCreate"
    )
  })

async function dispatchAndLoadReservedBackup(
  relay: PersistedRelay,
  input: BackupDispatch,
  userId: string,
  operation: string
): Promise<{ backup: BackupCatalogRecord; relayAccepted: boolean }> {
  const [dispatchResult, backupResult] = await Promise.allSettled([
    dispatchBackupTask(relay, input, userId),
    runAppEffect(operation, getBackupCatalogRecordEffect(input.backupId)),
  ])
  if (backupResult.status === "rejected") throw backupResult.reason
  if (!backupResult.value) {
    throw new Error("Backup catalog record was not created")
  }
  return {
    backup: backupResult.value,
    relayAccepted: dispatchResult.status === "fulfilled",
  }
}

export const getBackupRunsPage = createServerFn({ method: "GET" })
  .validator(backupRunsQuerySchema)
  .handler(async ({ data }): Promise<BackupRunsPage> => {
    const user = await requireAuthenticatedUser()
    const query = normalizeBackupRunsQuery(data)
    const fingerprint = backupRunsQueryFingerprint(query)
    const cursor = decodeBackupRunCursor(query.cursor, fingerprint, query.sort)
    const page = await runAppEffect(
      "backups.page",
      listBackupCatalogPageEffect({
        allowedRoles: accessRoles.filter((role) =>
          roleHasPermission(role, "backup.read")
        ),
        cursor,
        direction: query.direction,
        isAdmin: isPlatformAdmin(user),
        limit: backupRunsPageSize,
        scope: query.scope,
        search: query.search,
        sort: query.sort,
        status: query.status,
        userId: user.id,
      })
    )
    const items = page.items.map(publicBackupRun)
    const last = items.at(-1)
    return {
      items,
      nextCursor:
        page.hasMore && last
          ? encodeBackupRunCursor({
              fingerprint,
              id: last.id,
              value: last.orderKey.value,
            })
          : null,
    }
  })

export const getBackupRunForQuery = createServerFn({ method: "GET" })
  .validator(backupRunForQuerySchema)
  .handler(async ({ data }): Promise<BackupRun | null> => {
    const user = await requireAuthenticatedUser()
    const query = normalizeBackupRunsQuery({ ...data, cursor: null })
    const page = await runAppEffect(
      "backups.getForQuery",
      listBackupCatalogPageEffect({
        allowedRoles: accessRoles.filter((role) =>
          roleHasPermission(role, "backup.read")
        ),
        backupId: data.backupId,
        cursor: null,
        direction: query.direction,
        isAdmin: isPlatformAdmin(user),
        limit: 1,
        scope: query.scope,
        search: query.search,
        sort: query.sort,
        status: query.status,
        userId: user.id,
      })
    )
    const item = page.items[0]
    return item ? publicBackupRun(item) : null
  })

export const syncBackupRuns = createServerFn({ method: "POST" }).handler(
  async () => {
    const user = await requireAuthenticatedUser()
    scheduleBackupCopyProcessing()
    const persistedRelays = await listPersistedRelays()
    const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
    const readableRelayIds = new Set(
      grants.flatMap((grant) =>
        roleHasPermission(grant.role, "backup.read") ? [grant.relayId] : []
      )
    )
    const relays = persistedRelays.filter(
      (relay) =>
        relay.enabled &&
        (isPlatformAdmin(user) ||
          readableRelayIds.has(relay.id) ||
          relay.createdBy === user.id)
    )
    await Promise.allSettled(
      relays.map((relay) => reconcileRelayBackups(relay, user.id))
    )
    return { synced: true as const }
  }
)

function publicBackupRun(item: BackupCatalogPageRecord): BackupRun {
  const { createdBy: _, objectKey: __, ...record } = item.record
  return {
    ...record,
    artifacts: record.artifacts.map(
      ({ objectKey: ___, ...artifact }) => artifact
    ),
    orderKey: { id: record.id, value: item.orderValue },
    relayPresent: item.relayPresent,
  }
}

export const getBackupPolicy = createServerFn({ method: "GET" })
  .validator(backupPolicyInputSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const target = await requireBackupPolicyTarget(data, user)
    return runAppEffect(
      "backups.getPolicy",
      getBackupPolicyEffect(data.relayId, target.kind, target.id)
    )
  })

export const cancelBackup = createServerFn({ method: "POST" })
  .validator(backupIdInputSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const backup = await runAppEffect(
      "backups.getForCancel",
      getBackupCatalogRecordEffect(data.backupId)
    )
    if (!backup) throw new Error("Backup not found")
    if (
      backup.taskKind !== "create" ||
      (backup.taskStatus !== "queued" && backup.taskStatus !== "running")
    ) {
      throw new Error("This backup is no longer being created")
    }
    const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
    if (!hasBackupPermission(user, grants, backup, "backup.create")) {
      throw new Error("You do not have permission to cancel this backup")
    }
    const relay = await resolveBackupRelayForOperation(
      { operation: "cancel", relayId: backup.relayId },
      requireBackupRelay
    )
    const task = relayBackupTaskSchema.parse(
      await relayRpc(
        relay,
        "backup.task.cancel",
        { taskId: backup.taskId },
        15_000,
        user.id
      )
    )
    await runAppEffect(
      "backups.reconcileCancel",
      reconcileBackupTaskEffect(task, relay.id)
    )
    if (task.status !== "cancelled") {
      throw new Error("This backup is no longer being created")
    }
    publishBackupChange(relay.id, backup.id)
    return { cancelled: true as const }
  })

export const deleteBackup = createServerFn({ method: "POST" })
  .validator(backupRemovalInputSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const backup = await runAppEffect(
      "backups.getForDelete",
      getBackupCatalogRecordEffect(data.backupId)
    )
    if (!backup) throw new Error("Backup not found")
    const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
    const relayPresent = (await listPersistedRelays()).some(
      (relay) => relay.id === backup.relayId
    )
    if (data.mode === "forget") {
      if (!hasBackupPermission(user, grants, backup, "backup.read")) {
        throw new Error("You do not have permission to forget this backup")
      }
      if (relayPresent) {
        throw new Error(
          "This Relay belongs to Hearth again. Refresh before removing the backup."
        )
      }
      const forgetResult = await runAppEffect(
        "backups.forget",
        forgetBackupEffect(backup.id)
      )
      if (forgetResult === "relay_present") {
        throw new Error(
          "This Relay belongs to Hearth again. Refresh before removing the backup."
        )
      }
      if (forgetResult === "not_found") throw new Error("Backup not found")
      publishBackupChange(backup.relayId, backup.id)
      return { forgotten: true as const }
    }
    if (!hasBackupPermission(user, grants, backup, "backup.delete")) {
      throw new Error("You do not have permission to delete this backup")
    }
    if (!relayPresent) {
      throw new Error(
        "This Relay no longer belongs to Hearth. Refresh before forgetting the backup."
      )
    }
    const relay = await requireBackupRelay(backup.relayId)
    const input = await runAppEffect(
      "backups.reserveDelete",
      reserveBackupDeleteEffect({
        backupId: backup.id,
        requestedBy: user.id,
        taskId: randomUUID(),
      })
    )
    publishBackupChange(relay.id, backup.id)
    const dispatched = await Promise.allSettled([
      dispatchBackupTask(relay, input, user.id),
    ])
    return {
      forgotten: false as const,
      relayAccepted: dispatched[0]?.status === "fulfilled",
    }
  })

export const renameBackup = createServerFn({ method: "POST" })
  .validator(renameBackupInputSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const backup = await runAppEffect(
      "backups.getForRename",
      getBackupCatalogRecordEffect(data.backupId)
    )
    if (!backup) throw new Error("Backup not found")
    const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
    if (!hasBackupPermission(user, grants, backup, "backup.create")) {
      throw new Error("You do not have permission to rename this backup")
    }
    const renamed = await runAppEffect(
      "backups.rename",
      renameBackupEffect({
        backupId: backup.id,
        name: data.name,
      })
    )
    if (!renamed) throw new Error("Backup not found")
    publishBackupChange(backup.relayId, backup.id)
    return { name: data.name }
  })

export const copyBackupToDestination = createServerFn({ method: "POST" })
  .validator(copyBackupInputSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const backup = await runAppEffect(
      "backups.getForCopy",
      getBackupCatalogRecordEffect(data.backupId)
    )
    if (!backup) throw new Error("Backup not found")
    const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
    if (!hasBackupPermission(user, grants, backup, "backup.create")) {
      throw new Error("You do not have permission to copy this backup")
    }
    if (backup.artifactKind === "restic_snapshot") {
      throw new Error("Incremental snapshots cannot be copied to S3")
    }
    await validateRequestedStorage(
      { storageId: data.storageId },
      user.id,
      backup.targetKind === "platform"
    )
    const source = selectBackupCopySource(backup.artifacts)
    if (!source) {
      throw new Error("A successful backup file is required before copying")
    }
    const filename = source.filename ?? backup.filename
    if (!filename) throw new Error("Backup filename is unavailable")
    const reserved = await runAppEffect(
      "backups.reserveCopy",
      reserveBackupCopyEffect({
        artifactKind: backup.artifactKind,
        backupId: backup.id,
        filename,
        relayId: backup.relayId,
        requestedBy: user.id,
        sourceArtifactId: source.id,
        storageId: data.storageId,
        targetId: backup.targetId,
        targetKind: backup.targetKind,
      })
    )
    scheduleBackupCopyProcessing()
    publishBackupChange(backup.relayId, backup.id)
    return { copied: false, queued: true, taskId: reserved.taskId }
  })

export const getBackupDownloadUrl = createServerFn({ method: "POST" })
  .validator(backupDownloadInputSchema)
  .handler(async ({ data }) => {
    const { setResponseHeader } = await import("@tanstack/react-start/server")
    setResponseHeader("Cache-Control", "no-store")
    const user = await requireAuthenticatedUser()
    const backup = await runAppEffect(
      "backups.getForDownload",
      getBackupCatalogRecordEffect(data.backupId)
    )
    if (!backup || backup.status !== "available") {
      throw new Error("Backup is not available")
    }
    const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
    if (!hasBackupPermission(user, grants, backup, "backup.download")) {
      throw new Error("You do not have permission to download this backup")
    }
    if (backup.artifactKind === "restic_snapshot") {
      return resticBackupDownload({
        backup,
        expiresInSeconds: data.expiresInSeconds,
        poll: data.poll,
        preview: data.preview,
        user,
      })
    }
    const artifact = data.artifactId
      ? backup.artifacts.find((candidate) => candidate.id === data.artifactId)
      : (backup.artifacts.find(
          (candidate) =>
            candidate.status === "available" && candidate.storageId === null
        ) ??
        backup.artifacts.find((candidate) => candidate.status === "available"))
    if (!artifact || artifact.status !== "available") {
      throw new Error("Backup source is not available")
    }
    const filename = artifact.filename ?? backup.filename
    if (!filename) throw new Error("Backup filename is unavailable")
    const relay = await resolveBackupRelayForOperation(
      {
        operation: "download",
        relayId: backup.relayId,
        storageId: artifact.storageId,
      },
      requireBackupRelay
    )
    const { download, sourceName } = await runAppEffect(
      "backups.prepareDownload",
      prepareBackupDestinationDownload({
        backup,
        expiresInSeconds: data.expiresInSeconds,
        filename,
        objectKey: artifact.objectKey,
        relay,
        storageId: artifact.storageId,
        subject: user.id,
      })
    )
    if (!data.preview) return download

    const id = randomBytes(12).toString("base64url")
    await runAppEffect(
      "backups.downloadShares.create",
      createBackupDownloadShareEffect({
        artifactKind: backup.artifactKind,
        backupId: backup.id,
        backupName: backup.name,
        bytes: artifact.bytes ?? backup.bytes,
        checksumSha256: artifact.checksumSha256 ?? backup.checksumSha256,
        createdAt: backup.createdAt,
        downloadUrl: download.url,
        expiresAt: download.expiresAt,
        filename,
        sharedBy: user.name,
        sourceName,
        targetId: backup.targetId,
        targetKind: backup.targetKind,
        tokenHash: createHash("sha256").update(id).digest("hex"),
      })
    )
    const shareUrl = new URL(`/downloads/${id}`, kilnPublicUrl())
    return { expiresAt: download.expiresAt, url: shareUrl.toString() }
  })

export const restoreInstanceBackup = createServerFn({ method: "POST" })
  .validator(backupRestoreInputSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const backup = await runAppEffect(
      "backups.getForRestore",
      getBackupCatalogRecordEffect(data.backupId)
    )
    if (
      !backup ||
      backup.status !== "available" ||
      backup.targetKind !== "instance" ||
      (backup.artifactKind !== "archive" &&
        backup.artifactKind !== "restic_snapshot") ||
      (backup.artifactKind === "archive" && backup.backupMode !== "full") ||
      (backup.artifactKind === "restic_snapshot" &&
        backup.backupMode !== "incremental")
    ) {
      throw new Error("Backup is not available for an instance restore")
    }
    const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
    if (!hasBackupPermission(user, grants, backup, "backup.restore")) {
      throw new Error("You do not have permission to restore this backup")
    }
    const relay = await requireBackupRelay(backup.relayId)
    if (data.safetyBackup) {
      await requireRelayPermission({
        instanceId: backup.targetId,
        permission: "backup.create",
        relayId: relay.id,
        user,
      })
    }
    const snapshot = relaySnapshotSchema.parse(
      await relayRpc(relay, "relay.snapshot", {}, 15_000, user.id)
    )
    const instance = snapshot.instances.find(
      (candidate) => candidate.id === backup.targetId
    )
    if (!instance) throw new Error("Restore target was not found on this Relay")
    if (
      instance.observedState !== "stopped" ||
      instance.desiredState !== "stopped"
    ) {
      throw new Error("Stop the server before restoring a backup")
    }

    const safety = data.safetyBackup
      ? await runAppEffect(
          "backups.reserveSafety",
          reserveInstanceBackupEffect({
            backupId: randomUUID(),
            createdBy: user.id,
            name: `Before restoring ${backup.name}`.slice(0, 120),
            reason: "pre_restore",
            relayId: relay.id,
            requestedMaxBytes: null,
            targetId: backup.targetId,
            taskId: randomUUID(),
          })
        )
      : null
    const restore = await runAppEffect(
      "backups.reserveRestore",
      reserveBackupRestoreEffect({
        backupId: backup.id,
        dependsOnTaskId: safety?.taskId ?? null,
        requestedBy: user.id,
        taskId: randomUUID(),
      })
    )
    publishBackupChange(relay.id, backup.id)
    if (safety) publishBackupChange(relay.id, safety.backupId)
    const firstTask = safety ?? restore
    const dispatched = await Promise.allSettled([
      dispatchBackupTask(relay, firstTask, user.id),
    ])
    return {
      relayAccepted: dispatched[0]?.status === "fulfilled",
      restoreTaskId: restore.taskId,
      safetyBackupId: safety?.backupId ?? null,
    }
  })

export const restoreDatabaseBackup = createServerFn({ method: "POST" })
  .validator(backupRestoreInputSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const backup = await runAppEffect(
      "backups.getForDatabaseRestore",
      getBackupCatalogRecordEffect(data.backupId)
    )
    if (
      !backup ||
      backup.status !== "available" ||
      backup.targetKind !== "database" ||
      backup.artifactKind !== "database_dump" ||
      backup.backupMode !== "full"
    ) {
      throw new Error("Backup is not available for a database restore")
    }
    const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
    if (!hasBackupPermission(user, grants, backup, "backup.restore")) {
      throw new Error("You do not have permission to restore this backup")
    }
    const relay = await requireBackupRelay(backup.relayId)
    if (data.safetyBackup) {
      await requireRelayPermission({
        databaseId: backup.targetId,
        permission: "backup.create",
        relayId: relay.id,
        user,
      })
    }
    const records = await runAppEffect(
      "backups.databaseRestoreTarget",
      listManagedDatabaseRecordsEffect()
    )
    if (
      !records.some(
        (record) =>
          record.relayId === relay.id && record.databaseId === backup.targetId
      )
    ) {
      throw new Error("Restore target was not found on this Relay")
    }
    const safety = data.safetyBackup
      ? await runAppEffect(
          "backups.reserveDatabaseSafety",
          reserveDatabaseBackupEffect({
            backupId: randomUUID(),
            createdBy: user.id,
            name: `Before restoring ${backup.name}`.slice(0, 120),
            reason: "pre_restore",
            relayId: relay.id,
            requestedMaxBytes: null,
            targetId: backup.targetId,
            taskId: randomUUID(),
          })
        )
      : null
    const restore = await runAppEffect(
      "backups.reserveDatabaseRestore",
      reserveBackupRestoreEffect({
        backupId: backup.id,
        dependsOnTaskId: safety?.taskId ?? null,
        requestedBy: user.id,
        taskId: randomUUID(),
      })
    )
    publishBackupChange(relay.id, backup.id)
    if (safety) publishBackupChange(relay.id, safety.backupId)
    const dispatched = await Promise.allSettled([
      dispatchBackupTask(relay, safety ?? restore, user.id),
    ])
    return {
      relayAccepted: dispatched[0]?.status === "fulfilled",
      restoreTaskId: restore.taskId,
      safetyBackupId: safety?.backupId ?? null,
    }
  })

export const updateBackupLimits = createServerFn({ method: "POST" })
  .validator(backupLimitsInputSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const target = await requireBackupPolicyTarget(data, user)
    if (
      data.scope === "platform" &&
      !hasPlatformPermission(user, "platform.backups.manage-limits")
    ) {
      throw new Error("Platform backup limits require administrator access")
    }
    await runAppEffect(
      "backups.updateLimits",
      updateBackupLimitsEffect({
        admin: data.scope === "platform",
        quantityLimit: data.quantityLimit,
        relayId: data.relayId,
        sizeLimitBytes: data.sizeLimitBytes,
        targetId: target.id,
        targetKind: target.kind,
      })
    )
    publishBackupSettingsChange(data.relayId)
    return { updated: true }
  })

export const updateBackupExcludes = createServerFn({ method: "POST" })
  .validator(backupExcludesInputSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const target = await requireBackupPolicyTarget(data, user)
    await runAppEffect(
      "backups.updateExcludes",
      updateBackupExcludesEffect({
        exclude: data.exclude,
        relayId: data.relayId,
        targetId: target.id,
        targetKind: target.kind,
      })
    )
    publishBackupSettingsChange(data.relayId)
    return { updated: true }
  })

async function requireBackupPolicyTarget(
  input: { relayId: string; target: BackupTarget },
  user: AuthenticatedUser
): Promise<BackupTarget> {
  if (input.target.kind === "platform") {
    if (!isPlatformAdmin(user)) {
      throw new Error("Platform backup settings require administrator access")
    }
    return { id: kilnInstallationId(), kind: "platform" }
  }
  await requireRelayPermission({
    ...(input.target.kind === "database"
      ? { databaseId: input.target.id }
      : { instanceId: input.target.id }),
    permission: "backup.create",
    relayId: input.relayId,
    user,
  })
  return input.target
}

async function resticBackupDownload(input: {
  backup: BackupCatalogRecord
  expiresInSeconds: number
  poll: boolean
  preview: boolean
  user: AuthenticatedUser
}): Promise<
  { preparing: true; taskId: string } | { expiresAt: string; url: string }
> {
  const reserved = await runAppEffect(
    "backups.reserveExport",
    reserveBackupExportEffect({
      backupId: input.backup.id,
      replaceFailed: !input.poll,
      requestedBy: input.user.id,
      requireFullTtl: !input.poll,
      taskId: randomUUID(),
      ttlMs: input.expiresInSeconds * 1_000,
    })
  )
  if (reserved.kind === "dispatch") {
    publishBackupChange(input.backup.relayId, input.backup.id)
    const relay = await requireBackupRelay(input.backup.relayId)
    await dispatchBackupTask(relay, reserved.dispatch, input.user.id)
    return { preparing: true, taskId: reserved.dispatch.taskId }
  }
  const remainingSeconds = Math.max(
    1,
    Math.min(
      input.expiresInSeconds,
      Math.floor((reserved.expiresAt - Date.now()) / 1_000)
    )
  )
  const relay = await requireBackupRelay(input.backup.relayId)
  const download = await signLocalBackupDownload(
    relay,
    input.backup,
    reserved.filename,
    input.user.id,
    remainingSeconds
  )
  if (!input.preview) return download
  const id = randomBytes(12).toString("base64url")
  await runAppEffect(
    "backups.downloadShares.createExport",
    createBackupDownloadShareEffect({
      artifactKind: input.backup.artifactKind,
      backupId: input.backup.id,
      backupName: input.backup.name,
      bytes: input.backup.bytes,
      checksumSha256: input.backup.checksumSha256,
      createdAt: input.backup.createdAt,
      downloadUrl: download.url,
      expiresAt: download.expiresAt,
      filename: reserved.filename,
      sharedBy: input.user.name,
      sourceName: relay.name,
      targetId: input.backup.targetId,
      targetKind: input.backup.targetKind,
      tokenHash: createHash("sha256").update(id).digest("hex"),
    })
  )
  const shareUrl = new URL(`/downloads/${id}`, kilnPublicUrl())
  return { expiresAt: download.expiresAt, url: shareUrl.toString() }
}

async function validateRequestedStorage(
  input: {
    storageId?: string | null
    storageIds?: Array<string | null>
  },
  userId: string,
  platformOnly = false
): Promise<void> {
  const storageIds =
    input.storageIds ?? (input.storageId === undefined ? [] : [input.storageId])
  await Promise.all(
    [...new Set(storageIds)]
      .filter((storageId): storageId is string => storageId !== null)
      .map(async (storageId) => {
        const storage = await runAppEffect(
          "backups.loadSelectedStorage",
          loadBackupStorageEffect(storageId)
        )
        if (
          !storage ||
          !storage.enabled ||
          storage.deleting ||
          (platformOnly
            ? storage.ownerUserId !== null
            : storage.ownerUserId !== null && storage.ownerUserId !== userId)
        ) {
          throw new Error(
            platformOnly
              ? "Kiln platform backups require platform-owned destinations"
              : "Backup destination is unavailable"
          )
        }
      })
  )
}

async function requireBackupRelay(relayId: string): Promise<PersistedRelay> {
  const relay = (await listPersistedRelays()).find(
    (candidate) => candidate.enabled && candidate.id === relayId
  )
  if (!relay) throw new Error("Relay is not available")
  return relay
}
