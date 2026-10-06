import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { z } from "zod"

import { backupTargetSchema, relayIdSchema } from "@workspace/contracts"

import {
  backupRunsQuerySchema,
  type BackupRun,
  type BackupRunsPage,
} from "@/lib/backup-runs"
import { requireEligibleResourceUser } from "@/server/auth"
import {
  cancelBackupHandler,
  copyBackupToDestinationHandler,
  createDatabaseBackupHandler,
  createInstanceBackupHandler,
  createPlatformBackupHandler,
  deleteBackupHandler,
  getBackupDownloadUrlHandler,
  getBackupPolicyHandler,
  getBackupRunForQueryHandler,
  getBackupRunsPageHandler,
  renameBackupHandler,
  restoreDatabaseBackupHandler,
  restoreInstanceBackupHandler,
  syncBackupRunsHandler,
  updateBackupExcludesHandler,
  updateBackupLimitsHandler,
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

export type InstanceBackupInput = z.infer<typeof instanceBackupInputSchema>
export type DatabaseBackupInput = z.infer<typeof databaseBackupInputSchema>
export type PlatformBackupInput = z.infer<typeof platformBackupInputSchema>
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
    createInstanceBackupHandler(await requireEligibleResourceUser(), data)
  )

export const createDatabaseBackup = createServerFn({ method: "POST" })
  .validator(databaseBackupInputSchema)
  .handler(async ({ data }) =>
    createDatabaseBackupHandler(await requireEligibleResourceUser(), data)
  )

export const createPlatformBackup = createServerFn({ method: "POST" })
  .validator(platformBackupInputSchema)
  .handler(async ({ data }) =>
    createPlatformBackupHandler(await requireEligibleResourceUser(), data)
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
  async () => syncBackupRunsHandler(await requireEligibleResourceUser())
)

export const getBackupPolicy = createServerFn({ method: "GET" })
  .validator(backupPolicyInputSchema)
  .handler(async ({ data }) =>
    getBackupPolicyHandler(await requireEligibleResourceUser(), data)
  )

export const cancelBackup = createServerFn({ method: "POST" })
  .validator(backupIdInputSchema)
  .handler(async ({ data }) =>
    cancelBackupHandler(await requireEligibleResourceUser(), data)
  )

export const deleteBackup = createServerFn({ method: "POST" })
  .validator(backupRemovalInputSchema)
  .handler(async ({ data }) =>
    deleteBackupHandler(await requireEligibleResourceUser(), data)
  )

export const renameBackup = createServerFn({ method: "POST" })
  .validator(renameBackupInputSchema)
  .handler(async ({ data }) =>
    renameBackupHandler(await requireEligibleResourceUser(), data)
  )

export const copyBackupToDestination = createServerFn({ method: "POST" })
  .validator(copyBackupInputSchema)
  .handler(async ({ data }) =>
    copyBackupToDestinationHandler(await requireEligibleResourceUser(), data)
  )

export const getBackupDownloadUrl = createServerFn({ method: "POST" })
  .validator(backupDownloadInputSchema)
  .handler(async ({ data }) => {
    const { setResponseHeader } = await import("@tanstack/react-start/server")
    setResponseHeader("Cache-Control", "no-store")
    const user = await requireEligibleResourceUser()
    return getBackupDownloadUrlHandler(user, data)
  })

export const restoreInstanceBackup = createServerFn({ method: "POST" })
  .validator(backupRestoreInputSchema)
  .handler(async ({ data }) =>
    restoreInstanceBackupHandler(await requireEligibleResourceUser(), data)
  )

export const restoreDatabaseBackup = createServerFn({ method: "POST" })
  .validator(backupRestoreInputSchema)
  .handler(async ({ data }) =>
    restoreDatabaseBackupHandler(await requireEligibleResourceUser(), data)
  )

export const updateBackupLimits = createServerFn({ method: "POST" })
  .validator(backupLimitsInputSchema)
  .handler(async ({ data }) =>
    updateBackupLimitsHandler(await requireEligibleResourceUser(), data)
  )

export const updateBackupExcludes = createServerFn({ method: "POST" })
  .validator(backupExcludesInputSchema)
  .handler(async ({ data }) =>
    updateBackupExcludesHandler(await requireEligibleResourceUser(), data)
  )
