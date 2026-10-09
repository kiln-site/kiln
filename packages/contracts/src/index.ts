import { z } from "zod"

export { validateBrickIconSvg } from "./brick-icons"

import {
  MAXIMUM_INSTANCE_NAME_LENGTH,
  MINIMUM_INSTANCE_DISK_LIMIT_BYTES,
} from "./instance-limits.js"
import { relayInstanceLifecycleEventSchema } from "./instance-lifecycle.js"
import { relayInstanceStateReasonSchema } from "./instance-state-reason.js"
import {
  databaseReadRequestSchema,
  databaseWriteRequestSchema,
} from "./database-browser.js"
import { fileRootIdSchema, tailscaleMemberIdSchema } from "./app-keys.js"
import {
  relayTailscaleDomainSchema,
  relayTailscaleHostnameSchema,
  relayTailscaleSubdomainSchema,
} from "./tailscale.js"

export * from "./access-permissions.js"
export * from "./relay-protocol.js"
export * from "./release-version.js"
export * from "./minecraft-java.js"
export * from "./cli.js"
export * from "./instance-limits.js"
export * from "./instance-overview.js"
export * from "./instance-lifecycle.js"
export * from "./instance-state-reason.js"
export * from "./backups.js"
export * from "./git-repository.js"
export * from "./tailscale.js"
export * from "./schedules.js"
export * from "./snbt.js"
export * from "./database-browser.js"
export * from "./app-keys.js"

export const relayIdSchema = z.string().regex(/^[A-Za-z\d_-]{43}$/u)

export const relayAuditQuerySchema = z
  .object({
    from: z.number().int().nonnegative().optional(),
    instanceIds: z
      .array(z.string().min(1).max(120))
      .min(1)
      .max(2_000)
      .optional(),
    limit: z.number().int().min(1).max(2_000).default(200),
    to: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    ({ from, to }) => from === undefined || to === undefined || from <= to,
    "Audit start must be before its end"
  )

export const relayAuditRecordSchema = z
  .object({
    clientId: z.string().nullable(),
    details: z.record(z.string(), z.unknown()),
    event: z.string().min(1).max(120),
    id: z.string().min(1),
    occurredAt: z.number().int().nonnegative(),
    requestId: z.string().nullable(),
  })
  .strict()

export const relayObservedStateSchema = z
  .enum([
    "offline",
    "stopped",
    "provisioning",
    "starting",
    "running",
    "stopping",
    "failed",
  ])
  .transform((state) => (state === "offline" ? ("stopped" as const) : state))

export const relayDesiredStateSchema = z.enum(["stopped", "running"])

export const relayInstanceProvisioningSchema = z
  .object({
    attempt: z.number().int().nonnegative(),
    error: z.string().max(2_048).nullable(),
    failedPhase: z
      .enum(["preparing", "pulling_image", "creating_container", "finalizing"])
      .optional(),
    phase: z.enum([
      "awaiting_claim",
      "queued",
      "preparing",
      "pulling_image",
      "creating_container",
      "finalizing",
      "failed",
    ]),
  })
  .strict()

export const relayInstanceRecoverySchema = z
  .object({
    attempt: z.number().int().nonnegative(),
    exitCode: z.number().int().nullable(),
    maxAttempts: z.number().int().nonnegative(),
    nextAttemptAt: z.string().datetime().nullable(),
    oomKilled: z.boolean(),
    phase: z.enum(["pending", "restarting", "failed"]),
    reason: z.enum([
      "clean_exit",
      "process_exit",
      "out_of_memory",
      "start_failed",
    ]),
    runtimeMs: z.number().int().nonnegative().nullable(),
  })
  .strict()

export const databaseEngineSchema = z.enum([
  "mysql",
  "mariadb",
  "postgres",
  "redis",
  "valkey",
])

export const databaseIdSchema = z.string().regex(/^[a-f0-9]{40}$/u)

export const relayDatabaseNameSchema = z.string().trim().min(1).max(120)

export const relayManagedDatabaseSchema = z
  .object({
    connectedInstanceIds: z.array(z.string().regex(/^[a-f0-9]{40}$/u)),
    containerId: z.string().nullable(),
    createdAt: z.string().datetime(),
    databaseName: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u),
    engine: databaseEngineSchema,
    hostname: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/u),
    id: databaseIdSchema,
    image: z.string().min(1).max(512),
    internalPort: z.number().int().min(1).max(65_535),
    name: relayDatabaseNameSchema,
    observedState: z.enum(["starting", "running", "stopped", "failed"]),
    shortId: z.string().regex(/^[a-f0-9]{8}$/u),
    status: z.string().min(1).max(280),
    supportsImportExport: z.boolean(),
  })
  .strict()

export const relayCreateDatabaseSchema = z
  .object({
    databaseName: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u),
    engine: databaseEngineSchema,
    id: databaseIdSchema,
    name: relayDatabaseNameSchema,
    password: z.string().min(24).max(256),
    username: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u),
  })
  .strict()

export const relayDatabaseActionSchema = z
  .object({
    action: z.enum(["start", "stop", "restart"]),
    databaseId: databaseIdSchema,
  })
  .strict()

export const relayDeleteDatabaseSchema = z
  .object({
    databaseId: databaseIdSchema,
    deleteData: z.boolean().default(true),
  })
  .strict()

export const relayRotateDatabaseCredentialsSchema = z
  .object({
    currentPassword: z.string().min(24).max(256),
    databaseId: databaseIdSchema,
    nextPassword: z.string().min(24).max(256),
    username: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u),
  })
  .strict()

export const relayDatabaseNetworkSchema = z
  .object({
    connected: z.boolean(),
    databaseId: databaseIdSchema,
    instanceId: z.string().regex(/^[a-f0-9]{40}$/u),
  })
  .strict()

export const relayDatabaseDumpSchema = z
  .object({
    content: z.string().max(700_000),
    databaseId: databaseIdSchema,
    password: z.string().min(24).max(256),
    username: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u),
  })
  .strict()

export const relayDatabaseExportSchema = relayDatabaseDumpSchema.omit({
  content: true,
})

export const relayDatabaseDataReadSchema = relayDatabaseExportSchema.extend({
  request: databaseReadRequestSchema,
})

// Database terminals live on the Relay: one session per person per database,
// kept while any Hearth viewer is attached and for an idle timeout after.
const databaseTerminalIdSchema = z.string().regex(/^[A-Za-z0-9_.-]{22,96}$/u)
const databaseTerminalSizeShape = {
  cols: z.number().int().min(10).max(500),
  rows: z.number().int().min(4).max(300),
}

export const databaseTerminalEndReasonSchema = z.enum([
  // The client exited, for example after \q or exit.
  "exited",
  // The database container stopped or restarted underneath the client.
  "database-stopped",
  // No viewer was attached for the idle timeout.
  "timed-out",
  // Someone asked for a fresh session.
  "restarted",
  // The client could not be started or its connection failed.
  "failed",
])

// Which page sets the session's size and is being typed in: the page the
// output is for, another of the person's pages, or none yet.
export const databaseTerminalControlSchema = z.enum(["self", "other", "none"])

export const databaseTerminalEndSchema = z
  .object({
    at: z.string().datetime(),
    reason: databaseTerminalEndReasonSchema,
  })
  .strict()

export const relayDatabaseTerminalAttachSchema = relayDatabaseExportSchema
  .extend({
    ...databaseTerminalSizeShape,
    // Chosen by Hearth per viewer; output for it is pushed to Hearth.
    attachmentId: databaseTerminalIdSchema,
    idleTimeoutMs: z
      .number()
      .int()
      .min(60_000)
      .max(24 * 60 * 60_000),
  })
  .strict()

// Not strict, like the output pushes: a newer Relay may add fields.
export const relayDatabaseTerminalAttachedSchema = z.object({
  cols: z.number().int(),
  control: databaseTerminalControlSchema,
  // The session's output so far, as the screen and scrollback a terminal
  // shows, ready to write into an empty terminal.
  snapshot: z.string(),
  // Where in the output pushes continue from. Output the snapshot already
  // shows ends here, apart from an unfinished escape sequence, which is
  // pushed again so the page receives it whole.
  offset: z.number().int().nonnegative(),
  // How the person's session before this one ended, if the Relay knows.
  previous: databaseTerminalEndSchema.nullable(),
  rows: z.number().int(),
  // The state change the snapshot is in; pushes continue after it.
  seq: z.number().int().nonnegative(),
  sessionId: databaseTerminalIdSchema,
  startedAt: z.string().datetime(),
})

export const relayDatabaseTerminalHeartbeatSchema = z
  .object({ attachmentIds: z.array(databaseTerminalIdSchema).max(1_000) })
  .strict()

export const relayDatabaseTerminalDetachSchema = z
  .object({ attachmentId: databaseTerminalIdSchema })
  .strict()

const databaseTerminalSessionShape = {
  databaseId: databaseIdSchema,
  sessionId: databaseTerminalIdSchema,
}

// Ends the person's session on a database; their pages attach to a new one.
export const relayDatabaseTerminalRestartSchema = z
  .object({ databaseId: databaseIdSchema })
  .strict()

// The most input one terminal write carries; pages split larger pastes.
export const DATABASE_TERMINAL_WRITE_MAX_CHARACTERS = 64 * 1024

export const relayDatabaseTerminalWriteSchema = z
  .object({
    ...databaseTerminalSessionShape,
    data: z.string().min(1).max(DATABASE_TERMINAL_WRITE_MAX_CHARACTERS),
  })
  .strict()

// Makes a page the one in control, sized to its window. The page in control
// claims again when its window resizes.
export const relayDatabaseTerminalClaimSchema = z
  .object({
    ...databaseTerminalSessionShape,
    ...databaseTerminalSizeShape,
    attachmentId: databaseTerminalIdSchema,
  })
  .strict()

// Relay to Hearth: output for one attachment, in order. `ended` arrives with
// the session's last output. Not strict: a Relay newer than its Hearth may
// send fields this Hearth doesn't know yet.
export const hearthDatabaseTerminalOutputSchema = z.object({
  attachmentId: databaseTerminalIdSchema,
  // The session's size this output is shown at.
  cols: z.number().int().min(10).max(500),
  control: databaseTerminalControlSchema,
  // Raw terminal bytes, base64 encoded; chunks may split characters.
  data: z.string(),
  ended: databaseTerminalEndSchema.nullable(),
  offset: z.number().int().nonnegative(),
  rows: z.number().int().min(4).max(300),
  // Numbers each change to size and control, in order. A page knows its
  // claim took effect once it sees the number the claim returned.
  seq: z.number().int().nonnegative(),
  sessionId: databaseTerminalIdSchema,
})

// Apps run any container workload: a Docker image, a Dockerfile, or a
// Compose project. Hearth keeps each app's configuration; the Relay deploys
// it and reports the containers it finds by their labels.
export const appIdSchema = z.string().regex(/^[a-f0-9]{40}$/u)

export const appNameSchema = relayDatabaseNameSchema

// A Compose service's name; image and Dockerfile apps have one service, `app`.
export const appServiceNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/u)

export const appSourceTypeSchema = z.enum(["image", "dockerfile", "compose"])

export const appPortSchema = z
  .object({
    containerPort: z.number().int().min(1).max(65_535),
    hostPort: z.number().int().min(1).max(65_535),
    protocol: z.enum(["tcp", "udp"]),
  })
  .strict()

// Every source is kept, so switching between them loses nothing; only
// `sourceType` deploys.
export const appConfigSchema = z
  .object({
    // Replaces the image's command, for images and Dockerfiles.
    command: z.string().max(4_000),
    compose: z.string().max(400_000),
    // Where the app's data directory is mounted, for images and Dockerfiles.
    // Compose files mount it themselves through `${KILN_DATA}`.
    dataMount: z
      .string()
      .max(512)
      .regex(/^\/[^\0:]*$/u, "Use an absolute path inside the container"),
    databaseIds: z.array(databaseIdSchema).max(32),
    dockerfile: z.string().max(200_000),
    // KEY=VALUE lines, as in an env file.
    environment: z.string().max(65_536),
    image: z.string().trim().max(512),
    ports: z.array(appPortSchema).max(32),
    sourceType: appSourceTypeSchema,
  })
  .strict()

export const defaultAppConfig: z.infer<typeof appConfigSchema> = {
  command: "",
  compose: "",
  dataMount: "/data",
  databaseIds: [],
  dockerfile: "",
  environment: "",
  image: "",
  ports: [],
  sourceType: "image",
}

export const appDeploymentStateSchema = z.enum([
  "running",
  "succeeded",
  "failed",
])

// Not strict: a newer Relay may report more about its containers.
export const relayAppContainerSchema = z.object({
  createdAt: z.string().datetime().nullable(),
  exitCode: z.number().int().nullable(),
  id: z.string().min(1),
  image: z.string(),
  labels: z.record(z.string(), z.string()),
  name: z.string().min(1),
  networks: z.array(z.string()),
  ports: z.array(appPortSchema),
  running: z.boolean(),
  service: appServiceNameSchema,
  startedAt: z.string().datetime().nullable(),
  state: z.string(),
  status: z.string(),
})

export const relayAppDeploymentSchema = z.object({
  error: z.string().max(2_000).nullable(),
  finishedAt: z.string().datetime().nullable(),
  id: z.string().min(1).max(64),
  sourceType: appSourceTypeSchema,
  startedAt: z.string().datetime(),
  state: appDeploymentStateSchema,
})

export const relayAppSchema = z.object({
  connectedDatabaseIds: z.array(databaseIdSchema),
  containers: z.array(relayAppContainerSchema),
  // The app's data directory on the Relay's host.
  dataDirectory: z.string(),
  deployment: relayAppDeploymentSchema.nullable(),
  // The name its containers answer to on the app's network.
  hostname: z.string(),
  id: appIdSchema,
  network: z.string(),
  observedState: z.enum(["starting", "running", "stopped", "failed"]),
  shortId: z.string().regex(/^[a-f0-9]{8}$/u),
  status: z.string().min(1).max(280),
})

export const relayCreateAppSchema = z
  .object({ id: appIdSchema, name: appNameSchema })
  .strict()

export const relayDeployAppSchema = z
  .object({ appId: appIdSchema, config: appConfigSchema, name: appNameSchema })
  .strict()

export const relayAppActionSchema = z
  .object({
    action: z.enum(["start", "stop", "restart"]),
    appId: appIdSchema,
  })
  .strict()

export const relayDeleteAppSchema = z
  .object({ appId: appIdSchema, deleteData: z.boolean().default(true) })
  .strict()

// Connects the app's running containers to exactly these databases.
export const relayAppNetworkSchema = z
  .object({
    appId: appIdSchema,
    databaseIds: z.array(databaseIdSchema).max(32),
  })
  .strict()

// App terminals are full shells in one of the app's services, sessions kept
// like a database's: one per person per service.
const appTerminalTargetShape = {
  appId: appIdSchema,
  service: appServiceNameSchema,
}

export const relayAppTerminalAttachSchema = z
  .object({
    ...appTerminalTargetShape,
    ...databaseTerminalSizeShape,
    attachmentId: databaseTerminalIdSchema,
    idleTimeoutMs: z
      .number()
      .int()
      .min(60_000)
      .max(24 * 60 * 60_000),
  })
  .strict()

export const relayAppTerminalRestartSchema = z
  .object(appTerminalTargetShape)
  .strict()

export const relayAppTerminalWriteSchema = z
  .object({
    ...appTerminalTargetShape,
    data: z.string().min(1).max(DATABASE_TERMINAL_WRITE_MAX_CHARACTERS),
    sessionId: databaseTerminalIdSchema,
  })
  .strict()

export const relayAppTerminalClaimSchema = z
  .object({
    ...appTerminalTargetShape,
    ...databaseTerminalSizeShape,
    attachmentId: databaseTerminalIdSchema,
    sessionId: databaseTerminalIdSchema,
  })
  .strict()

export const relayDatabaseDataWriteSchema = relayDatabaseExportSchema.extend({
  // Runs a query in a read-only transaction, guarding against accidental
  // writes by someone allowed to write.
  readOnly: z.boolean().optional(),
  request: databaseWriteRequestSchema,
})

export const BRICK_INSTANCE_NAME_SUFFIX = " Server"
export const RECOMMENDED_MAXIMUM_BRICK_ID_LENGTH =
  MAXIMUM_INSTANCE_NAME_LENGTH - BRICK_INSTANCE_NAME_SUFFIX.length

export const brickIdSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/u)

export function brickIdExceedsRecommendedLength(id: string): boolean {
  return id.length > RECOMMENDED_MAXIMUM_BRICK_ID_LENGTH
}

export const brickVariableValueSchema = z.union([
  z.string().max(8_192),
  z.number().finite(),
  z.boolean(),
])

export const brickVariableSchema = z
  .object({
    type: z.enum(["string", "number", "boolean"]),
    label: z.string().min(1).max(80),
    description: z.string().min(1).max(280),
    required: z.boolean(),
    sensitive: z.boolean().default(false),
    default: brickVariableValueSchema.optional(),
    options: z.array(brickVariableValueSchema).min(1).max(64).optional(),
    rules: z
      .object({
        pattern: z.string().max(512).optional(),
        min: z.number().finite().optional(),
        max: z.number().finite().optional(),
        minLength: z.number().int().min(0).max(8_192).optional(),
        maxLength: z.number().int().min(1).max(8_192).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export const brickReadinessSchema = z
  .object({
    logs: z.array(z.string().trim().min(1).max(256)).min(1).max(8),
  })
  .strict()

export const brickConsoleSchema = z
  .object({
    stopCommands: z.array(z.string().trim().min(1).max(128)).min(1).max(8),
  })
  .strict()

export const brickRecipeSchema = z
  .object({
    format: z.literal("kiln.brick/v1"),
    metadata: z
      .object({
        id: brickIdSchema,
        name: z.string().min(1).max(80),
        description: z.string().min(1).max(280),
        game: z.string().min(1).max(80),
        author: z.string().min(1).max(80),
        icon: z.string().trim().min(1).max(2_048).optional(),
        color: z
          .string()
          .regex(/^#[\da-f]{6}$/iu, "Brick colors must use #rrggbb")
          .optional(),
        documentation: z.url().max(2_048).optional(),
        tags: z
          .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/u))
          .max(12)
          .optional(),
      })
      .strict(),
    variables: z.record(
      z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u),
      brickVariableSchema
    ),
    runtime: z
      .object({
        image: z.string().min(1).max(512),
        name: z.string().min(1).max(80),
        environment: z.record(
          z.string().regex(/^[A-Z_][A-Z0-9_]*$/u),
          z.string().max(8_192)
        ),
        entrypoint: z.array(z.string().max(2_048)).max(32).optional(),
        command: z.array(z.string().max(2_048)).max(64).optional(),
        workingDirectory: z.string().startsWith("/").max(256).optional(),
        stopSignal: z
          .string()
          .regex(/^SIG[A-Z0-9]+$/u)
          .optional(),
        user: z
          .string()
          .regex(/^[0-9]+(?::[0-9]+)?$/u)
          .optional(),
        resources: z
          .object({
            memory: z.string().min(1).max(128),
            memoryReservation: z.string().min(1).max(128).optional(),
            pids: z.number().int().min(16).max(32_768).default(512),
          })
          .strict(),
        storage: z
          .object({ mount: z.string().startsWith("/").max(256) })
          .strict(),
      })
      .strict(),
    readiness: brickReadinessSchema.optional(),
    console: brickConsoleSchema.optional(),
    network: z
      .object({
        mode: z.enum(["minecraft-backend", "direct"]),
        primaryPort: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u),
        supportsSrv: z.boolean().default(false),
        hostname: z.string().min(1).max(256).optional(),
        ports: z
          .array(
            z
              .object({
                name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u),
                container: z.number().int().min(1).max(65_535),
                protocol: z.enum(["tcp", "udp", "both"]),
                host: z.number().int().min(1).max(65_535).optional(),
              })
              .strict()
          )
          .min(1)
          .max(16),
      })
      .strict(),
    constraints: z
      .object({
        architectures: z
          .array(z.enum(["amd64", "arm64"]))
          .min(1)
          .optional(),
      })
      .strict()
      .default({}),
  })
  .strict()

export const brickSourceSchema = z.string().trim().url().max(2_048)
export const relayInstanceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(
    MAXIMUM_INSTANCE_NAME_LENGTH,
    `Names must be ${MAXIMUM_INSTANCE_NAME_LENGTH} characters or fewer`
  )
export const DEFAULT_INSTANCE_DISK_LIMIT_BYTES = 5 * 1024 ** 3
export const RELAY_NODE_DISK_RESERVE_BYTES = 10 * 1024 ** 3

const relayDiskLimitBytesSchema = z
  .number()
  .int()
  .nonnegative()
  .transform((bytes) =>
    bytes === 0 ? DEFAULT_INSTANCE_DISK_LIMIT_BYTES : bytes
  )
  .default(DEFAULT_INSTANCE_DISK_LIMIT_BYTES)
const relayRequestedDiskLimitBytesSchema = z
  .number()
  .int()
  .min(MINIMUM_INSTANCE_DISK_LIMIT_BYTES)

export function relayDiskAllocationAvailableBytes(
  nodeTotalBytes: number,
  otherAllocatedBytes: number,
  currentLimitBytes = 0
): number {
  const assignableBytes = Math.max(
    nodeTotalBytes - RELAY_NODE_DISK_RESERVE_BYTES,
    0
  )
  const remainingBytes = Math.max(assignableBytes - otherAllocatedBytes, 0)
  return Math.max(remainingBytes, currentLimitBytes)
}

export const brickSchema = brickRecipeSchema.extend({
  iconSvg: z
    .string()
    .max(64 * 1024)
    .optional(),
  source: brickSourceSchema,
})

export const builtinTailscaleBrickId = "tailscale"
export const builtinTailscaleBrickSource =
  "https://kiln.site/bricks/builtin/tailscale"
export const builtinTailscaleBrick = brickSchema.parse({
  format: "kiln.brick/v1",
  metadata: {
    id: builtinTailscaleBrickId,
    name: "Tailscale",
    description: "Private tailnet access for servers managed by Kiln.",
    game: "Networking",
    author: "Kiln",
    tags: ["networking", "private"],
  },
  variables: {
    domain: {
      type: "string",
      label: "Private domain",
      description: "Domain used for private server names.",
      required: true,
      sensitive: false,
      default: "test",
    },
  },
  runtime: {
    image: "tailscale/tailscale:stable",
    name: "Tailscale",
    environment: {},
    resources: {
      memory: "64m",
      memoryReservation: "16m",
      pids: 128,
    },
    storage: { mount: "/config" },
  },
  network: {
    mode: "direct",
    primaryPort: "dns-tcp",
    ports: [
      { name: "dns-tcp", container: 53, protocol: "tcp" },
      { name: "dns-udp", container: 53, protocol: "udp" },
    ],
  },
  constraints: {},
  source: builtinTailscaleBrickSource,
})

export const brickVariableValuesSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u),
  brickVariableValueSchema
)

export const relayInstanceTailscaleSchema = z
  .object({
    enabled: z.boolean().default(false),
    subdomain: relayTailscaleSubdomainSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.enabled && !value.subdomain) {
      context.addIssue({
        code: "custom",
        message: "Enter a Tailscale subdomain",
        path: ["subdomain"],
      })
    }
  })

export const relayCreateInstanceSchema = z.object({
  diskLimitBytes: relayRequestedDiskLimitBytesSchema.default(
    DEFAULT_INSTANCE_DISK_LIMIT_BYTES
  ),
  name: relayInstanceNameSchema.optional(),
  recipe: brickSourceSchema,
  recipeDefinition: brickRecipeSchema.optional(),
  tailscale: relayInstanceTailscaleSchema
    .default({ enabled: false })
    .optional(),
  variables: brickVariableValuesSchema,
  start: z.boolean().default(true),
})

export const relayPrepareInstanceSchema = relayCreateInstanceSchema.extend({
  idempotencyKey: z.uuid(),
  instanceId: z.string().regex(/^[a-f0-9]{40}$/u),
})

export const relayProvisionInstanceSchema = z.object({
  instanceId: z.string().regex(/^[a-f0-9]{40}$/u),
})

export const relayUpdateInstanceStartupSchema = z
  .object({
    diskLimitBytes: relayRequestedDiskLimitBytesSchema.optional(),
    recipe: brickSourceSchema.optional(),
    recipeDefinition: brickRecipeSchema.optional(),
    reinstall: z.boolean().optional(),
    tailscale: relayInstanceTailscaleSchema.optional(),
    variables: brickVariableValuesSchema.optional(),
    start: z.boolean().default(true),
  })
  .superRefine((value, context) => {
    if (value.reinstall !== true && value.variables === undefined) {
      context.addIssue({
        code: "custom",
        message: "Enter startup variables",
        path: ["variables"],
      })
    }
  })

export const relayTailscaleSettingsSchema = z
  .object({
    dnsPort: z.number().int().min(1).max(65_535).default(53),
    domain: relayTailscaleDomainSchema,
    hostname: relayTailscaleHostnameSchema,
  })
  .strip()

export const relayTailscaleInstallSchema = z
  .object({
    authKey: z
      .string()
      .trim()
      .min(16)
      .max(512)
      .regex(/^tskey-[A-Za-z0-9?=_-]+$/u, "Enter a Tailscale auth key"),
  })
  .strict()

export const relayTailscaleStackIdSchema = z.string().regex(/^[a-f0-9]{40}$/u)

export const MAXIMUM_TAILSCALE_STACK_BINDINGS = 245

export const relayTailscaleStackBindingInputSchema = z
  .object({
    enabled: z.boolean().default(true),
    hostname: relayTailscaleSubdomainSchema,
    // A server, or an app's service (see `appTailscaleMemberId`).
    instanceId: tailscaleMemberIdSchema,
  })
  .strict()

export const relayTailscaleStackApplySchema = z
  .object({
    authKey: relayTailscaleInstallSchema.shape.authKey.optional(),
    bindings: z
      .array(relayTailscaleStackBindingInputSchema)
      .max(MAXIMUM_TAILSCALE_STACK_BINDINGS),
    domain: relayTailscaleDomainSchema,
    hostname: relayTailscaleHostnameSchema,
    id: relayTailscaleStackIdSchema,
    name: relayInstanceNameSchema,
  })
  .strict()

export const relayTailscaleStackDnsRecordSchema = z
  .object({
    address: z.ipv4(),
    hostname: relayTailscaleSubdomainSchema,
  })
  .strict()

export const relayTailscaleStackDnsSchema = z
  .object({
    id: relayTailscaleStackIdSchema,
    records: z.array(relayTailscaleStackDnsRecordSchema).max(4_096),
  })
  .strict()

export const relayTailscaleStackRemoveSchema = z
  .object({
    controlPlaneDeviceRemoved: z.boolean().default(false),
    id: relayTailscaleStackIdSchema,
    mode: z.enum(["prepare", "commit", "rollback"]).default("commit"),
  })
  .strict()

export const relayTailscaleStatusSchema = z
  .object({
    connected: z.boolean(),
    coreDnsRunning: z.boolean(),
    dnsAddress: z.string().nullable(),
    installed: z.boolean(),
    ipv4Address: z.ipv4().nullable(),
    ipv6Address: z.ipv6().nullable(),
    message: z.string().nullable(),
    state: z.enum([
      "not-installed",
      "stopped",
      "connecting",
      "connected",
      "error",
    ]),
  })
  .strict()

export const relayTailscaleOverviewSchema = z
  .object({
    settings: relayTailscaleSettingsSchema.nullable(),
    status: relayTailscaleStatusSchema,
  })
  .strict()

export const relayNetworkingSchema = z.object({
  enabled: z.boolean(),
  domain: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(
      /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/u
    ),
  address: z.union([z.ipv4(), z.ipv6()]),
  dnsPort: z.number().int().min(1).max(65_535).default(53),
})

export const relayProxyModeSchema = z.enum([
  "none",
  "hearth",
  "traefik",
  "coolify",
])

export const DEFAULT_RELAY_NAME = "K100"
export const MAXIMUM_INITIAL_RELAY_NAME_LENGTH = 13

export function truncateInitialRelayName(value: string): string {
  return [...value.trim()]
    .slice(0, MAXIMUM_INITIAL_RELAY_NAME_LENGTH)
    .join("")
    .trimEnd()
}

export const relayNameSchema = z.string().trim().min(1).max(120)

export const relayConnectionSettingsSchema = z
  .object({
    hostname: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(
        /^(?:\[[a-f\d:]+\]|[a-z\d.-]+)$/iu,
        "Enter a hostname or IP address"
      ),
    port: z.number().int().min(1).max(65_535),
    useTls: z.boolean(),
  })
  .strict()

export const relayProxySettingsSchema = z
  .object({
    mode: relayProxyModeSchema,
    traefikImage: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(
        /^traefik(?:@sha256:[a-f0-9]{64}|:[A-Za-z0-9._-]+)$/u,
        "Use an official pinned Traefik tag or digest"
      ),
    acmeEmail: z.email().max(320).nullable(),
  })
  .strict()

export const relayProxyReadInputSchema = z
  .object({
    includeDiagnostics: z.boolean().optional().default(true),
  })
  .strict()

export const relayProxyBrowserMetadataSchema = z
  .object({
    browserOrigin: z.url(),
    mode: relayProxyModeSchema,
  })
  .strict()

const webRouteHostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u,
    "Enter a fully qualified hostname without a scheme or path"
  )

export const relayInstanceWebRouteShortIdSchema = z
  .string()
  .regex(
    /^[a-f0-9]{8}$/u,
    "Route ID must be 8 lowercase hexadecimal characters"
  )

export const relayInstanceWebRouteIdSchema = z.union([
  relayInstanceWebRouteShortIdSchema,
  z.uuid(),
])

export const relayInstanceWebRouteNameSchema = z.string().trim().min(1).max(32)

const relayInstanceWebRouteConfigurationSchema = z
  .object({
    hostname: webRouteHostnameSchema,
    name: relayInstanceWebRouteNameSchema,
    path: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^\/(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?:[^?#])*$/u)
      .regex(
        /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/u,
        "Use an encoded URL path without spaces or routing metacharacters"
      )
      .nullable(),
    stripPrefix: z.boolean().default(true),
    targetPort: z.number().int().min(1).max(65_535),
  })
  .strict()

export const relayInstanceWebRouteInputSchema =
  relayInstanceWebRouteConfigurationSchema.extend({
    id: relayInstanceWebRouteIdSchema.optional(),
  })

export const relayInstanceWebRouteSchema =
  relayInstanceWebRouteConfigurationSchema.extend({
    id: relayInstanceWebRouteIdSchema,
  })

function relayInstanceWebRouteArraySchema<
  Route extends z.ZodType<{ hostname: string; path: string | null }>,
>(route: Route) {
  return z
    .array(route)
    .max(16)
    .superRefine((routes, context) => {
      const seen = new Set<string>()
      routes.forEach((item, index) => {
        const key = `${item.hostname}\n${item.path ?? ""}`
        if (seen.has(key)) {
          context.addIssue({
            code: "custom",
            message: "Each hostname and path combination must be unique",
            path: [index, "hostname"],
          })
        }
        seen.add(key)
      })
    })
}

export const relayInstanceWebRouteInputsSchema =
  relayInstanceWebRouteArraySchema(relayInstanceWebRouteInputSchema)

export const relayInstanceWebRoutesSchema = relayInstanceWebRouteArraySchema(
  relayInstanceWebRouteSchema
)

export const relayInstanceWebRouteStateSchema = z
  .object({
    edgeConnected: z.boolean(),
    message: z.string().min(1),
    proxyConnected: z.boolean(),
    requiresRestart: z.boolean(),
    routes: relayInstanceWebRoutesSchema,
    status: z.enum(["blocked", "pending_restart", "ready"]),
  })
  .strict()

// App web routes are server routes aimed at one of the app's services.
export const relayAppWebRouteInputSchema =
  relayInstanceWebRouteInputSchema.extend({ service: appServiceNameSchema })

export const relayAppWebRouteSchema = relayInstanceWebRouteSchema.extend({
  service: appServiceNameSchema,
})

export const relayAppWebRouteStateSchema =
  relayInstanceWebRouteStateSchema.extend({
    routes: relayInstanceWebRouteArraySchema(relayAppWebRouteSchema),
  })

export const relayAppWebRoutesWriteSchema = z
  .object({
    appId: appIdSchema,
    routes: relayInstanceWebRouteArraySchema(relayAppWebRouteInputSchema),
  })
  .strict()

export const relayProxyDiagnosticsSchema = z
  .object({
    browserOrigin: z.url(),
    containerRunning: z.boolean(),
    mode: relayProxyModeSchema,
    ports: z.array(
      z.object({
        available: z.boolean(),
        owner: z.string().nullable(),
        port: z.union([z.literal(80), z.literal(443)]),
      })
    ),
    publicReachability: z.enum(["unknown", "reachable", "unreachable"]),
    status: z.enum(["blocked", "disabled", "hearth", "ready", "starting"]),
    warnings: z.array(z.string()),
  })
  .strict()

export const relayInstanceResourcesSchema = z.object({
  sampledAt: z.string().datetime(),
  cpu: z.object({
    capacityPercent: z.number().positive().default(100),
    percent: z.number().nonnegative(),
  }),
  memory: z.object({
    totalBytes: z.number().nonnegative(),
    usedBytes: z.number().nonnegative(),
    percent: z.number().nonnegative(),
  }),
  storage: z.object({
    totalBytes: z.number().nonnegative(),
    usedBytes: z.number().nonnegative().nullable(),
    percent: z.number().nonnegative().nullable(),
    nodeTotalBytes: z.number().nonnegative().default(0),
    nodeUsedBytes: z.number().nonnegative().default(0),
    nodePercent: z.number().nonnegative().default(0),
  }),
  network: z
    .object({
      receivedBytes: z.number().nonnegative(),
      sentBytes: z.number().nonnegative(),
      receivedBytesPerSecond: z.number().nonnegative(),
      sentBytesPerSecond: z.number().nonnegative(),
    })
    .optional(),
})

export const relayInstanceLimitsSchema = z
  .object({
    diskBytes: relayDiskLimitBytesSchema,
    memoryBytes: z.number().int().nonnegative(),
  })
  .strict()

export const relayInstancePortIdSchema = z
  .string()
  .regex(
    /^(?:primary|brick-[a-z0-9][a-z0-9-]{0,31}|[a-f0-9]{8})$/u,
    "Port allocation ID is invalid"
  )

export const relayInstancePortNameSchema = z.string().trim().min(1).max(32)

export const relayInstancePortProtocolSchema = z.enum(["tcp", "udp", "both"])

const relayInstancePortConfigurationSchema = z
  .object({
    internalPort: z.number().int().min(1).max(65_535),
    name: relayInstancePortNameSchema,
    protocol: relayInstancePortProtocolSchema,
  })
  .strict()

export const relayInstancePortInputSchema = relayInstancePortConfigurationSchema
  .extend({
    externalPort: z.number().int().min(1).max(65_535).optional(),
    id: relayInstancePortIdSchema.optional(),
    leaseId: z
      .string()
      .regex(/^[a-f0-9]{32}$/u)
      .optional(),
  })
  .superRefine((input, context) => {
    if ((input.externalPort === undefined) !== (input.leaseId === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Public port reservations must include their lease",
        path: [input.externalPort === undefined ? "externalPort" : "leaseId"],
      })
    }
  })

export const relayInstancePendingPrimaryPortSchema =
  relayInstancePortConfigurationSchema.extend({
    id: z.literal("primary"),
  })

export const relayInstancePortLeaseRequestSchema = z
  .object({
    externalPort: z.number().int().min(1).max(65_535).optional(),
    leaseId: z
      .string()
      .regex(/^[a-f0-9]{32}$/u)
      .optional(),
    overridePortRange: z.boolean().optional(),
    protocol: relayInstancePortProtocolSchema,
  })
  .strict()

export const relayInstancePortLeaseReleaseSchema = z
  .object({
    leaseId: z.string().regex(/^[a-f0-9]{32}$/u),
  })
  .strict()

export const relayInstancePortLeaseSchema = z
  .object({
    expiresAt: z.string().datetime(),
    externalPort: z.number().int().min(1).max(65_535),
    id: z.string().regex(/^[a-f0-9]{32}$/u),
    protocol: relayInstancePortProtocolSchema,
  })
  .strict()

export const relayInstancePortMetadataSchema =
  relayInstancePortConfigurationSchema.extend({
    id: relayInstancePortIdSchema,
    kind: z.enum(["primary", "brick", "custom"]),
  })

export const relayInstancePortAllocationSchema =
  relayInstancePortMetadataSchema.extend({
    externalPort: z.number().int().min(1).max(65_535),
  })

export const relayInstanceCustomRouteLabelSchema = z
  .object({
    internal: z.number().int().min(1).max(65_535),
    name: relayInstancePortNameSchema,
    protocol: relayInstancePortProtocolSchema,
    public: z.number().int().min(1).max(65_535),
  })
  .strict()

function relayInstancePortArraySchema<
  Port extends z.ZodType<{
    id?: string
    internalPort: number
    protocol: string
  }>,
>(port: Port) {
  return z
    .array(port)
    .min(1)
    .max(16)
    .superRefine((ports, context) => {
      const ids = new Set<string>()
      const bindings = new Set<string>()
      for (const [index, allocation] of ports.entries()) {
        if (allocation.id) {
          if (ids.has(allocation.id)) {
            context.addIssue({
              code: "custom",
              message: "Port allocation IDs must be unique",
              path: [index, "id"],
            })
          }
          ids.add(allocation.id)
        }
        const protocols =
          allocation.protocol === "both"
            ? ["tcp", "udp"]
            : [allocation.protocol]
        for (const protocol of protocols) {
          const binding = `${protocol}:${allocation.internalPort}`
          if (bindings.has(binding)) {
            context.addIssue({
              code: "custom",
              message: "Internal port and protocol combinations must be unique",
              path: [index, "internalPort"],
            })
          }
          bindings.add(binding)
        }
      }
    })
}

export const relayInstancePortInputsSchema = relayInstancePortArraySchema(
  relayInstancePortInputSchema
)

export const relayInstancePortMetadataListSchema = relayInstancePortArraySchema(
  relayInstancePortMetadataSchema
)

export const relayInstancePortAllocationsSchema = relayInstancePortArraySchema(
  relayInstancePortAllocationSchema
)

export const relaySavedDatabaseConnectionSchema = z.object({
  databaseId: databaseIdSchema,
  relayId: relayIdSchema,
})

export const relayRemoveDatabaseConnectionSchema = z.object({
  instanceId: z.string().regex(/^[a-f0-9]{40}$/u),
  databaseId: databaseIdSchema,
  databaseRelayId: relayIdSchema,
})

export const relayInstanceSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{40}$/u),
  shortId: z.string().regex(/^[a-f0-9]{8}$/u),
  name: z.string().min(1),
  game: z.string().min(1),
  implementation: z.string().min(1),
  version: z.string().min(1),
  javaVersion: z.string().min(1),
  connectAddress: z.string().min(1),
  service: z.string().min(1),
  directory: z.string().min(1),
  desiredState: relayDesiredStateSchema,
  observedState: relayObservedStateSchema,
  stateReason: relayInstanceStateReasonSchema.nullable().default(null),
  databaseConnectionWarnings: z.array(z.string()).optional(),
  savedDatabaseConnections: z
    .array(relaySavedDatabaseConnectionSchema)
    .optional(),
  recovery: relayInstanceRecoverySchema.nullable().default(null),
  lifecycle: z.array(relayInstanceLifecycleEventSchema).default([]),
  containerId: z.string().nullable(),
  status: z.string(),
  brickId: brickIdSchema.optional(),
  brickFormat: z.string().min(1).optional(),
  brickNetworkMode: z.enum(["direct", "minecraft-backend"]).optional(),
  brickPrimaryPort: z.number().int().min(1).max(65_535).optional(),
  brickPrimaryPortProtocol: relayInstancePortProtocolSchema.optional(),
  brickSupportsSrv: z.boolean().default(false),
  brickSource: brickSourceSchema.optional(),
  brickSnapshotSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  publicHost: z.string().min(1).max(253).optional(),
  publicPort: z.number().int().min(1).max(65_535).optional(),
  pendingPrimaryPort: relayInstancePendingPrimaryPortSchema.optional(),
  ports: relayInstancePortAllocationsSchema.or(z.tuple([])).default([]),
  tailscale: relayInstanceTailscaleSchema.default({ enabled: false }),
  variables: brickVariableValuesSchema.optional(),
  managedByRelay: z.boolean().default(false),
  limits: relayInstanceLimitsSchema.default({
    diskBytes: DEFAULT_INSTANCE_DISK_LIMIT_BYTES,
    memoryBytes: 0,
  }),
  resources: relayInstanceResourcesSchema.nullable().default(null),
  provisioning: relayInstanceProvisioningSchema.optional(),
})

export const relayTailscaleStackBindingSchema =
  relayTailscaleStackBindingInputSchema.extend({
    address: z.ipv4(),
  })

export const relayTailscaleStackConfigSchema = z
  .object({
    bindings: z
      .array(relayTailscaleStackBindingSchema)
      .max(MAXIMUM_TAILSCALE_STACK_BINDINGS),
    domain: relayTailscaleDomainSchema,
    hostname: relayTailscaleHostnameSchema,
    id: relayTailscaleStackIdSchema,
    name: relayInstanceNameSchema,
    subnet: z.string().regex(/^10\.(?:\d{1,3}\.){2}0\/24$/u),
  })
  .strict()

export const relayTailscaleStackSchema = z
  .object({
    bindings: z.array(relayTailscaleStackBindingSchema),
    components: z
      .object({
        coreDnsRunning: z.boolean(),
        tailscaleRunning: z.boolean(),
      })
      .strict(),
    domain: relayTailscaleDomainSchema,
    hostname: relayTailscaleHostnameSchema,
    id: relayTailscaleStackIdSchema,
    instance: relayInstanceSchema,
    name: relayInstanceNameSchema,
    status: z
      .object({
        connected: z.boolean(),
        ipv4Address: z.ipv4().nullable(),
        ipv6Address: z.ipv6().nullable(),
        message: z.string().nullable(),
      })
      .strict(),
    subnet: z.string().regex(/^10\.(?:\d{1,3}\.){2}0\/24$/u),
  })
  .strict()

export const relayTailscaleStacksSchema = z.array(relayTailscaleStackSchema)

export const relayNodeCapabilitySchema = z.enum([
  "tailscale-stacks",
  "tailscale-staged-removal",
])

export const relayNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  capabilities: z.array(relayNodeCapabilitySchema).default([]),
  canProvisionInstances: z.boolean().default(true),
  platform: z.string().min(1),
  arch: z.string().min(1),
  uptimeSeconds: z.number().nonnegative().nullable().default(null),
  startedAt: z.string().datetime().nullable().default(null),
  cpu: z.object({
    cores: z.number().int().positive(),
    loadPercent: z.number().min(0),
  }),
  memory: z.object({
    totalBytes: z.number().nonnegative(),
    usedBytes: z.number().nonnegative(),
  }),
  storage: z.object({
    totalBytes: z.number().nonnegative(),
    usedBytes: z.number().nonnegative(),
  }),
  docker: z.object({
    available: z.boolean(),
    version: z.string().nullable(),
  }),
  connectedAt: z.string().datetime(),
})

export const relaySftpPublicationStatusSchema = z.enum([
  "published",
  "not_published",
  "loopback_only",
  "unknown",
])

export const relaySftpSnapshotSchema = z.object({
  developmentAuthentication: z.boolean(),
  host: z.string().min(1).max(253),
  hostKeyFingerprint: z.string().startsWith("SHA256:"),
  port: z.number().int().min(1).max(65_535),
  publication: relaySftpPublicationStatusSchema.default("unknown"),
})

const relaySnapshotRelaySchema = z.object({
  browserOrigin: relayProxyBrowserMetadataSchema.shape.browserOrigin.optional(),
  id: relayIdSchema,
  name: z.string().min(1).max(120),
  proxyMode: relayProxyModeSchema.optional(),
  sftp: relaySftpSnapshotSchema,
  tls: z
    .object({
      expiresAt: z.number().int().positive(),
      fingerprint: z.string().min(1),
      mode: z.enum(["external", "managed"]),
    })
    .nullable(),
})

export const relaySnapshotSchema = z.object({
  node: relayNodeSchema,
  instances: z.array(relayInstanceSchema),
  relay: relaySnapshotRelaySchema.optional(),
})

/**
 * Incremental replacement for the repeated full snapshot frames sent over the
 * Relay control socket. A reconnect always starts with a full snapshot, so a
 * delta only needs to describe changes since the previous frame on that
 * authenticated socket.
 */
export const relaySnapshotDeltaSchema = z.object({
  deletedInstanceIds: z.array(relayInstanceSchema.shape.id),
  instances: z.array(relayInstanceSchema),
  node: relayNodeSchema.optional(),
  relay: relaySnapshotRelaySchema.optional(),
})

export const relayFileTreeSchema = z.object({
  instanceId: z.string(),
  modifiedAt: z.record(z.string(), z.number().nonnegative()),
  paths: z.array(z.string()),
  sizes: z.record(z.string(), z.number().int().nonnegative()),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
})

export const relayFileEntrySchema = z
  .object({
    kind: z.enum(["directory", "file"]),
    modifiedAt: z.number().nonnegative(),
    path: z.string().min(1).max(8_192),
    size: z.number().int().nonnegative().nullable(),
  })
  .strict()

const relayFileCursorSchema = z.string().uuid().nullable()

export const relayDirectoryPageInputSchema = z
  .object({
    cursor: z.string().uuid().optional(),
    instanceId: fileRootIdSchema,
    path: z.string().max(8_192),
  })
  .strict()

export const relayDirectorySizesInputSchema = z
  .object({
    instanceId: fileRootIdSchema,
    paths: z.array(z.string().min(1).max(8_192)).min(1).max(128),
  })
  .strict()

export const relayDirectorySizesSchema = z
  .object({
    instanceId: z.string(),
    pending: z.array(z.string().min(1).max(8_192)),
    sizes: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict()

export const relayFileStatInputSchema = z
  .object({
    instanceId: fileRootIdSchema,
    path: z.string().min(1).max(8_192),
  })
  .strict()

export const relayDirectoryPageSchema = z
  .object({
    cursor: relayFileCursorSchema,
    directory: z.string().max(8_192),
    entries: z.array(relayFileEntrySchema),
    instanceId: z.string(),
  })
  .strict()

export const relayFileSearchPageInputSchema = z
  .object({
    cursor: z.string().uuid().optional(),
    instanceId: fileRootIdSchema,
    query: z.string().trim().min(1).max(256),
  })
  .strict()

export const relayFileSearchPageSchema = z
  .object({
    cursor: relayFileCursorSchema,
    entries: z.array(relayFileEntrySchema),
    instanceId: z.string(),
    query: z.string().min(1).max(256),
  })
  .strict()

export const relayFileContentSchema = z.object({
  instanceId: z.string(),
  path: z.string(),
  content: z.string(),
  size: z.number().int().nonnegative(),
  decodedSize: z.number().int().nonnegative(),
  encoding: z.enum(["utf8", "gzip", "nbt", "nbt-gzip", "snbt", "snbt-gzip"]),
  readOnly: z.boolean(),
  modifiedAt: z.string().datetime(),
})

export const relaySaveFileInputSchema = z.object({
  content: z.string().max(2 * 1024 * 1024),
  expectedModifiedAt: z.string().datetime().optional(),
  force: z.boolean().optional(),
})

const relayFileMutationPathSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    (path) =>
      !path.includes("\0") &&
      !path.startsWith("/") &&
      !path.split(/[\\/]/u).includes(".."),
    "Invalid relative file path"
  )

export const relayRemoteFileUploadSchema = z
  .object({
    instanceId: fileRootIdSchema,
    path: relayFileMutationPathSchema,
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

export const relayRemoteFileUploadResultSchema = z
  .object({
    modifiedAt: z.string().datetime(),
    path: relayFileMutationPathSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    size: z.number().int().nonnegative(),
  })
  .strict()

export const relayFileMutationInputSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("rename"),
    path: relayFileMutationPathSchema,
    destination: relayFileMutationPathSchema,
  }),
  z.object({
    operation: z.literal("delete"),
    paths: z.array(relayFileMutationPathSchema).min(1).max(500),
  }),
  z.object({
    operation: z.literal("duplicate"),
    paths: z.array(relayFileMutationPathSchema).min(1).max(500),
  }),
  z.object({
    operation: z.literal("archive"),
    paths: z.array(relayFileMutationPathSchema).min(1).max(500),
    destination: relayFileMutationPathSchema,
  }),
  z.object({
    operation: z.literal("unarchive"),
    path: relayFileMutationPathSchema,
    destination: relayFileMutationPathSchema,
  }),
])

export const relayFileMutationResultSchema = z
  .object({ mutated: z.literal(true) })
  .strict()

export type RelayFileUnarchiveSuffix = ".tar.gz" | ".tgz" | ".zip"

export function relayFileUnarchiveSuffix(
  path: string
): RelayFileUnarchiveSuffix | null {
  const lowerPath = path.toLowerCase()
  if (lowerPath.endsWith(".tar.gz")) return ".tar.gz"
  if (lowerPath.endsWith(".tgz")) return ".tgz"
  if (lowerPath.endsWith(".zip")) return ".zip"
  return null
}

export const relayFileActivityEntrySchema = z.object({
  instanceId: z.string(),
  path: z.string(),
  pinned: z.boolean(),
  lastViewedAt: z.string().datetime(),
  lastEditedAt: z.string().datetime().nullable(),
})

export const relayFileActivitySchema = z.object({
  instanceId: z.string(),
  files: z.array(relayFileActivityEntrySchema),
})

export const relayInstanceActionSchema = z.object({
  action: z.enum(["start", "stop", "restart", "kill"]),
})

export const relayConsoleLevelSchema = z.enum([
  "info",
  "warn",
  "error",
  "debug",
  "trace",
])

export const relayConsoleSegmentSchema = z.object({
  text: z.string(),
  color: z
    .string()
    .regex(/^#[\da-f]{6}$/iu)
    .optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
})

export const relayConsoleLineSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().datetime().nullable(),
  level: relayConsoleLevelSchema,
  service: z.enum(["tailscale", "coredns"]).optional(),
  text: z.string(),
  segments: z.array(relayConsoleSegmentSchema).optional(),
})

export const relayConsoleSchema = z.object({
  instanceId: z.string().min(1),
  lifecycle: z.array(relayInstanceLifecycleEventSchema).default([]),
  lines: z.array(relayConsoleLineSchema),
  truncated: z.boolean(),
})

export const relayConsoleStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    instanceId: z.string().min(1),
    lifecycle: z.array(relayInstanceLifecycleEventSchema).default([]),
  }),
  z.object({
    type: z.literal("reset"),
    instanceId: z.string().min(1),
    lifecycle: z.array(relayInstanceLifecycleEventSchema),
    lines: z.array(relayConsoleLineSchema),
    truncated: z.boolean(),
  }),
  z.object({
    type: z.literal("history"),
    instanceId: z.string().min(1),
    lifecycle: z.array(relayInstanceLifecycleEventSchema),
    lines: z.array(relayConsoleLineSchema),
    truncated: z.boolean(),
  }),
  z.object({
    type: z.literal("line"),
    line: relayConsoleLineSchema,
  }),
])

export const relayResourceHistoryMaxSamples = 256

export const relayResourceStreamEventSchema = z.object({
  type: z.literal("resource"),
  instance: relayInstanceSchema,
  history: z
    .array(relayInstanceResourcesSchema)
    .max(relayResourceHistoryMaxSamples)
    .default([]),
  sequence: z.number().int().nonnegative(),
})

export const relayInstanceResourceSnapshotSchema = z.object({
  instance: relayInstanceSchema,
  history: z
    .array(relayInstanceResourcesSchema)
    .max(relayResourceHistoryMaxSamples),
})

export const relayConsoleCommandSchema = z.object({
  command: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .refine((value) => !/[\r\n]/u.test(value), "Command must be one line"),
})

export const relayConsoleCommandResultSchema = z.object({
  accepted: z.literal(true),
  command: z.string(),
})

export const relayConsoleCompletionInputSchema = z
  .object({
    input: z
      .string()
      .max(512)
      .refine(
        (value) =>
          Array.from(value).every((character) => {
            const codePoint = character.charCodeAt(0)
            return codePoint >= 32 && codePoint !== 127
          }),
        "Command cannot contain control characters"
      ),
    cursor: z.number().int().min(0).max(512),
  })
  .refine(({ cursor, input }) => cursor <= input.length, {
    message: "Cursor must be within the command",
    path: ["cursor"],
  })

export const relayConsoleCompletionSchema = z.object({
  instanceId: z.string().min(1),
  supported: z.boolean(),
  completedPrefix: z.string().nullable(),
  suggestions: z.array(z.string()).max(100),
})

export const relayLatestLogSchema = z.object({
  instanceId: z.string().min(1),
  path: z.literal("logs/latest.log"),
  content: z.string(),
  size: z.number().int().nonnegative(),
})

export const relayConsoleShareInputSchema = z.object({
  implementation: z.string().min(1),
  version: z.string().min(1),
  redactSensitive: z.boolean().default(false),
})

export const relayMclogsUploadResultSchema = z.object({
  id: z.string().min(1),
  url: z.url(),
  expires: z.number().int(),
})

export const relayErrorSchema = z.object({
  error: z.string(),
  code: z.string(),
})

const brickCatalogMetadataShape = {
  name: z.string().trim().min(1).max(80).optional(),
  author: z.string().trim().min(1).max(80).optional(),
  docs: z
    .url()
    .max(2_048)
    .regex(/^https?:\/\//iu, "Catalog docs must use HTTP or HTTPS")
    .optional(),
  support: z
    .url()
    .max(2_048)
    .regex(/^https?:\/\//iu, "Catalog support must use HTTP or HTTPS")
    .optional(),
}

export const relayCatalogSchema = z.object({
  format: z.literal("kiln.catalog/v1"),
  ...brickCatalogMetadataShape,
  bricks: z.array(brickSchema),
})

export const brickCatalogDocumentSchema = z
  .object({
    format: z.literal("kiln.catalog/v1"),
    ...brickCatalogMetadataShape,
    recipes: z.array(z.string().min(1).max(2_048)).min(1).max(256),
  })
  .strict()

export type RelayDesiredState = z.infer<typeof relayDesiredStateSchema>
export type DatabaseEngine = z.infer<typeof databaseEngineSchema>

export function databaseEngineSupportsLogicalBackups(
  engine: DatabaseEngine
): boolean {
  return engine === "mysql" || engine === "mariadb" || engine === "postgres"
}

// SQL engines whose tables the database viewer can browse and edit.
export function databaseEngineSupportsBrowsing(
  engine: DatabaseEngine
): engine is "mariadb" | "mysql" | "postgres" {
  return engine === "mysql" || engine === "mariadb" || engine === "postgres"
}

export type RelayManagedDatabase = z.infer<typeof relayManagedDatabaseSchema>
export type RelayCreateDatabase = z.infer<typeof relayCreateDatabaseSchema>
export type RelayDatabaseAction = z.infer<typeof relayDatabaseActionSchema>
export type RelayDeleteDatabase = z.infer<typeof relayDeleteDatabaseSchema>
export type RelayRotateDatabaseCredentials = z.infer<
  typeof relayRotateDatabaseCredentialsSchema
>
export type RelayDatabaseNetwork = z.infer<typeof relayDatabaseNetworkSchema>
export type RelayDatabaseDump = z.infer<typeof relayDatabaseDumpSchema>
export type RelayDatabaseExport = z.infer<typeof relayDatabaseExportSchema>
export type RelayDatabaseDataRead = z.infer<typeof relayDatabaseDataReadSchema>
export type DatabaseTerminalControl = z.infer<
  typeof databaseTerminalControlSchema
>
export type DatabaseTerminalEnd = z.infer<typeof databaseTerminalEndSchema>
export type DatabaseTerminalEndReason = z.infer<
  typeof databaseTerminalEndReasonSchema
>
export type RelayDatabaseTerminalAttach = z.infer<
  typeof relayDatabaseTerminalAttachSchema
>
export type RelayDatabaseTerminalAttached = z.infer<
  typeof relayDatabaseTerminalAttachedSchema
>
export type HearthDatabaseTerminalOutput = z.infer<
  typeof hearthDatabaseTerminalOutputSchema
>
export type RelayDatabaseDataWrite = z.infer<
  typeof relayDatabaseDataWriteSchema
>
export type AppConfig = z.infer<typeof appConfigSchema>
export type AppSourceType = z.infer<typeof appSourceTypeSchema>
export type AppPort = z.infer<typeof appPortSchema>
export type AppDeploymentState = z.infer<typeof appDeploymentStateSchema>
export type RelayApp = z.infer<typeof relayAppSchema>
export type RelayAppContainer = z.infer<typeof relayAppContainerSchema>
export type RelayAppDeployment = z.infer<typeof relayAppDeploymentSchema>
export type RelayCreateApp = z.infer<typeof relayCreateAppSchema>
export type RelayDeployApp = z.infer<typeof relayDeployAppSchema>
export type RelayAppAction = z.infer<typeof relayAppActionSchema>
export type RelayDeleteApp = z.infer<typeof relayDeleteAppSchema>
export type RelayAppNetwork = z.infer<typeof relayAppNetworkSchema>
export type RelayAppWebRoute = z.infer<typeof relayAppWebRouteSchema>
export type RelayAppWebRouteInput = z.infer<typeof relayAppWebRouteInputSchema>
export type RelayAppWebRouteState = z.infer<typeof relayAppWebRouteStateSchema>
export type RelayAppTerminalAttach = z.infer<
  typeof relayAppTerminalAttachSchema
>
export type BrickId = z.infer<typeof brickIdSchema>
export type BrickVariableValue = z.infer<typeof brickVariableValueSchema>
export type BrickVariable = z.infer<typeof brickVariableSchema>
export type BrickReadiness = z.infer<typeof brickReadinessSchema>
export type BrickRecipe = z.infer<typeof brickRecipeSchema>
export type BrickCatalogDocument = z.infer<typeof brickCatalogDocumentSchema>
export type Brick = z.infer<typeof brickSchema>
export type RelayCatalog = z.infer<typeof relayCatalogSchema>
export type RelayCreateInstance = z.infer<typeof relayCreateInstanceSchema>
export type RelayPrepareInstance = z.infer<typeof relayPrepareInstanceSchema>
export type RelayProvisionInstance = z.infer<
  typeof relayProvisionInstanceSchema
>
export type RelayInstanceProvisioning = z.infer<
  typeof relayInstanceProvisioningSchema
>
export type RelayUpdateInstanceStartup = z.infer<
  typeof relayUpdateInstanceStartupSchema
>
export type RelayNetworking = z.infer<typeof relayNetworkingSchema>
export type RelayInstanceTailscale = z.infer<
  typeof relayInstanceTailscaleSchema
>
export type RelayTailscaleInstall = z.infer<typeof relayTailscaleInstallSchema>
export type RelayTailscaleOverview = z.infer<
  typeof relayTailscaleOverviewSchema
>
export type RelayTailscaleSettings = z.infer<
  typeof relayTailscaleSettingsSchema
>
export type RelayTailscaleStack = z.infer<typeof relayTailscaleStackSchema>
export type RelayTailscaleStackApply = z.infer<
  typeof relayTailscaleStackApplySchema
>
export type RelayTailscaleStackBinding = z.infer<
  typeof relayTailscaleStackBindingSchema
>
export type RelayTailscaleStackConfig = z.infer<
  typeof relayTailscaleStackConfigSchema
>
export type RelayTailscaleStackDns = z.infer<
  typeof relayTailscaleStackDnsSchema
>
export type RelayTailscaleStatus = z.infer<typeof relayTailscaleStatusSchema>
export type RelayProxyMode = z.infer<typeof relayProxyModeSchema>
export type RelayProxyBrowserMetadata = z.infer<
  typeof relayProxyBrowserMetadataSchema
>
export type RelayProxySettings = z.infer<typeof relayProxySettingsSchema>
export type RelayProxyDiagnostics = z.infer<typeof relayProxyDiagnosticsSchema>
export type RelayInstanceWebRoute = z.infer<typeof relayInstanceWebRouteSchema>
export type RelayInstanceWebRouteInput = z.infer<
  typeof relayInstanceWebRouteInputSchema
>
export type RelayInstanceWebRoutes = z.infer<
  typeof relayInstanceWebRoutesSchema
>
export type RelayInstanceWebRouteState = z.infer<
  typeof relayInstanceWebRouteStateSchema
>
export type RelayObservedState = z.infer<typeof relayObservedStateSchema>
export type RelayInstanceRecovery = z.infer<typeof relayInstanceRecoverySchema>
export type RelayInstanceResources = z.infer<
  typeof relayInstanceResourcesSchema
>
export type RelayInstanceLimits = z.infer<typeof relayInstanceLimitsSchema>
export type RelayInstancePortInput = z.infer<
  typeof relayInstancePortInputSchema
>
export type RelayInstancePortLease = z.infer<
  typeof relayInstancePortLeaseSchema
>
export type RelayInstancePortLeaseRequest = z.infer<
  typeof relayInstancePortLeaseRequestSchema
>
export type RelayInstancePendingPrimaryPort = z.infer<
  typeof relayInstancePendingPrimaryPortSchema
>
export type RelayInstancePortProtocol = z.infer<
  typeof relayInstancePortProtocolSchema
>
export type RelayInstancePortMetadata = z.infer<
  typeof relayInstancePortMetadataSchema
>
export type RelayInstancePortAllocation = z.infer<
  typeof relayInstancePortAllocationSchema
>
export type RelayInstanceCustomRouteLabel = z.infer<
  typeof relayInstanceCustomRouteLabelSchema
>
export type RelayInstance = z.infer<typeof relayInstanceSchema>
export type RelaySnapshotDelta = z.infer<typeof relaySnapshotDeltaSchema>
export type RelayNode = z.infer<typeof relayNodeSchema>
export type RelaySnapshot = z.infer<typeof relaySnapshotSchema>

/**
 * Builds the control-plane portion of a Relay snapshot update. High-frequency
 * resource samples use their dedicated stream and must not wake every Hearth
 * client through the fleet-wide realtime channel.
 */
export function createRelaySnapshotDelta(
  previous: RelaySnapshot,
  next: RelaySnapshot
): RelaySnapshotDelta | null {
  const previousInstances = new Map(
    previous.instances.map((instance) => [instance.id, instance])
  )
  const nextIds = new Set<string>()
  const instances = next.instances.filter((instance) => {
    nextIds.add(instance.id)
    const previousInstance = previousInstances.get(instance.id)
    return (
      previousInstance === undefined ||
      !jsonValueEqual(
        relayInstanceControlState(previousInstance),
        relayInstanceControlState(instance)
      )
    )
  })
  const deletedInstanceIds = previous.instances.flatMap((instance) =>
    nextIds.has(instance.id) ? [] : [instance.id]
  )
  const node = jsonValueEqual(
    relayNodeControlState(previous.node),
    relayNodeControlState(next.node)
  )
    ? undefined
    : next.node
  const relay = jsonValueEqual(previous.relay, next.relay)
    ? undefined
    : next.relay

  if (
    instances.length === 0 &&
    deletedInstanceIds.length === 0 &&
    !node &&
    !relay
  ) {
    return null
  }
  return {
    deletedInstanceIds,
    instances,
    ...(node ? { node } : {}),
    ...(relay ? { relay } : {}),
  }
}

export function applyRelaySnapshotDelta(
  snapshot: RelaySnapshot,
  delta: RelaySnapshotDelta
): RelaySnapshot {
  const deleted = new Set(delta.deletedInstanceIds)
  const upserts = new Map(
    delta.instances.map((instance) => [instance.id, instance])
  )
  const retained = snapshot.instances.flatMap((instance) => {
    if (deleted.has(instance.id)) return []
    const updated = upserts.get(instance.id)
    if (updated) upserts.delete(instance.id)
    return [updated ?? instance]
  })
  return {
    ...snapshot,
    instances: [...retained, ...upserts.values()],
    node: delta.node ?? snapshot.node,
    relay: delta.relay ?? snapshot.relay,
  }
}

function relayInstanceControlState(instance: RelayInstance) {
  const { resources: _resources, ...control } = instance
  return control
}

function relayNodeControlState(node: RelayNode) {
  const {
    cpu: _cpu,
    memory: _memory,
    storage: _storage,
    uptimeSeconds: _uptimeSeconds,
    ...control
  } = node
  return control
}

function jsonValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null) return false
  if (typeof left !== "object" || typeof right !== "object") return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    return (
      left.length === right.length &&
      left.every((value, index) => jsonValueEqual(value, right[index]))
    )
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        jsonValueEqual(leftRecord[key], rightRecord[key])
    )
  )
}
export type RelaySftpPublicationStatus = z.infer<
  typeof relaySftpPublicationStatusSchema
>
export type RelayFileTree = z.infer<typeof relayFileTreeSchema>
export type RelayFileEntry = z.infer<typeof relayFileEntrySchema>
export type RelayFileStatInput = z.infer<typeof relayFileStatInputSchema>
export type RelayDirectoryPageInput = z.infer<
  typeof relayDirectoryPageInputSchema
>
export type RelayDirectoryPage = z.infer<typeof relayDirectoryPageSchema>
export type RelayDirectorySizesInput = z.infer<
  typeof relayDirectorySizesInputSchema
>
export type RelayDirectorySizes = z.infer<typeof relayDirectorySizesSchema>
export type RelayFileSearchPageInput = z.infer<
  typeof relayFileSearchPageInputSchema
>
export type RelayFileSearchPage = z.infer<typeof relayFileSearchPageSchema>
export type RelayFileContent = z.infer<typeof relayFileContentSchema>
export type RelaySaveFileInput = z.infer<typeof relaySaveFileInputSchema>
export type RelayFileMutationInput = z.infer<
  typeof relayFileMutationInputSchema
>
export type RelayFileMutationResult = z.infer<
  typeof relayFileMutationResultSchema
>
export type RelayRemoteFileUpload = z.infer<typeof relayRemoteFileUploadSchema>
export type RelayRemoteFileUploadResult = z.infer<
  typeof relayRemoteFileUploadResultSchema
>
export type RelayFileActivityEntry = z.infer<
  typeof relayFileActivityEntrySchema
>
export type RelayFileActivity = z.infer<typeof relayFileActivitySchema>
export type RelayAuditQuery = z.infer<typeof relayAuditQuerySchema>
export type RelayAuditRecord = z.infer<typeof relayAuditRecordSchema>
export type RelayInstanceAction = z.infer<typeof relayInstanceActionSchema>
export type RelayConsoleLevel = z.infer<typeof relayConsoleLevelSchema>
export type RelayConsoleSegment = z.infer<typeof relayConsoleSegmentSchema>
export type RelayConsoleLine = z.infer<typeof relayConsoleLineSchema>
export type RelayConsole = z.infer<typeof relayConsoleSchema>
export type RelayConsoleStreamEvent = z.infer<
  typeof relayConsoleStreamEventSchema
>
export type RelayResourceStreamEvent = z.infer<
  typeof relayResourceStreamEventSchema
>
export type RelayConsoleCommand = z.infer<typeof relayConsoleCommandSchema>
export type RelayConsoleCommandResult = z.infer<
  typeof relayConsoleCommandResultSchema
>
export type RelayConsoleCompletionInput = z.infer<
  typeof relayConsoleCompletionInputSchema
>
export type RelayConsoleCompletion = z.infer<
  typeof relayConsoleCompletionSchema
>
export type RelayConsoleShareInput = z.infer<
  typeof relayConsoleShareInputSchema
>
export type RelayMclogsUploadResult = z.infer<
  typeof relayMclogsUploadResultSchema
>
export type RelayLatestLog = z.infer<typeof relayLatestLogSchema>
