import { z } from "zod"

import { instanceIdSchema } from "./instance-id.js"

import { relayTailscaleSubdomainSchema } from "./tailscale.js"

const backupHttpsUrlSchema = z
  .url()
  .max(8_192)
  .refine((value) => new URL(value).protocol === "https:", {
    message: "Backup URLs must use HTTPS",
  })

const hasUnsafeControlCharacter = (value: string) =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127)
  })

export const backupObjectKeySchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !value.startsWith("/"), {
    message: "Backup object keys must be relative",
  })
  .refine((value) => !value.split("/").includes(".."), {
    message: "Backup object keys cannot traverse parent directories",
  })
  .refine((value) => !hasUnsafeControlCharacter(value), {
    message: "Backup object keys cannot contain control characters",
  })

export const backupIdSchema = z.uuid()
export const backupTaskIdSchema = z.uuid()

/**
 * Finishes or abandons a restore of a volume whose swap
 * didn't finish, which keeps its target fenced until then.
 */
export const backupRestoreResolveSchema = z.strictObject({
  action: z.enum(["abandon", "finish"]),
  taskId: backupTaskIdSchema,
})

export const backupChecksumSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)

export const resticSnapshotIdSchema = z.string().regex(/^[a-f0-9]{8,64}$/u)

export const backupRepositoryPasswordSchema = z.string().min(1).max(1_024)

export const backupFilenameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !value.includes("/") &&
      !value.includes("\\") &&
      !hasUnsafeControlCharacter(value),
    { message: "Backup filenames must be a single safe path segment" }
  )

// `volume` is a volume Kiln manages, named by its ID. An App is no target:
// it is backed up as the volumes it uses.
export const backupTargetKindSchema = z.enum([
  "instance",
  "database",
  "platform",
  "volume",
])

// `tar_archive` is a volume as Docker reads it, gzipped,
// with each file's owner, mode, and extended attributes, and its symlinks.
export const backupArtifactKindSchema = z.enum([
  "archive",
  "database_dump",
  "platform_bundle",
  "restic_snapshot",
  "tar_archive",
])

// A live backup copies the resource while it runs, as a crash would leave
// it. A stopped one stops what uses it first and starts again what was
// running, for data a live copy can't capture safely, such as a database's
// files. A final backup is always stopped, and nothing starts again.
export const backupConsistencySchema = z.enum(["live", "stopped"])

export const backupModeSchema = z.enum(["full", "incremental"])

export const backupReasonSchema = z.enum([
  "manual",
  "pre_restore",
  "final_delete",
  "scheduled",
])

export const backupStatusSchema = z.enum([
  "queued",
  "running",
  "available",
  "failed",
  "deleting",
  "deleted",
])

export const backupTaskKindSchema = z.enum([
  "create",
  "restore",
  "delete",
  "export",
  "prune",
])

export const backupTaskStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
])

export const backupTaskPhaseSchema = z.enum([
  "preparing",
  "collecting",
  "archiving",
  "dumping",
  "uploading",
  "finalizing",
])

export const backupArtifactStatusSchema = z.enum([
  "queued",
  "running",
  "available",
  "failed",
  "deleting",
  "deleted",
])

/**
 * Why a backup task failed, when the Relay can tell. Most name something
 * outside Kiln, such as a storage provider refusing writes, so Hearth can say
 * where to fix it. Readers treat an unknown code like no code.
 */
export const backupFailureCodes = [
  // The provider's storage cap or quota is reached; it refuses new data.
  "storage_full",
  // Another account limit, such as a daily transaction or download cap.
  "storage_limit_reached",
  "storage_access_denied",
  "storage_bucket_missing",
  "storage_unreachable",
  // Another restic process holds the repository lock.
  "repository_locked",
  "repository_password_incorrect",
  "relay_disk_full",
  "timed_out",
] as const

export type BackupFailureCode = (typeof backupFailureCodes)[number]

// Checked in order: providers refuse an over-cap write with a 403, so the cap
// patterns must win over access denied.
const backupFailurePatterns: ReadonlyArray<
  readonly [BackupFailureCode, RegExp]
> = [
  [
    "storage_full",
    // Backblaze B2, S3 and MinIO, in that order.
    /storage cap exceeded|QuotaExceeded|XMinioStorageFull|minimum free drive threshold|InsufficientStorage|\bHTTP 507\b|quota (?:has been )?exceeded/iu,
  ],
  // Backblaze B2's daily transaction and download bandwidth caps; its
  // storage cap matched above.
  ["storage_limit_reached", /cap exceeded/iu],
  [
    "storage_bucket_missing",
    /NoSuchBucket|bucket does not exist|bucket not found/iu,
  ],
  [
    "storage_access_denied",
    /AccessDenied|Access Denied|InvalidAccessKeyId|SignatureDoesNotMatch|InvalidToken|ExpiredToken|access key id you provided does not exist|\bHTTP 40[13]\b|\b403 Forbidden\b/iu,
  ],
  ["repository_locked", /repository is already locked/iu],
  ["relay_disk_full", /no space left on device|\bENOSPC\b/iu],
  [
    "storage_unreachable",
    /no such host|connection refused|network is unreachable|i\/o timeout|tls handshake|connection reset|dial tcp|S3 backup request timed out/iu,
  ],
]

/**
 * Names a failure from its message when it matches one a storage provider,
 * restic, or the filesystem is known to give, such as Backblaze's
 * "storage cap exceeded".
 */
export function backupFailureCodeFromMessage(
  message: string
): BackupFailureCode | null {
  for (const [code, pattern] of backupFailurePatterns) {
    if (pattern.test(message)) return code
  }
  return null
}

// A string rather than the enum, so codes a newer Relay sends still parse.
const backupFailureCodeWireSchema = z.string().min(1).max(64)

export const backupTargetSchema = z
  .object({
    // Long enough for an App's Compose volume, `<App ID>/<key>`.
    id: z.string().min(1).max(200),
    kind: backupTargetKindSchema,
  })
  .strict()

/**
 * A restore of a volume whose swap began and didn't finish, fencing its
 * target until it's finished or abandoned.
 */
export const backupUnfinishedRestoreSchema = z.strictObject({
  phase: z.enum(["clearing", "installing"]),
  target: backupTargetSchema.refine((target) => target.kind === "volume"),
  taskId: backupTaskIdSchema,
})
export const backupUnfinishedRestoresSchema = z.array(
  backupUnfinishedRestoreSchema
)
export type BackupUnfinishedRestore = z.infer<
  typeof backupUnfinishedRestoreSchema
>

/**
 * A copy on the Relay's own disk. The Relay's disk is a destination under
 * the Relay's ID, which a task Hearth sends names (`destinationId`): a
 * Relay keeps no copy meant for another's disk. One stored before tasks
 * named it says nothing, and is the Relay's own.
 */
export const backupLocalDestinationSchema = z
  .object({
    artifactId: z.uuid().optional(),
    destinationId: instanceIdSchema.optional(),
    kind: z.literal("local"),
  })
  .strict()

export const resticS3BucketSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9.-]{1,61}[A-Za-z0-9]$/u, {
    message:
      "Bucket names must be 3 to 63 characters, start and end with a letter or number, and contain only letters, numbers, periods, or hyphens",
  })

export const resticS3RegionSchema = z
  .string()
  .max(120, { message: "S3 regions must be 120 characters or fewer" })
  .regex(/^[a-z0-9-]+$/u, {
    message:
      "S3 regions must contain only lowercase letters, digits, and hyphens",
  })

export const resticRepositoryPrefixSchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(/^[A-Za-z0-9._/-]+$/u, {
    message:
      "Restic repository prefixes can contain only letters, digits, dots, underscores, slashes, and hyphens",
  })
  .refine((value) => !value.startsWith("/"), {
    message: "Backup object keys must be relative",
  })
  .refine((value) => !value.split("/").includes(".."), {
    message: "Backup object keys cannot traverse parent directories",
  })
  .refine((value) => !hasUnsafeControlCharacter(value), {
    message: "Backup object keys cannot contain control characters",
  })

const resticS3EndpointSchema = backupHttpsUrlSchema.refine(
  (value) => {
    const endpoint = new URL(value)
    const port = endpoint.port ? Number(endpoint.port) : 443
    return (
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.search &&
      !endpoint.hash &&
      (endpoint.pathname === "/" || endpoint.pathname === "") &&
      Number.isSafeInteger(port) &&
      port >= 1 &&
      port <= 65_535
    )
  },
  {
    message:
      "Restic S3 endpoints must be an HTTPS origin without credentials, a path, query, or fragment",
  }
)

export const backupS3CredentialSchema = z
  .object({
    accessKeyId: z.string().min(1).max(512),
    allowPrivateNetwork: z.boolean().default(false),
    bucket: resticS3BucketSchema,
    endpoint: resticS3EndpointSchema,
    forcePathStyle: z.boolean().default(false),
    region: resticS3RegionSchema,
    secretAccessKey: z.string().min(1).max(2_048),
  })
  .strict()

/**
 * A copy in a bucket that the Relay holds nothing of. Hearth keeps the
 * bucket's keys and chooses its paths, so a task names only the copy, and
 * the Relay asks Hearth for access as it is ready to send, read or delete
 * it (`backup.storage.access`).
 *
 * Read loosely: a Relay keeps the tasks it stored, and Hearth once sent a
 * signed URL and a path with one, and the bucket's keys with a schedule's.
 * Those are read and dropped. The path such a Relay uploaded a scheduled
 * backup to is kept (`objectKey`), for Hearth to find one it hadn't
 * cataloged; nothing sends one now.
 */
export const backupS3CopyDestinationSchema = z.object({
  artifactId: z.uuid().optional(),
  destinationId: instanceIdSchema.optional(),
  kind: z.literal("s3"),
  objectKey: z.string().min(1).max(1_024).optional(),
})

export const backupS3UploadDestinationSchema = backupS3CopyDestinationSchema

const resticLocalRepositoryLocationSchema = z
  .object({
    kind: z.literal("local"),
  })
  .strict()

const resticS3RepositoryLocationObjectSchema = backupS3CredentialSchema
  .partial({ accessKeyId: true, secretAccessKey: true })
  .safeExtend({
    kind: z.literal("s3"),
    repositoryPrefix: resticRepositoryPrefixSchema,
  })
  .strict()

export const resticRepositoryLocationSchema = z.discriminatedUnion("kind", [
  resticLocalRepositoryLocationSchema,
  resticS3RepositoryLocationObjectSchema,
])

const defaultLocalResticRepository = { kind: "local" as const }

export const backupResticDestinationSchema = z
  .object({
    artifactId: z.uuid().optional(),
    kind: z.literal("restic"),
    repository: resticRepositoryLocationSchema.default(
      defaultLocalResticRepository
    ),
    repositoryPassword: backupRepositoryPasswordSchema.optional(),
  })
  .strict()

const backupArchiveDestinationSchema = z.union([
  backupLocalDestinationSchema,
  backupS3UploadDestinationSchema,
])

const backupCreateTaskInputObjectSchema = z
  .object({
    artifactKind: backupArtifactKindSchema,
    backupId: backupIdSchema,
    catalog: z
      .object({
        name: z.string().trim().min(1).max(120),
        // The App's batch a scheduled backup of a volume it
        // owns belongs to, which Hearth catalogs it under.
        batchId: z.uuid().optional(),
        // The repository an incremental scheduled backup goes to.
        repositoryId: z.uuid().optional(),
        // The schedule and its step a scheduled backup was taken for.
        // Hearth admits a backup for a bucket against that step, as its
        // own record of the schedule has it.
        schedule: z
          .object({ actionId: z.uuid(), id: z.uuid() })
          .strict()
          .optional(),
        storageId: instanceIdSchema.nullable(),
      })
      .strict()
      .optional(),
    /**
     * A stopped backup of a volume started with others,
     * as backing up an App starts each owned volume's: the
     * Relay copies them all within one stopped window, so they agree.
     */
    batch: z
      .object({ id: z.uuid(), size: z.number().int().min(2).max(64) })
      .strict()
      .optional(),
    // No longer sent or used. A Relay keeps the backups it made, and a
    // scheduled backup of an App once carried the volumes it was sent to
    // take, so one stored with them is still read.
    appCoverage: z.unknown().optional(),
    // Absent is live.
    consistency: backupConsistencySchema.optional(),
    destination: z.union([
      backupLocalDestinationSchema,
      backupS3UploadDestinationSchema,
      backupResticDestinationSchema,
    ]),
    exclude: z.array(z.string().min(1).max(1_024)).max(1_000),
    maxBytes: z.number().int().positive().nullable(),
    mode: backupModeSchema,
    reason: backupReasonSchema,
    replicas: z.array(backupArchiveDestinationSchema).max(15).optional(),
    target: backupTargetSchema,
    taskId: backupTaskIdSchema,
  })
  .strict()

function refineResticCreateInput(
  input: z.infer<typeof backupCreateTaskInputObjectSchema>,
  context: z.RefinementCtx
) {
  const resource = input.target.kind === "volume"
  if (resource !== (input.artifactKind === "tar_archive")) {
    context.addIssue({
      code: "custom",
      message: "Volumes, and only they, are backed up as tar archives",
      path: ["artifactKind"],
    })
  }
  // A database isn't stopped. In a stopped batch it is dumped within the
  // batch's stopped window, with the Apps of the batch's volumes stopped.
  const withStopped = input.target.kind === "database" && input.batch
  if (input.consistency === "stopped" && !resource && !withStopped) {
    context.addIssue({
      code: "custom",
      message:
        "Only volumes are backed up stopped, or a database backed up in a batch with them",
      path: ["consistency"],
    })
  }
  // A stored scheduled backup of an App, from when a live one carried a
  // batch too, is still read.
  if (input.batch && input.consistency !== "stopped" && !input.appCoverage) {
    context.addIssue({
      code: "custom",
      message: "Only stopped backups share a stopped window",
      path: ["batch"],
    })
  }
  const restic = input.destination.kind === "restic"
  if (restic) {
    if ((input.replicas?.length ?? 0) > 0) {
      context.addIssue({
        code: "custom",
        message: "Restic backups cannot replicate to additional destinations",
        path: ["replicas"],
      })
    }
    if (input.mode !== "incremental") {
      context.addIssue({
        code: "custom",
        message: "Restic destinations require incremental mode",
        path: ["mode"],
      })
    }
    if (input.artifactKind !== "restic_snapshot") {
      context.addIssue({
        code: "custom",
        message: "Restic destinations require a restic_snapshot artifact",
        path: ["artifactKind"],
      })
    }
    if (input.target.kind !== "instance") {
      context.addIssue({
        code: "custom",
        message: "Restic backups are only supported for instance targets",
        path: ["target", "kind"],
      })
    }
    return
  }
  if (input.mode === "incremental") {
    context.addIssue({
      code: "custom",
      message: "Incremental backups require a restic destination",
      path: ["destination", "kind"],
    })
  }
  if (input.artifactKind === "restic_snapshot") {
    context.addIssue({
      code: "custom",
      message: "restic_snapshot artifacts require a restic destination",
      path: ["artifactKind"],
    })
  }
}

export const backupCreateTaskInputSchema =
  backupCreateTaskInputObjectSchema.superRefine(refineResticCreateInput)

export const backupLocalSourceSchema = z
  .object({
    bytes: z.number().int().nonnegative(),
    checksumSha256: backupChecksumSha256Schema,
    kind: z.literal("local"),
  })
  .strict()

// An archive in a bucket, read with access the Relay asks Hearth for
// (`backupS3CopyDestinationSchema`). Read loosely, as that is: the signed
// URL an older Hearth sent with one is dropped.
export const backupRemoteSourceSchema = z.object({
  artifactId: z.uuid().optional(),
  bytes: z.number().int().nonnegative(),
  checksumSha256: backupChecksumSha256Schema,
  kind: z.literal("remote"),
})

export const backupResticSourceSchema = z
  .object({
    kind: z.literal("restic"),
    repository: resticRepositoryLocationSchema.default(
      defaultLocalResticRepository
    ),
    repositoryPassword: backupRepositoryPasswordSchema.optional(),
    snapshotId: resticSnapshotIdSchema,
  })
  .strict()

/**
 * The backup and server an archive was made as, when it's linked to another
 * server: a duplicated or moved game server's copy restores the original's
 * archive, under a catalog record of its own.
 */
export const backupArchiveIdentitySchema = z
  .object({
    backupId: backupIdSchema,
    /**
     * The server's old ID, for an archive made before 12-character instance
     * IDs, which names it so in its manifest: Hearth knows every old ID,
     * while a Relay knows only its own.
     */
    legacyTargetId: z
      .string()
      .regex(/^[a-f0-9]{40}$/u)
      .optional(),
    targetId: backupTargetSchema.shape.id,
  })
  .strict()

export const backupRestoreTaskInputSchema = z
  .object({
    archive: backupArchiveIdentitySchema.optional(),
    backupId: backupIdSchema,
    source: z.discriminatedUnion("kind", [
      backupLocalSourceSchema,
      backupRemoteSourceSchema,
      backupResticSourceSchema,
    ]),
    target: backupTargetSchema,
    taskId: backupTaskIdSchema,
  })
  .strict()

export const backupDeleteTaskInputSchema = z
  .object({
    archive: backupArchiveIdentitySchema.optional(),
    backupId: backupIdSchema,
    destination: z.discriminatedUnion("kind", [
      backupLocalDestinationSchema,
      backupS3CopyDestinationSchema,
      backupResticDestinationSchema.extend({
        createTaskId: backupTaskIdSchema.optional(),
        snapshotId: resticSnapshotIdSchema.optional(),
      }),
    ]),
    replicas: z
      .array(
        z.discriminatedUnion("kind", [
          backupLocalDestinationSchema,
          backupS3CopyDestinationSchema,
        ])
      )
      .max(15)
      .optional(),
    target: backupTargetSchema,
    taskId: backupTaskIdSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.destination.kind !== "restic") return
    if ((input.replicas?.length ?? 0) > 0) {
      context.addIssue({
        code: "custom",
        message: "Restic deletes cannot target additional destinations",
        path: ["replicas"],
      })
    }
    const hasSnapshot = input.destination.snapshotId !== undefined
    const hasCreateTask = input.destination.createTaskId !== undefined
    if (hasSnapshot === hasCreateTask) {
      context.addIssue({
        code: "custom",
        message:
          "Restic deletes require exactly one of snapshotId or createTaskId",
        path: ["destination", hasSnapshot ? "createTaskId" : "snapshotId"],
      })
    }
  })

export const BACKUP_EXPORT_TTL_MIN_MS = 60_000
export const BACKUP_EXPORT_TTL_MAX_MS = 7 * 24 * 60 * 60 * 1_000

export const backupExportTtlMsSchema = z
  .number()
  .int()
  .min(BACKUP_EXPORT_TTL_MIN_MS)
  .max(BACKUP_EXPORT_TTL_MAX_MS)

export const backupExportTaskInputSchema = z
  .object({
    backupId: backupIdSchema,
    repository: resticRepositoryLocationSchema.default(
      defaultLocalResticRepository
    ),
    repositoryPassword: backupRepositoryPasswordSchema.optional(),
    snapshotId: resticSnapshotIdSchema,
    target: backupTargetSchema,
    taskId: backupTaskIdSchema,
    ttlMs: backupExportTtlMsSchema,
  })
  .strict()

export const backupPruneTaskInputSchema = z
  .object({
    backupId: backupIdSchema,
    repository: resticRepositoryLocationSchema.default(
      defaultLocalResticRepository
    ),
    repositoryPassword: backupRepositoryPasswordSchema.optional(),
    target: backupTargetSchema,
    taskId: backupTaskIdSchema,
  })
  .strict()

export const backupTaskInputSchema = z.discriminatedUnion("kind", [
  backupCreateTaskInputObjectSchema
    .extend({ kind: z.literal("create") })
    .superRefine(refineResticCreateInput),
  backupRestoreTaskInputSchema.extend({ kind: z.literal("restore") }),
  backupDeleteTaskInputSchema.extend({ kind: z.literal("delete") }),
  backupExportTaskInputSchema.extend({ kind: z.literal("export") }),
  backupPruneTaskInputSchema.extend({ kind: z.literal("prune") }),
])

const backupArtifactOutcomeSchema = z
  .object({
    artifactId: z.uuid(),
    error: z.string().max(4_096).nullable(),
    errorCode: backupFailureCodeWireSchema.nullable().optional(),
    status: z.enum(["available", "failed"]),
  })
  .strict()

export const backupArchiveCreateTaskResultSchema = z
  .object({
    artifacts: z.array(backupArtifactOutcomeSchema).max(16).optional(),
    bytes: z.number().int().nonnegative(),
    checksumSha256: backupChecksumSha256Schema,
    // How an App's or volume's backup was taken.
    consistency: backupConsistencySchema.optional(),
    filename: backupFilenameSchema,
    warnings: z.array(z.string().max(1_024)).max(1_000),
  })
  .strict()

export const backupResticCreateTaskResultSchema = z
  .object({
    artifacts: z.array(backupArtifactOutcomeSchema).max(16).optional(),
    bytes: z.number().int().nonnegative(),
    snapshotId: resticSnapshotIdSchema,
    warnings: z.array(z.string().max(1_024)).max(1_000),
  })
  .strict()

export const backupCreateTaskResultSchema = z.union([
  backupArchiveCreateTaskResultSchema,
  backupResticCreateTaskResultSchema,
])

export const backupExportTaskResultSchema = z
  .object({
    bytes: z.number().int().nonnegative(),
    checksumSha256: backupChecksumSha256Schema,
    expiresAt: z.number().int().positive(),
    filename: backupFilenameSchema,
    warnings: z.array(z.string().max(1_024)).max(1_000),
  })
  .strict()

const backupArchiveManifestV1Schema = z
  .object({
    artifactKind: z.literal("archive"),
    backupId: backupIdSchema,
    createdAt: z.string().datetime(),
    formatVersion: z.literal(1),
    mode: z.literal("full"),
    target: backupTargetSchema.refine((target) => target.kind === "instance", {
      message: "Archive manifests require an instance target",
    }),
  })
  .strict()

const backupArchiveServerConfigurationSchema = z
  .object({
    brick: z
      .object({
        consoleStopCommands: z.array(z.string().trim().min(1).max(128)).max(8),
        format: z.string().min(1).nullable(),
        id: z
          .string()
          .regex(/^[a-z0-9][a-z0-9.-]{0,63}$/u)
          .nullable(),
        networkMode: z.enum(["direct", "minecraft-backend"]).nullable(),
        primaryPort: z.number().int().min(1).max(65_535).nullable(),
        primaryPortProtocol: z.enum(["tcp", "udp", "both"]).nullable(),
        readiness: z
          .object({
            logs: z.array(z.string().trim().min(1).max(256)).min(1).max(8),
          })
          .strict()
          .nullable(),
        source: z.string().trim().url().max(2_048).nullable(),
        supportsSrv: z.boolean(),
      })
      .strict(),
    game: z.string().min(1),
    implementation: z.string().min(1),
    javaVersion: z.string().min(1),
    name: z.string().trim().min(1).max(120),
    network: z
      .object({
        connectAddress: z.string().min(1),
        ports: z
          .array(
            z
              .object({
                externalPort: z.number().int().min(1).max(65_535),
                id: z
                  .string()
                  .regex(
                    /^(?:primary|brick-[a-z0-9][a-z0-9-]{0,31}|[a-f0-9]{8})$/u
                  ),
                internalPort: z.number().int().min(1).max(65_535),
                kind: z.enum(["primary", "brick", "custom"]),
                name: z.string().trim().min(1).max(32),
                protocol: z.enum(["tcp", "udp", "both"]),
              })
              .strict()
          )
          .max(16),
        publicHost: z.string().min(1).max(253).nullable(),
        publicPort: z.number().int().min(1).max(65_535).nullable(),
        webRoutes: z
          .array(
            z
              .object({
                hostname: z.string().trim().toLowerCase().min(1).max(253),
                // Written only when they differ from the defaults, so
                // Relays that predate them can still read the manifest.
                httpsRedirect: z.literal(false).optional(),
                id: z.union([z.string().regex(/^[a-f0-9]{8}$/u), z.uuid()]),
                name: z.string().trim().min(1).max(32),
                path: z.string().trim().min(1).max(256).nullable(),
                // Backups made before Hearth kept primary addresses mark
                // the route that was. Nothing reads it.
                primary: z.literal(true).optional(),
                redirect: z
                  .object({
                    permanent: z.boolean(),
                    preservePath: z.boolean(),
                    to: z.string().min(1).max(2_048),
                  })
                  .strict()
                  .optional(),
                stripPrefix: z.boolean(),
                targetPort: z.number().int().min(1).max(65_535).nullable(),
                www: z.enum(["redirect", "serve"]).optional(),
              })
              .strict()
          )
          .max(16),
      })
      .strict(),
    startup: z
      .object({
        limits: z
          .object({
            diskBytes: z.number().int().nonnegative(),
            memoryBytes: z.number().int().nonnegative(),
          })
          .strict(),
        // Backups made before Tailscale networks recorded the game server's
        // own Tailscale settings. Nothing reads them.
        tailscale: z
          .object({
            enabled: z.boolean(),
            subdomain: relayTailscaleSubdomainSchema.optional(),
          })
          .strict()
          .optional(),
        variables: z.record(
          z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u),
          z.union([z.string().max(8_192), z.number().finite(), z.boolean()])
        ),
      })
      .strict(),
    version: z.string().min(1),
  })
  .strict()

const backupArchiveManifestV2Schema = backupArchiveManifestV1Schema.extend({
  formatVersion: z.literal(2),
  server: backupArchiveServerConfigurationSchema,
})

const backupArchiveManifestV3Schema = backupArchiveManifestV1Schema.extend({
  formatVersion: z.literal(3),
  server: backupArchiveServerConfigurationSchema.extend({
    brick: backupArchiveServerConfigurationSchema.shape.brick.extend({
      recipe: z.unknown().nullable(),
      snapshotSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .nullable(),
    }),
  }),
})

export const backupArchiveManifestSchema = z.discriminatedUnion(
  "formatVersion",
  [
    backupArchiveManifestV1Schema,
    backupArchiveManifestV2Schema,
    backupArchiveManifestV3Schema,
  ]
)

/**
 * The manifest a tar archive of a volume begins with, at
 * `.kiln-backup/manifest.json`. Its data follows under `data/`.
 */
export const backupTarManifestSchema = z
  .object({
    artifactKind: z.literal("tar_archive"),
    backupId: backupIdSchema,
    consistency: backupConsistencySchema,
    createdAt: z.string().datetime(),
    formatVersion: z.literal(1),
    mode: z.literal("full"),
    target: backupTargetSchema.refine((target) => target.kind === "volume", {
      message: "Tar archive manifests require a volume target",
    }),
    // The volume as it was when backed up.
    volume: z
      .object({
        dockerName: z.string().min(1).max(255),
        kind: z.enum(["app", "kiln"]),
        name: z.string().max(255),
      })
      .strict()
      .nullable(),
  })
  .strict()

export const backupDownloadCapabilityPayloadSchema = z
  .object({
    action: z.literal("backup.download"),
    audience: z.string().min(1).max(120),
    backupId: backupIdSchema,
    capabilityId: z.uuid(),
    expiresAt: z.number().int().positive(),
    filename: backupFilenameSchema,
    issuedAt: z.number().int().positive(),
    issuer: z.string().min(1).max(120),
    subject: z.string().min(1).max(120),
    version: z.literal(1),
  })
  .strict()

export const backupOperationTaskResultSchema = z
  .object({
    artifacts: z
      .array(
        z
          .object({
            artifactId: z.uuid(),
            error: z.string().max(4_096).nullable(),
            errorCode: backupFailureCodeWireSchema.nullable().optional(),
            status: z.enum(["deleted", "failed"]),
          })
          .strict()
      )
      .max(16)
      .optional(),
    warnings: z.array(z.string().max(1_024)).max(1_000),
  })
  .strict()

export const backupTaskResultSchema = z.union([
  backupArchiveCreateTaskResultSchema,
  backupResticCreateTaskResultSchema,
  backupExportTaskResultSchema,
  backupOperationTaskResultSchema,
])

export const relayBackupTaskSchema = z
  .object({
    backupId: backupIdSchema,
    bytesCompleted: z.number().int().nonnegative(),
    bytesTotal: z.number().int().nonnegative().nullable(),
    createdAt: z.number().int().nonnegative(),
    currentArtifactId: z.uuid().nullable().default(null),
    currentPath: z.string().max(2_048).nullable().default(null),
    error: z.string().max(4_096).nullable(),
    errorCode: backupFailureCodeWireSchema.nullable().default(null),
    finishedAt: z.number().int().nonnegative().nullable(),
    input: backupTaskInputSchema,
    inputRefreshRequired: z.boolean(),
    kind: backupTaskKindSchema,
    phase: backupTaskPhaseSchema.nullable().default(null),
    result: backupTaskResultSchema.nullable(),
    startedAt: z.number().int().nonnegative().nullable(),
    status: backupTaskStatusSchema,
    taskId: backupTaskIdSchema,
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((task, context) => {
    if (
      task.kind !== task.input.kind ||
      task.backupId !== task.input.backupId ||
      task.taskId !== task.input.taskId
    ) {
      context.addIssue({
        code: "custom",
        message: "Backup task metadata must match its input",
      })
    }
    if (task.status !== "succeeded") return
    if (!task.result) {
      context.addIssue({
        code: "custom",
        message: "Succeeded backup tasks require a result",
      })
      return
    }
    if (task.kind === "create" && task.input.kind === "create") {
      const restic = task.input.destination.kind === "restic"
      if (restic && !isResticCreateTaskResult(task.result)) {
        context.addIssue({
          code: "custom",
          message: "Succeeded restic create tasks require a snapshot result",
        })
      }
      if (!restic && !isArchiveCreateTaskResult(task.result)) {
        context.addIssue({
          code: "custom",
          message: "Succeeded create tasks require an artifact result",
        })
      }
    }
    if (task.kind === "export" && !isExportTaskResult(task.result)) {
      context.addIssue({
        code: "custom",
        message: "Succeeded export tasks require a staged archive result",
      })
    }
    if (
      (task.kind === "restore" ||
        task.kind === "delete" ||
        task.kind === "prune") &&
      !isBackupOperationTaskResult(task.result)
    ) {
      context.addIssue({
        code: "custom",
        message: "Backup operation tasks cannot return an artifact result",
      })
    }
  })

/**
 * What a Relay may ask to do with a copy in a bucket.
 */
export const backupStorageAccessActions = [
  "upload",
  "download",
  "delete",
] as const

/**
 * A Relay asks Hearth for access to one copy of a backup in a bucket
 * (`backup.storage.access`), as it is ready to use it. It names the copy
 * and nothing in the bucket: Hearth knows which Relay asks from the
 * connection, and decides from what it knows of the copy.
 */
export const backupStorageAccessRequestSchema = z
  .object({
    action: z.enum(backupStorageAccessActions),
    artifactId: z.uuid(),
  })
  .strict()

/** One signed request for one object, good for minutes. */
export const backupStorageAccessGrantSchema = z
  .object({
    allowPrivateNetwork: z.boolean(),
    headers: z.record(z.string(), z.string()),
    method: z.enum(["PUT", "GET", "DELETE"]),
    status: z.literal("granted"),
    url: backupHttpsUrlSchema,
  })
  .strict()

/** Hearth answered and won't allow it, which asking again can't change. */
export const backupStorageAccessRefusalSchema = z
  .object({
    reason: z.string().min(1).max(300),
    status: z.literal("refused"),
  })
  .strict()

export const backupStorageAccessResponseSchema = z.discriminatedUnion(
  "status",
  [backupStorageAccessGrantSchema, backupStorageAccessRefusalSchema]
)

/**
 * Hearth's answer to a backup a Relay started on its own, as a schedule's
 * are, and offers to it (`backup.task.offer`, whose payload is the task as
 * the Relay has it). `admitted` once Hearth has cataloged it and will open
 * its bucket; `refused` when it won't, which asking again can't change.
 */
export const backupTaskOfferResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("admitted") }).strict(),
  z
    .object({
      reason: z.string().min(1).max(300),
      status: z.literal("refused"),
    })
    .strict(),
])

export type BackupStorageAccessAction =
  (typeof backupStorageAccessActions)[number]
export type BackupStorageAccessRequest = z.infer<
  typeof backupStorageAccessRequestSchema
>
export type BackupStorageAccessGrant = z.infer<
  typeof backupStorageAccessGrantSchema
>
export type BackupStorageAccessResponse = z.infer<
  typeof backupStorageAccessResponseSchema
>
export type BackupS3CopyDestination = z.infer<
  typeof backupS3CopyDestinationSchema
>

/**
 * Whether a create has taken its backup and waits on its Relay to send it:
 * a copy goes to a bucket only Hearth can open, and Hearth was away. The
 * Relay sends it when Hearth is back, so the backup exists, though nothing
 * of it is where it is going yet.
 */
export function backupTaskAwaitsHearth(
  task: Pick<RelayBackupTask, "kind" | "phase" | "status">
): boolean {
  return (
    task.kind === "create" &&
    task.status === "queued" &&
    task.phase === "uploading"
  )
}

export type BackupArtifactKind = z.infer<typeof backupArtifactKindSchema>
export type BackupConsistency = z.infer<typeof backupConsistencySchema>
export type BackupTarManifest = z.infer<typeof backupTarManifestSchema>
export type BackupArchiveManifest = z.infer<typeof backupArchiveManifestSchema>
export type BackupCreateTaskInput = z.infer<typeof backupCreateTaskInputSchema>
export type BackupArchiveCreateTaskResult = z.infer<
  typeof backupArchiveCreateTaskResultSchema
>
export type BackupResticCreateTaskResult = z.infer<
  typeof backupResticCreateTaskResultSchema
>
export type BackupCreateTaskResult = z.infer<
  typeof backupCreateTaskResultSchema
>
export type BackupDeleteTaskInput = z.infer<typeof backupDeleteTaskInputSchema>
export type BackupExportTaskInput = z.infer<typeof backupExportTaskInputSchema>
export type BackupExportTaskResult = z.infer<
  typeof backupExportTaskResultSchema
>
export type BackupMode = z.infer<typeof backupModeSchema>
export type BackupPruneTaskInput = z.infer<typeof backupPruneTaskInputSchema>
export type ResticRepositoryLocation = z.infer<
  typeof resticRepositoryLocationSchema
>
export type BackupReason = z.infer<typeof backupReasonSchema>
export type BackupRestoreTaskInput = z.infer<
  typeof backupRestoreTaskInputSchema
>
export type BackupStatus = z.infer<typeof backupStatusSchema>
export type BackupTarget = z.infer<typeof backupTargetSchema>
export type BackupTargetKind = z.infer<typeof backupTargetKindSchema>
export type BackupTaskInput = z.infer<typeof backupTaskInputSchema>
export type BackupTaskKind = z.infer<typeof backupTaskKindSchema>
export type BackupTaskPhase = z.infer<typeof backupTaskPhaseSchema>
export type BackupTaskResult = z.infer<typeof backupTaskResultSchema>
export type BackupTaskStatus = z.infer<typeof backupTaskStatusSchema>
export type RelayBackupTask = z.infer<typeof relayBackupTaskSchema>

const BACKUP_ARTIFACT_EXTENSIONS = {
  archive: "zip",
  database_dump: "dmp.gz",
  platform_bundle: "kiln",
  restic_snapshot: "zip",
  tar_archive: "tar.gz",
} as const satisfies Record<BackupArtifactKind, string>

export function backupArtifactFilename(
  backupId: string,
  artifactKind: BackupArtifactKind
): string {
  return `backup-${backupId.slice(0, 8)}.${BACKUP_ARTIFACT_EXTENSIONS[artifactKind]}`
}

export function isArchiveCreateTaskResult(
  result: BackupTaskResult
): result is BackupArchiveCreateTaskResult {
  return (
    "checksumSha256" in result &&
    "filename" in result &&
    !("expiresAt" in result)
  )
}

export function isResticCreateTaskResult(
  result: BackupTaskResult
): result is BackupResticCreateTaskResult {
  return "snapshotId" in result
}

export function isExportTaskResult(
  result: BackupTaskResult
): result is BackupExportTaskResult {
  return "expiresAt" in result && "filename" in result
}

export function isBackupOperationTaskResult(
  result: BackupTaskResult
): result is z.infer<typeof backupOperationTaskResultSchema> {
  return !("bytes" in result)
}

const BACKUP_SECRET_KEYS = new Set([
  "accessKeyId",
  "repositoryPassword",
  "secretAccessKey",
])

export function redactBackupTaskInput(input: BackupTaskInput): BackupTaskInput {
  return backupTaskInputSchema.parse(omitBackupSecrets(input))
}

/** A task as a Relay sends it: without secrets. */
export function redactRelayBackupTask(task: RelayBackupTask): unknown {
  return relayBackupTaskSchema.parse({
    ...task,
    input: redactBackupTaskInput(task.input),
  })
}

export function omitBackupSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitBackupSecrets)
  if (value === null || typeof value !== "object") return value
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (BACKUP_SECRET_KEYS.has(key)) continue
    result[key] = omitBackupSecrets(entry)
  }
  return result
}
