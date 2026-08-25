import { z } from "zod"

import {
  backupArtifactKindSchema,
  backupFilenameSchema,
  backupIdSchema,
  backupModeSchema,
  backupStatusSchema,
  backupTargetKindSchema,
  backupTaskStatusSchema,
} from "./backups.js"
import {
  MAXIMUM_INSTANCE_NAME_LENGTH,
  MINIMUM_INSTANCE_DISK_LIMIT_BYTES,
} from "./instance-limits.js"
import { relayInstanceLifecycleEventSchema } from "./instance-lifecycle.js"
import { relayInstanceStateReasonSchema } from "./instance-state-reason.js"

export const cliAccessModes = ["full_access", "read_only"] as const
export const cliAccessModeSchema = z.enum(cliAccessModes)

export const cliAccessDurations = [
  "1h",
  "1d",
  "1w",
  "30d",
  "indefinite",
] as const
export const cliAccessDurationSchema = z.enum(cliAccessDurations)

export const cliDeviceCodeRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
  })
  .strict()

export const cliDeviceCodeResponseSchema = z
  .object({
    deviceCode: z.string().min(32).max(256),
    expiresAt: z.iso.datetime(),
    interval: z.number().int().min(2).max(30),
    userCode: z.string().regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u),
    verificationUri: z.url(),
    verificationUriComplete: z.url(),
  })
  .strict()

export const cliDeviceTokenRequestSchema = z
  .object({
    deviceCode: z.string().min(32).max(256),
  })
  .strict()

export const cliDeviceTokenResponseSchema = z
  .object({
    accessToken: z.string().startsWith("kiln_cli_"),
    credential: z.object({
      expiresAt: z.iso.datetime().nullable(),
      id: z.uuid(),
      mode: cliAccessModeSchema,
      name: z.string().min(1).max(120),
    }),
    tokenType: z.literal("Bearer"),
  })
  .strict()

export const cliErrorCodes = [
  "access_denied",
  "authentication_required",
  "authorization_pending",
  "conflict",
  "expired_token",
  "forbidden",
  "invalid_grant",
  "invalid_request",
  "not_found",
  "rate_limited",
  "relay_operation_failed",
  "relay_unavailable",
  "sftp_unavailable",
  "slow_down",
  "unexpected_error",
] as const
export const cliErrorCodeSchema = z.enum(cliErrorCodes)

export const cliErrorResponseSchema = z
  .object({
    error: z.object({
      code: cliErrorCodeSchema,
      cause: z.string().trim().min(1).max(240).optional(),
      message: z.string().min(1),
      requestId: z.uuid().optional(),
      retryable: z.boolean(),
    }),
  })
  .strict()

export const cliServerReferenceSchema = z
  .string()
  .regex(/^[A-Za-z\d_-]{43}:[a-f\d]{40}$/u)

const cliStoredServerNameSchema = z.string().min(1).max(120)

export const cliServerSchema = z
  .object({
    id: cliServerReferenceSchema,
    instanceId: z.string().regex(/^[a-f\d]{40}$/u),
    name: cliStoredServerNameSchema,
    relayId: z.string().regex(/^[A-Za-z\d_-]{43}$/u),
    relayName: z.string().min(1).max(120),
    shortId: z.string().min(1).max(40),
    state: z.string().min(1).max(64),
  })
  .strict()

export const cliServersResponseSchema = z
  .object({ servers: z.array(cliServerSchema) })
  .strict()

export const cliTargetSchema = z
  .object({
    instanceId: z.string().regex(/^[a-f\d]{40}$/u),
    relayId: z.string().regex(/^[A-Za-z\d_-]{43}$/u),
  })
  .strict()

const cliBrickVariableValueSchema = z.union([
  z.string().max(4_096),
  z.number().finite(),
  z.boolean(),
])

const cliDiskLimitBytesSchema = z
  .number()
  .int()
  .min(MINIMUM_INSTANCE_DISK_LIMIT_BYTES)

export const cliBrickReferenceSchema = z.union([
  z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/u),
  z
    .url()
    .max(2_048)
    .refine((value) => new URL(value).protocol === "https:", {
      message: "Custom Brick recipes must use HTTPS",
    })
    .refine(
      (value) => {
        const url = new URL(value)
        return !url.username && !url.password
      },
      { message: "Custom Brick recipe URLs cannot contain credentials" }
    ),
])

export const cliRelaySchema = z
  .object({
    arch: z.string().min(1).nullable(),
    canProvisionServers: z.boolean().nullable(),
    id: z.string().regex(/^[A-Za-z\d_-]{43}$/u),
    name: z.string().min(1).max(120),
    platform: z.string().min(1).nullable(),
    serverCount: z.number().int().nonnegative().nullable(),
    status: z.enum(["connected", "unreachable"]),
    version: z.string().min(1).nullable(),
  })
  .strict()

export const cliRelaysResponseSchema = z
  .object({ relays: z.array(cliRelaySchema) })
  .strict()

const cliResourceUsageSchema = z
  .object({
    totalBytes: z.number().nonnegative(),
    usedBytes: z.number().nonnegative(),
  })
  .strict()

export const cliRelayInfoResponseSchema = z
  .object({
    relay: cliRelaySchema,
    node: z
      .object({
        connectedAt: z.string().datetime(),
        cpuCores: z.number().int().positive(),
        cpuLoadPercent: z.number().nonnegative(),
        id: z.string().min(1),
        memory: cliResourceUsageSchema,
        name: z.string().min(1),
        startedAt: z.string().datetime().nullable(),
        storage: cliResourceUsageSchema,
        uptimeSeconds: z.number().nonnegative().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict()

const cliServerResourceSchema = z
  .object({
    cpuPercent: z.number().nonnegative(),
    memoryUsedBytes: z.number().nonnegative(),
    networkReceivedBytes: z.number().nonnegative().nullable(),
    networkSentBytes: z.number().nonnegative().nullable(),
    sampledAt: z.string().datetime(),
    storageUsedBytes: z.number().nonnegative().nullable(),
  })
  .strict()

export const cliServerInfoResponseSchema = z
  .object({
    relay: z
      .object({
        id: z.string().regex(/^[A-Za-z\d_-]{43}$/u),
        name: z.string().min(1).max(120),
      })
      .strict(),
    server: z
      .object({
        brickId: z.string().nullable(),
        brickSource: z.string().url().nullable(),
        connectAddress: z.string().min(1),
        desiredState: z.enum(["stopped", "running"]),
        diskLimitBytes: z.number().int().nonnegative(),
        game: z.string().min(1),
        id: z.string().regex(/^[a-f\d]{40}$/u),
        implementation: z.string().min(1),
        javaVersion: z.string().min(1),
        memoryLimitBytes: z.number().int().nonnegative(),
        name: cliStoredServerNameSchema,
        observedState: z.string().min(1),
        stateReason: relayInstanceStateReasonSchema.nullable().default(null),
        publicAddress: z.string().nullable(),
        lifecycle: z.array(relayInstanceLifecycleEventSchema),
        resources: cliServerResourceSchema.nullable(),
        shortId: z.string().regex(/^[a-f\d]{8}$/u),
        version: z.string().min(1),
      })
      .strict(),
  })
  .strict()

export const cliCreateServerRequestSchema = z
  .object({
    brick: cliBrickReferenceSchema,
    diskLimitBytes: cliDiskLimitBytesSchema,
    name: z
      .string()
      .trim()
      .min(1)
      .max(
        MAXIMUM_INSTANCE_NAME_LENGTH,
        `Names must be ${MAXIMUM_INSTANCE_NAME_LENGTH} characters or fewer`
      ),
    relayId: z.string().regex(/^[A-Za-z\d_-]{43}$/u),
    start: z.boolean().default(true),
    variables: z
      .record(z.string().min(1).max(120), cliBrickVariableValueSchema)
      .default({}),
  })
  .strict()

export const cliUpdateServerStartupRequestSchema = cliTargetSchema
  .extend({
    brick: cliBrickReferenceSchema.optional(),
    diskLimitBytes: cliDiskLimitBytesSchema.optional(),
    start: z.boolean().default(true),
    variables: z
      .record(z.string().min(1).max(120), cliBrickVariableValueSchema)
      .default({}),
  })
  .strict()
  .refine(
    (value) =>
      value.brick !== undefined ||
      value.diskLimitBytes !== undefined ||
      Object.keys(value.variables).length > 0,
    "Provide a Brick, disk limit, or startup variable"
  )

export const cliDeleteServerRequestSchema = cliTargetSchema
  .extend({ confirmation: cliServerReferenceSchema })
  .strict()

export const cliServerMutationResponseSchema = z
  .object({
    relayId: z.string(),
    server: cliServerInfoResponseSchema.shape.server,
  })
  .strict()

export const cliDeleteServerResponseSchema = z
  .object({
    deleted: z.literal(true),
    instanceId: z.string(),
    relayId: z.string(),
  })
  .strict()

export const cliBackupSchema = z
  .object({
    artifactKind: backupArtifactKindSchema,
    backupMode: backupModeSchema,
    bytes: z.number().int().nonnegative().nullable(),
    createdAt: z.iso.datetime(),
    destinations: z.array(z.enum(["local", "s3"])).min(1),
    filename: backupFilenameSchema.nullable(),
    id: backupIdSchema,
    name: z.string().min(1).max(120),
    relayId: z.string().regex(/^[A-Za-z\d_-]{43}$/u),
    status: backupStatusSchema,
    targetId: z.string().min(1).max(120),
    targetKind: backupTargetKindSchema,
    taskError: z.string().nullable(),
    taskStatus: backupTaskStatusSchema,
  })
  .strict()

export const cliBackupsResponseSchema = z
  .object({ backups: z.array(cliBackupSchema) })
  .strict()

export const cliBackupTargetSchema = z
  .object({
    kind: z.enum(["server", "database", "platform"]),
    name: z.string().min(1).max(120),
    reference: z.string().min(1).max(256),
    relayName: z.string().min(1).max(120),
  })
  .strict()

export const cliBackupTargetsResponseSchema = z
  .object({ targets: z.array(cliBackupTargetSchema) })
  .strict()

const cliCreateBackupBaseSchema = z.object({
  mode: backupModeSchema.optional(),
  name: z.string().trim().min(1).max(120),
  relayId: z.string().regex(/^[A-Za-z\d_-]{43}$/u),
  storageId: z.union([z.uuid(), z.null()]).optional(),
})

export const cliCreateBackupRequestSchema = z.discriminatedUnion("targetKind", [
  cliCreateBackupBaseSchema
    .extend({
      targetId: z.string().min(1).max(120),
      targetKind: z.literal("instance"),
    })
    .strict(),
  cliCreateBackupBaseSchema
    .extend({
      targetId: z.string().min(1).max(120),
      targetKind: z.literal("database"),
    })
    .strict(),
  cliCreateBackupBaseSchema
    .extend({ targetKind: z.literal("platform") })
    .strict(),
])

export const cliBackupMutationResponseSchema = z
  .object({
    backupId: backupIdSchema,
    relayAccepted: z.boolean(),
    taskId: z.uuid(),
  })
  .strict()

export const cliRestoreBackupRequestSchema = z
  .object({ backupId: backupIdSchema, safetyBackup: z.boolean().default(true) })
  .strict()

export const cliRestoreBackupResponseSchema = z
  .object({
    relayAccepted: z.boolean(),
    restoreTaskId: z.uuid(),
    safetyBackupId: backupIdSchema.nullable(),
  })
  .strict()

export const cliDeleteBackupRequestSchema = z
  .object({ backupId: backupIdSchema, confirmation: backupIdSchema })
  .strict()

export const cliDeleteBackupResponseSchema = z
  .object({ backupId: backupIdSchema, relayAccepted: z.boolean() })
  .strict()

export const cliBackupDownloadRequestSchema = z
  .object({ backupId: backupIdSchema, poll: z.boolean().default(false) })
  .strict()

export const cliBackupDownloadResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("preparing"),
      taskId: z.uuid(),
    })
    .strict(),
  z
    .object({
      expiresAt: z.iso.datetime(),
      filename: backupFilenameSchema,
      status: z.literal("ready"),
      url: z.url().refine((value) => new URL(value).protocol === "https:", {
        message: "Backup downloads must use HTTPS",
      }),
    })
    .strict(),
])

export const cliActivityEntrySchema = z
  .object({
    actor: z
      .object({
        email: z.email().nullable(),
        id: z.string().min(1),
        name: z.string().min(1),
      })
      .strict(),
    id: z.string().min(1),
    label: z.string().min(1),
    occurredAt: z.number().int().nonnegative(),
    permission: z.string().nullable(),
    relay: z.object({ id: z.string(), name: z.string().min(1) }).strict(),
    server: z
      .object({
        id: z.string(),
        name: cliStoredServerNameSchema,
      })
      .strict()
      .nullable(),
    source: z.enum(["web", "cli"]),
    type: z.enum([
      "server",
      "power",
      "console",
      "files",
      "network",
      "access",
      "relay",
      "updates",
      "system",
    ]),
  })
  .strict()

export const cliActivityResponseSchema = z
  .object({ entries: z.array(cliActivityEntrySchema) })
  .strict()

export const cliRemoteFileUploadResponseSchema = z
  .object({
    modifiedAt: z.string().datetime(),
    path: z.string().min(1).max(2_048),
    sha256: z.string().regex(/^[a-f\d]{64}$/u),
    size: z.number().int().nonnegative(),
  })
  .strict()

export const cliPowerActionSchema = z.enum(["start", "stop", "restart", "kill"])

export const cliPowerRequestSchema = cliTargetSchema
  .extend({ action: cliPowerActionSchema })
  .strict()

export const cliPowerResponseSchema = z
  .object({
    action: cliPowerActionSchema,
    instance: cliServerInfoResponseSchema.shape.server.pick({
      desiredState: true,
      id: true,
      name: true,
      observedState: true,
    }),
    relayId: cliTargetSchema.shape.relayId,
  })
  .strict()

export const cliConsoleRequestSchema = cliTargetSchema
  .extend({
    command: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine((value) => !/[\r\n]/u.test(value), "Command must be one line"),
  })
  .strict()

export const cliFileTargetSchema = cliTargetSchema
  .extend({
    path: z
      .string()
      .min(1)
      .max(2_048)
      .refine(
        (path) =>
          !path.includes("\0") &&
          !path.startsWith("/") &&
          !path.split(/[\\/]/u).includes(".."),
        "Path must be relative to the server root"
      ),
  })
  .strict()

export const cliRemoteFileUploadRequestSchema = cliFileTargetSchema
  .extend({
    url: z
      .url()
      .max(2_048)
      .refine((value) => new URL(value).protocol === "https:", {
        message: "Remote file URLs must use HTTPS",
      })
      .refine(
        (value) => {
          const url = new URL(value)
          return !url.username && !url.password
        },
        { message: "Remote file URLs cannot contain credentials" }
      ),
  })
  .strict()

export const cliFileWriteRequestSchema = cliFileTargetSchema
  .extend({
    content: z.string().max(16 * 1024 * 1024),
    expectedModifiedAt: z.number().nonnegative().nullable().optional(),
  })
  .strict()

export const cliSftpResponseSchema = z
  .object({
    host: z.string().min(1).max(253),
    hostKeyFingerprint: z.string().startsWith("SHA256:"),
    port: z.number().int().min(1).max(65_535),
    root: z.string().startsWith("/"),
    username: z.email(),
  })
  .strict()

export type CliAccessDuration = z.infer<typeof cliAccessDurationSchema>
export type CliAccessMode = z.infer<typeof cliAccessModeSchema>
export type CliDeviceCodeResponse = z.infer<typeof cliDeviceCodeResponseSchema>
export type CliDeviceTokenResponse = z.infer<
  typeof cliDeviceTokenResponseSchema
>
export type CliErrorCode = z.infer<typeof cliErrorCodeSchema>
export type CliPowerResponse = z.infer<typeof cliPowerResponseSchema>
export type CliServer = z.infer<typeof cliServerSchema>
export type CliSftpResponse = z.infer<typeof cliSftpResponseSchema>
