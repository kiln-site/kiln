import { randomUUID } from "node:crypto"

import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import {
  backupTargetSchema,
  relayIdSchema,
  resticS3BucketSchema,
  resticS3RegionSchema,
  type BackupTarget,
} from "@workspace/contracts"

import {
  deleteBackupStorageEffect,
  listBackupStorageEffect,
  loadBackupStorageEffect,
  loadBackupStorageCredentialEffect,
  saveBackupStorageEffect,
  setBackupPolicyStorageEffect,
  type BackupStorageRecord,
} from "@/backups/destinations/s3"
import { runAppEffect } from "@/effect/runtime"
import {
  hasPlatformPermission,
  isPlatformAdmin,
  requireRelayPermission,
} from "@/lib/access-control"
import {
  publishBackupSettingsChange,
  publishBackupStorageChange,
} from "@/lib/backup-realtime.server"
import { kilnInstallationId } from "@/lib/environment"
import {
  normalizeObjectPrefix,
  normalizeS3Endpoint,
  verifyS3BackupCredential,
  type S3BackupCredential,
} from "@/backups/destinations/s3"
import { requireAuthenticatedUser } from "@/server/auth"

const backupStorageIdSchema = z.uuid()
export const backupStorageInputSchema = z.strictObject({
  accessKeyId: z.string().trim().min(1).max(512).optional(),
  allowPrivateNetwork: z.boolean().default(false),
  bucket: z.string().trim().pipe(resticS3BucketSchema),
  enabled: z.boolean().default(true),
  endpoint: z.string().trim().min(1).max(2_048),
  forcePathStyle: z.boolean().default(false),
  id: backupStorageIdSchema.optional(),
  name: z.string().trim().min(1).max(120),
  objectPrefix: z.string().max(512).default(""),
  platform: z.boolean().default(false),
  region: z.string().trim().pipe(resticS3RegionSchema),
  secretAccessKey: z.string().min(1).max(2_048).optional(),
})

const preferredStorageInputSchema = z.strictObject({
  relayId: relayIdSchema,
  storageId: backupStorageIdSchema.nullable(),
  target: backupTargetSchema,
})

export const getBackupStorage = createServerFn({ method: "GET" }).handler(
  async () => {
    const [{ setResponseHeader }, user] = await Promise.all([
      import("@tanstack/react-start/server"),
      requireAuthenticatedUser(),
    ])
    setResponseHeader("Cache-Control", "no-store")
    const storage = await runAppEffect(
      "backupStorage.listVisible",
      listBackupStorageEffect()
    )
    return visibleBackupStorage(
      storage,
      user.id,
      hasPlatformPermission(user, "platform.backups.manage-storage")
    )
  }
)

export const saveBackupStorage = createServerFn({ method: "POST" })
  .validator(backupStorageInputSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    if (
      (data.platform || data.allowPrivateNetwork) &&
      !hasPlatformPermission(user, "platform.backups.manage-storage")
    ) {
      throw new Error(
        "Platform and private-network backup destinations require administrator access"
      )
    }
    const id = data.id ?? randomUUID()
    const existing = data.id
      ? await runAppEffect(
          "backupStorage.loadExisting",
          loadBackupStorageEffect(data.id)
        )
      : null
    if (data.id && !existing) throw new Error("Backup destination not found")
    if (
      existing &&
      existing.ownerUserId !== user.id &&
      !hasPlatformPermission(user, "platform.backups.manage-storage")
    ) {
      throw new Error("You cannot update this backup destination")
    }
    const ownerUserId = data.platform ? null : user.id
    if (existing && existing.ownerUserId !== ownerUserId) {
      throw new Error("Backup destination ownership cannot be changed")
    }
    if (
      (data.accessKeyId === undefined) !==
      (data.secretAccessKey === undefined)
    ) {
      throw new Error("Both S3 credential fields must be provided together")
    }
    const existingCredential =
      existing && data.accessKeyId === undefined
        ? await runAppEffect(
            "backupStorage.loadExistingCredential",
            loadBackupStorageCredentialEffect(existing.id)
          )
        : null
    const accessKeyId = data.accessKeyId ?? existingCredential?.accessKeyId
    const secretAccessKey =
      data.secretAccessKey ?? existingCredential?.secretAccessKey
    if (!accessKeyId || !secretAccessKey) {
      throw new Error("S3 credentials are required")
    }
    const credential = {
      accessKeyId,
      allowPrivateNetwork: data.allowPrivateNetwork,
      bucket: data.bucket,
      endpoint: normalizeS3Endpoint(data.endpoint),
      forcePathStyle: data.forcePathStyle,
      objectPrefix: normalizeObjectPrefix(data.objectPrefix),
      region: data.region,
      secretAccessKey,
    } satisfies S3BackupCredential
    await runAppEffect(
      "backupStorage.verify",
      verifyS3BackupCredential(credential)
    )
    await runAppEffect(
      "backupStorage.save",
      saveBackupStorageEffect({
        ...credential,
        enabled: data.enabled,
        id,
        name: data.name,
        ownerUserId,
      })
    )
    publishBackupStorageChange(ownerUserId)
    return { id, verified: true }
  })

export const deleteBackupStorage = createServerFn({ method: "POST" })
  .validator(z.strictObject({ id: backupStorageIdSchema }))
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const existing = await runAppEffect(
      "backupStorage.loadForDelete",
      loadBackupStorageEffect(data.id)
    )
    if (!existing) return { deleted: true }
    if (
      existing.ownerUserId !== user.id &&
      !hasPlatformPermission(user, "platform.backups.manage-storage")
    ) {
      throw new Error("You cannot delete this backup destination")
    }
    await runAppEffect(
      "backupStorage.delete",
      deleteBackupStorageEffect(data.id)
    )
    publishBackupStorageChange(existing.ownerUserId)
    return { deleted: true }
  })

export const setPreferredBackupStorage = createServerFn({ method: "POST" })
  .validator(preferredStorageInputSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const target = await requireBackupPolicyTarget(data, user)
    if (data.storageId) {
      const storage = await runAppEffect(
        "backupStorage.loadPreferred",
        loadBackupStorageEffect(data.storageId)
      )
      if (
        !storage ||
        (target.kind === "platform"
          ? storage.ownerUserId !== null
          : !canUseStorage(storage, user.id)) ||
        !storage.enabled ||
        storage.deleting
      ) {
        throw new Error("Backup destination is unavailable")
      }
    }
    await runAppEffect(
      "backupStorage.setPreferred",
      setBackupPolicyStorageEffect({
        relayId: data.relayId,
        storageId: data.storageId,
        targetId: target.id,
        targetKind: target.kind,
      })
    )
    publishBackupSettingsChange(data.relayId)
    return { updated: true }
  })

async function requireBackupPolicyTarget(
  input: { relayId: string; target: BackupTarget },
  user: Awaited<ReturnType<typeof requireAuthenticatedUser>>
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

export function visibleBackupStorage(
  storage: ReadonlyArray<BackupStorageRecord>,
  userId: string,
  canManagePlatformStorage: boolean
): Array<BackupStorageRecord> {
  if (canManagePlatformStorage) return [...storage]
  return storage.filter((record) => canUseStorage(record, userId))
}

function canUseStorage(
  storage: Pick<BackupStorageRecord, "ownerUserId">,
  userId: string
): boolean {
  return storage.ownerUserId === null || storage.ownerUserId === userId
}
