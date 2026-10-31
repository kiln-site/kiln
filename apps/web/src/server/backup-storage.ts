import { randomUUID } from "node:crypto"

import { createServerFn } from "@tanstack/react-start"
import { Effect } from "effect"
import { z } from "zod"

import { type BackupTarget, backupTargetSchema } from "@workspace/contracts"

import {
  relayIdSchema,
  resticS3BucketSchema,
  resticS3RegionSchema,
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
import { ensuringPromise, promiseEffect } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { hasPlatformPermission, isPlatformAdmin } from "@/lib/access-control"
import {
  publishBackupSettingsChange,
  publishBackupStorageChange,
} from "@/lib/backup-realtime.server"
import { kilnInstallationId } from "@/effect/installation"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  normalizeObjectPrefix,
  normalizeS3Endpoint,
  verifyS3BackupCredential,
  type S3BackupCredential,
} from "@/backups/destinations/s3"
import { backupStorageKey, backupStorageSettingsKey } from "@/lib/backup-lanes"
import { exclusive, shared } from "@/operations/lanes"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"
import { requireEligibleResourceUser } from "@/server/auth"
import { backupPolicyLock } from "@/server/backup-operations.server"

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
      requireEligibleResourceUser(),
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

const saveDestination = operation<z.infer<typeof backupStorageInputSchema>>()({
  name: "backupStorage.save",
  doing: "Changing this backup destination",
  authorize: ({ input: data, user }) =>
    signedIn(user).pipe(
      Effect.flatMap((person) =>
        promiseEffect(async () => {
          if (
            (data.platform || data.allowPrivateNetwork) &&
            !hasPlatformPermission(person, "platform.backups.manage-storage")
          ) {
            throw new Error(
              "Platform and private-network backup destinations require administrator access"
            )
          }
          const existing = data.id
            ? await runAppEffect(
                "backupStorage.loadExisting",
                loadBackupStorageEffect(data.id)
              )
            : null
          if (data.id && !existing) {
            throw new Error("Backup destination not found")
          }
          if (
            existing &&
            existing.ownerUserId !== person.id &&
            !hasPlatformPermission(person, "platform.backups.manage-storage")
          ) {
            throw new Error("You cannot update this backup destination")
          }
          const ownerUserId = data.platform ? null : person.id
          if (existing && existing.ownerUserId !== ownerUserId) {
            throw new Error("Backup destination ownership cannot be changed")
          }
          return { existing, id: data.id ?? randomUUID(), ownerUserId }
        })
      )
    ),
  locks: ({ context }) => [exclusive(backupStorageSettingsKey(context.id))],
  run: ({ context: { existing, id, ownerUserId }, input: data }) =>
    promiseEffect(async () => {
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
      // Schedules carry its credentials and whether it may be used; saving
      // marked them owed.
      await deliverSchedules()
      return { id, verified: true }
    }),
  audit: ({ context }) => ({ id: context.id, kind: "backup-storage" }),
})

export const saveBackupStorage = createServerFn({ method: "POST" })
  .validator(backupStorageInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(saveDestination, data, {
      user: await requireEligibleResourceUser(),
    })
  )

const deleteDestination = operation<{ id: string }>()({
  name: "backupStorage.delete",
  doing: "Changing this backup destination",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.flatMap((person) =>
        promiseEffect(async () => {
          const existing = await runAppEffect(
            "backupStorage.loadForDelete",
            loadBackupStorageEffect(input.id)
          )
          if (
            existing &&
            existing.ownerUserId !== person.id &&
            !hasPlatformPermission(person, "platform.backups.manage-storage")
          ) {
            throw new Error("You cannot delete this backup destination")
          }
          return existing
        })
      )
    ),
  locks: ({ input }) => [exclusive(backupStorageKey(input.id))],
  run: ({ context: existing, input }) =>
    promiseEffect(async () => {
      if (!existing) return { deleted: true }
      // Marking it deleted marks the schedules backing up to it owed; they're
      // sent whether or not purging it then succeeds.
      await ensuringPromise(
        () =>
          runAppEffect(
            "backupStorage.delete",
            deleteBackupStorageEffect(input.id)
          ),
        () => void deliverSchedules()
      )
      publishBackupStorageChange(existing.ownerUserId)
      return { deleted: true }
    }),
  audit: ({ input }) => ({ id: input.id, kind: "backup-storage" }),
})

export const deleteBackupStorage = createServerFn({ method: "POST" })
  .validator(z.strictObject({ id: backupStorageIdSchema }))
  .handler(async ({ data }) =>
    runOperationPromise(deleteDestination, data, {
      user: await requireEligibleResourceUser(),
    })
  )

// Where a target's backups go when none is chosen.
const preferDestination = operation<
  z.infer<typeof preferredStorageInputSchema>
>()({
  name: "backup.policy.storage",
  doing: "Changing these backup settings",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.flatMap((person) =>
        promiseEffect(async () => ({
          target: await requireBackupPolicyTarget(input, person),
          user: person,
        }))
      )
    ),
  locks: ({ input }) => [
    backupPolicyLock(input.relayId, input.target),
    ...(input.storageId
      ? [shared(backupStorageSettingsKey(input.storageId))]
      : []),
  ],
  run: ({ context: { target, user }, input: data }) =>
    promiseEffect(async () => {
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
        if (storage.ownerUserId !== null && target.kind !== "platform") {
          const { requireBackupTargetPermission } =
            await import("@/server/backup-target-access.server")
          await requireBackupTargetPermission(
            user,
            data.relayId,
            target,
            "backup.download"
          )
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
    }),
  audit: ({ context: { target }, input }) => ({
    id: target.id,
    kind: target.kind,
    relayId: input.relayId,
  }),
})

export const setPreferredBackupStorage = createServerFn({ method: "POST" })
  .validator(preferredStorageInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(preferDestination, data, {
      user: await requireEligibleResourceUser(),
    })
  )

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
  const { requireBackupTargetPermission } =
    await import("@/server/backup-target-access.server")
  await requireBackupTargetPermission(
    user,
    input.relayId,
    input.target,
    "backup.create"
  )
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

async function deliverSchedules() {
  const { deliverPendingSchedules } =
    await import("@/server/schedule-deployment.server")
  deliverPendingSchedules()
}
