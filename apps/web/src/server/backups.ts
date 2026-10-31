import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { z } from "zod"

import {
  backupConsistencySchema,
  backupTargetSchema,
  relayIdSchema,
} from "@workspace/contracts"

import {
  backupRunsQuerySchema,
  type BackupRun,
  type BackupRunsPage,
} from "@/lib/backup-runs"
import { runOperationPromise } from "@/operations/operation"
import { requireEligibleResourceUser } from "@/server/auth"
import {
  backUpApp,
  backUpDatabase,
  backUpInstance,
  backUpPlatform,
  backUpResource,
  cancelBackup as cancelBackupOperation,
  changeBackupExcludes,
  changeBackupLimits,
  copyBackup,
  downloadBackup,
  removeBackup,
  renameBackup as renameBackupOperation,
  resolveRestore,
  restoreDatabase,
  restoreInstance,
  restoreResource,
  syncBackups,
} from "@/server/backup-operations.server"
import {
  getBackupExportStateHandler,
  getBackupPolicyHandler,
  getBackupUsageHandler,
  getBackupRunForQueryHandler,
  getBackupRunsPageHandler,
} from "@/server/backups.server"

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

// An App's folder, or a volume: one Kiln made, or `<App ID>/<key>` for one
// an App's Compose project declares.
const resourceBackupInputSchema = z.strictObject({
  consistency: backupConsistencySchema.optional(),
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
  target: backupTargetSchema.extend({ kind: z.enum(["app", "volume"]) }),
})

const appIdSchema = z.string().regex(/^[a-f0-9]{40}$/u)

const appBackupsInputSchema = z.strictObject({
  appId: appIdSchema,
  relayId: relayIdSchema,
})

const createAppBackupsInputSchema = appBackupsInputSchema.extend({
  consistency: backupConsistencySchema.default("live"),
  name: z.string().trim().min(1).max(120),
  storageIds: z.array(z.uuid().nullable()).min(1).max(16).optional(),
})

const resolveRestoreInputSchema = z.strictObject({
  action: z.enum(["abandon", "finish"]),
  relayId: relayIdSchema,
  taskId: z.uuid(),
})

const backupIdInputSchema = z.strictObject({ backupId: z.uuid() })
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
  // Asked again once a snapshot's export was seen ready: its link takes
  // whatever time the export has left, rather than needing a fresh one.
  afterExport: z.boolean().default(false),
  artifactId: z.uuid().optional(),
  backupId: z.uuid(),
  expiresInSeconds: z
    .number()
    .int()
    .min(60)
    .max(7 * 24 * 60 * 60)
    .default(300),
  preview: z.boolean().default(true),
})

const backupRestoreInputSchema = z.strictObject({
  backupId: z.uuid(),
  safetyBackup: z.boolean().default(true),
})

// A target's retention: the most backups it keeps, the most space they take,
// and the longest it keeps them; null keeps without that limit. Only a
// platform administrator's ceiling can be none at all, which turns backups
// off for the target.
const backupLimitsInputSchema = z
  .strictObject({
    quantityLimit: z.number().int().nonnegative().max(1_000_000).nullable(),
    relayId: relayIdSchema,
    retentionDays: z.number().int().positive().max(36_500).nullable(),
    scope: z.enum(["platform", "user"]),
    sizeLimitBytes: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    target: backupTargetSchema,
  })
  .refine((input) => input.scope === "platform" || input.quantityLimit !== 0, {
    message: "Keep at least one backup",
    path: ["quantityLimit"],
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

export type InstanceBackupInput = z.infer<typeof instanceBackupInputSchema>
export type DatabaseBackupInput = z.infer<typeof databaseBackupInputSchema>
export type PlatformBackupInput = z.infer<typeof platformBackupInputSchema>
export type ResourceBackupInput = z.infer<typeof resourceBackupInputSchema>
export type BackupIdInput = z.infer<typeof backupIdInputSchema>
export type BackupRunForQueryInput = z.infer<typeof backupRunForQuerySchema>
export type BackupRemovalInput = z.infer<typeof backupRemovalInputSchema>
export type RenameBackupInput = z.infer<typeof renameBackupInputSchema>
export type CopyBackupInput = z.infer<typeof copyBackupInputSchema>
export type BackupDownloadInput = z.infer<typeof backupDownloadInputSchema>
export type BackupRestoreInput = z.infer<typeof backupRestoreInputSchema>
export type BackupLimitsInput = z.infer<typeof backupLimitsInputSchema>
export type BackupExcludesInput = z.infer<typeof backupExcludesInputSchema>
export type BackupPolicyInput = z.infer<typeof backupPolicyInputSchema>

// Each server function authenticates, then hands the user to its handler in
// ./backups.server.

export const createInstanceBackup = createServerFn({ method: "POST" })
  .validator(instanceBackupInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(backUpInstance, data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const createDatabaseBackup = createServerFn({ method: "POST" })
  .validator(databaseBackupInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(backUpDatabase, data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const createPlatformBackup = createServerFn({ method: "POST" })
  .validator(platformBackupInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(backUpPlatform, data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const createResourceBackup = createServerFn({ method: "POST" })
  .validator(resourceBackupInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(backUpResource, data, {
      user: await requireEligibleResourceUser(),
    })
  )

// An App's backup settings: its folder and the volumes its Compose project
// owns, each with its newest backup, and what it mounts that isn't covered.
export const getAppBackups = createServerFn({ method: "GET" })
  .validator(appBackupsInputSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const { getAppBackupsHandler } = await import("@/server/app-backups.server")
    return getAppBackupsHandler(user, data)
  })

// Backs up an App's folder and owned volumes together.
export const createAppBackups = createServerFn({ method: "POST" })
  .validator(createAppBackupsInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(backUpApp, data, {
      user: await requireEligibleResourceUser(),
    })
  )

// Restores whose swap didn't finish, which fence their targets.
export const getUnfinishedRestores = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireEligibleResourceUser()
    const { listUnfinishedRestoresHandler } =
      await import("@/server/app-backups.server")
    return listUnfinishedRestoresHandler(user)
  }
)

export const resolveUnfinishedRestore = createServerFn({ method: "POST" })
  .validator(resolveRestoreInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(resolveRestore, data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const getBackupRunsPage = createServerFn({ method: "GET" })
  .validator(backupRunsQuerySchema)
  .handler(async ({ data }): Promise<BackupRunsPage> => {
    const signal = getRequest().signal
    const user = await requireEligibleResourceUser()
    return getBackupRunsPageHandler(user, data, signal)
  })

export const getBackupRunForQuery = createServerFn({ method: "GET" })
  .validator(backupRunForQuerySchema)
  .handler(async ({ data }): Promise<BackupRun | null> => {
    const signal = getRequest().signal
    const user = await requireEligibleResourceUser()
    return getBackupRunForQueryHandler(user, data, signal)
  })

export const syncBackupRuns = createServerFn({ method: "POST" }).handler(
  async () =>
    runOperationPromise(syncBackups, undefined, {
      user: await requireEligibleResourceUser(),
    })
)

export const getBackupPolicy = createServerFn({ method: "GET" })
  .validator(backupPolicyInputSchema)
  .handler(async ({ data }) =>
    getBackupPolicyHandler(await requireEligibleResourceUser(), data)
  )

export const getBackupUsage = createServerFn({ method: "GET" })
  .validator(backupPolicyInputSchema)
  .handler(async ({ data }) =>
    getBackupUsageHandler(await requireEligibleResourceUser(), data)
  )

export const cancelBackup = createServerFn({ method: "POST" })
  .validator(backupIdInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(cancelBackupOperation, data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const deleteBackup = createServerFn({ method: "POST" })
  .validator(backupRemovalInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(removeBackup, data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const renameBackup = createServerFn({ method: "POST" })
  .validator(renameBackupInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(renameBackupOperation, data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const copyBackupToDestination = createServerFn({ method: "POST" })
  .validator(copyBackupInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(copyBackup, data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const getBackupDownloadUrl = createServerFn({ method: "POST" })
  .validator(backupDownloadInputSchema)
  .handler(async ({ data }) => {
    const { setResponseHeader } = await import("@tanstack/react-start/server")
    setResponseHeader("Cache-Control", "no-store")
    return runOperationPromise(downloadBackup, data, {
      user: await requireEligibleResourceUser(),
    })
  })

// How a snapshot's export for download is coming along, polled while it's
// prepared; downloading it once ready is getBackupDownloadUrl again.
export const getBackupExportState = createServerFn({ method: "GET" })
  .validator(backupIdInputSchema)
  .handler(async ({ data }) =>
    getBackupExportStateHandler(await requireEligibleResourceUser(), data)
  )

export const restoreInstanceBackup = createServerFn({ method: "POST" })
  .validator(backupRestoreInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(restoreInstance, data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const restoreDatabaseBackup = createServerFn({ method: "POST" })
  .validator(backupRestoreInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(restoreDatabase, data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const restoreResourceBackup = createServerFn({ method: "POST" })
  .validator(backupRestoreInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(restoreResource, data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const updateBackupLimits = createServerFn({ method: "POST" })
  .validator(backupLimitsInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(changeBackupLimits, data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const updateBackupExcludes = createServerFn({ method: "POST" })
  .validator(backupExcludesInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(changeBackupExcludes, data, {
      user: await requireEligibleResourceUser(),
    })
  )
