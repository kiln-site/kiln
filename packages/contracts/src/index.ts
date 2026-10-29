import { z } from "zod"

export { validateBrickIconSvg } from "./brick-icons"

import {
  MAXIMUM_INSTANCE_NAME_LENGTH,
  MINIMUM_INSTANCE_DISK_LIMIT_BYTES,
} from "./instance-limits.js"
import { relayInstanceLifecycleEventSchema } from "./instance-lifecycle.js"
import {
  NO_RESOURCE_LIMITS,
  observedResourceLimitsSchema,
  resourceLimitsInputSchema,
  serviceResourceLimitsSchema,
} from "./resource-limits.js"
import { relayInstanceStateReasonSchema } from "./instance-state-reason.js"
import {
  webRouteEndpoints,
  webRouteHostnames,
  wwwCounterpart,
} from "./web-routes.js"
import {
  databaseReadRequestSchema,
  databaseWriteRequestSchema,
} from "./database-browser.js"
import {
  appServiceNameSchema,
  fileRootIdSchema,
  legacyTailscaleMemberId,
  tailscaleMemberIdSchema,
} from "./app-keys.js"
import {
  relayTailscaleDomainSchema,
  relayTailscaleHostnameSchema,
  relayTailscaleSubdomainSchema,
} from "./tailscale.js"

export * from "./access-permissions.js"
export * from "./web-routes.js"
export * from "./relay-protocol.js"
export * from "./relay-transfers.js"
export * from "./installation-id.js"
export * from "./container-identity.js"
export * from "./relay-join.js"
export * from "./release-version.js"
export * from "./minecraft-java.js"
export * from "./cli.js"
export * from "./instance-limits.js"
export * from "./resource-limits.js"
export * from "./security.js"
export * from "./instance-overview.js"
export * from "./icon-images.js"
export * from "./instance-state.js"
export * from "./instance-inventory.js"
export * from "./instance-lifecycle.js"
export * from "./instance-state-reason.js"
export * from "./backups.js"
export * from "./backup-failures.js"
export * from "./git-repository.js"
export * from "./tailscale.js"
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

// Every kind of instance provisions through the same steps: it waits for
// Hearth to claim it, waits its turn, prepares its storage and network,
// pulls its image, creates its container, and finishes setting up.
export const provisioningKindSchema = z.enum(["server", "database", "app"])

export const provisioningWorkPhaseSchema = z.enum([
  "preparing",
  "pulling_image",
  "creating_container",
  "finalizing",
])

export const provisioningPhaseSchema = z.enum([
  "awaiting_claim",
  "queued",
  ...provisioningWorkPhaseSchema.options,
  "failed",
])

export const provisioningStateSchema = z
  .object({
    attempt: z.number().int().nonnegative(),
    error: z.string().max(2_048).nullable(),
    failedPhase: provisioningWorkPhaseSchema.optional(),
    phase: provisioningPhaseSchema,
  })
  .strict()

export const relayInstanceProvisioningSchema = provisioningStateSchema

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

// What joins a database's network, by its kind's code name: a game server,
// an App (every service of it), or another database.
export const databaseConnectionMemberKindSchema = z.enum([
  "instance",
  "app",
  "database",
])

export const databaseConnectionMemberSchema = z
  .object({
    // Game servers, Apps, and databases all have 40-character IDs.
    id: z.string().regex(/^[a-f0-9]{40}$/u),
    kind: databaseConnectionMemberKindSchema,
  })
  .strict()

// One member of a database's network: what the Relay keeps connected to it,
// what its network holds now, or both.
export const relayDatabaseMemberSchema = z
  .object({
    // Whether its containers are on the database's network now.
    attached: z.boolean(),
    // The names its containers answer to there now: `server-<id>` for a
    // game server, `database-<id>` for a database, and each App service's
    // alias.
    hostnames: z.array(z.string().min(1).max(253)),
    id: z.string().regex(/^[a-f0-9]{40}$/u),
    kind: databaseConnectionMemberKindSchema,
    // Names it doesn't answer to yet: it takes them when its containers
    // join, or, for one that joined before members had names, when it next
    // starts, restarts, or deploys.
    pendingHostnames: z.array(z.string().min(1).max(253)),
    // Whether the Relay keeps the connection, joining its containers
    // whenever they change.
    saved: z.boolean(),
  })
  .strict()

export const relayManagedDatabaseSchema = z
  .object({
    containerId: z.string().nullable(),
    createdAt: z.string().datetime(),
    databaseName: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u),
    engine: databaseEngineSchema,
    hostname: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/u),
    id: databaseIdSchema,
    image: z.string().min(1).max(512),
    internalPort: z.number().int().min(1).max(65_535),
    members: z.array(relayDatabaseMemberSchema),
    // Relays before resource-limits-v1 report neither.
    limits: observedResourceLimitsSchema.default(NO_RESOURCE_LIMITS),
    /** The data volume's size when the Relay last measured it. */
    diskUsedBytes: z.number().int().nonnegative().nullable().default(null),
    name: relayDatabaseNameSchema,
    observedState: z.enum([
      "provisioning",
      "starting",
      "running",
      "stopped",
      "failed",
    ]),
    /** Where its provisioning is, until the database exists. */
    provisioning: provisioningStateSchema.optional(),
    shortId: z.string().regex(/^[a-f0-9]{8}$/u),
    /** When its container last started; null while it isn't running. */
    startedAt: z.string().datetime().nullable().default(null),
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

export const relayPrepareDatabaseSchema = relayCreateDatabaseSchema.extend({
  idempotencyKey: z.uuid(),
})

export const relayProvisionDatabaseSchema = z
  .object({ databaseId: databaseIdSchema })
  .strict()

export const relayDatabaseActionSchema = z
  .object({
    action: z.enum(["start", "stop", "restart", "kill"]),
    databaseId: databaseIdSchema,
  })
  .strict()

export const relayDatabaseLimitsSchema = z
  .object({
    databaseId: databaseIdSchema,
    limits: resourceLimitsInputSchema,
  })
  .strict()

export const relayDeleteDatabaseSchema = z
  .object({
    databaseId: databaseIdSchema,
    deleteData: z.boolean().default(true),
  })
  .strict()

/**
 * A game server, App, database, or Kiln volume being deleted, by its full
 * ID. Frozen, it's quiet (a database keeps running for its live dump), and
 * the Relay refuses every change to it but its final backup and its
 * deletion; unfrozen, it is a resource like any other again.
 */
export const relayResourceFreezeSchema = z
  .object({
    deletionId: z.uuid(),
    id: z.string().regex(/^[a-f0-9]{40}$/u),
    // A volume is a Kiln volume, by its ID; an App's own volumes go with it.
    kind: z.enum(["app", "database", "instance", "volume"]),
  })
  .strict()

export type RelayResourceFreeze = z.infer<typeof relayResourceFreezeSchema>

export const relayRotateDatabaseCredentialsSchema = z
  .object({
    currentPassword: z.string().min(24).max(256),
    databaseId: databaseIdSchema,
    nextPassword: z.string().min(24).max(256),
    username: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u),
  })
  .strict()

// Connects one member to a database, or disconnects it. The Relay keeps the
// connection, and joins the member to it whenever its containers change.
export const relayDatabaseNetworkSchema = z
  .object({
    connected: z.boolean(),
    databaseId: databaseIdSchema,
    member: databaseConnectionMemberSchema,
  })
  .strict()
  .refine(
    (input) =>
      input.member.kind !== "database" || input.member.id !== input.databaseId,
    "A database can't connect to itself"
  )

// Hands the Relay the database connections Hearth kept in Apps' configs,
// once per Relay. Repeating it changes nothing more: the Relay adds what it
// doesn't have, for Apps and databases it still has.
export const relayDatabaseNetworkImportSchema = z
  .object({
    apps: z
      .array(
        z
          .object({
            appId: z.string().regex(/^[a-f0-9]{40}$/u),
            databaseIds: z.array(databaseIdSchema).min(1).max(32),
          })
          .strict()
      )
      .min(1)
      .max(100),
  })
  .strict()

export const relayDatabaseNetworkImportResultSchema = z
  .object({ imported: z.number().int().nonnegative() })
  .strict()

// A database's login, for the Relay to act on the database as its own user.
// Dumps themselves travel as files (see `databaseFileRootId`): an export
// writes one for the browser to download, and an import reads the one the
// browser uploaded.
export const relayDatabaseExportSchema = z
  .object({
    databaseId: databaseIdSchema,
    password: z.string().min(24).max(256),
    username: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u),
  })
  .strict()

// The upload an import runs, which only that import names.
export const relayDatabaseImportFileSchema = z
  .string()
  .regex(/^import-[A-Za-z0-9-]{16,64}$/u)

export const relayDatabaseImportSchema = relayDatabaseExportSchema.extend({
  fileName: relayDatabaseImportFileSchema,
})

export const relayDatabaseInspectRequestSchema = z
  .object({ databaseId: databaseIdSchema })
  .strict()

// The database's container as Docker has it: its name, its data volume's
// folder on the host, and how much that volume holds, or null when Docker
// can't say.
export const relayDatabaseContainerSchema = z
  .object({
    containerName: z.string().min(1).max(256),
    dataDirectory: z.string().min(1).max(4096).nullable(),
    volumeBytes: z.number().int().nonnegative().nullable(),
  })
  .strict()

export const relayDatabaseWipeSchema = relayDatabaseExportSchema

export const relayStateDatabaseReadSchema = z
  .object({ request: databaseReadRequestSchema })
  .strict()

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
  // The database is being deleted, which ends every session on it.
  "deleting",
  // The client could not be started, as when the container has no shell, or
  // its connection failed.
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
  // The Relay answers the client's queries to the terminal (cursor position,
  // device attributes, the colors `terminalColorQuery` reads), so pages
  // don't. Older Relays leave them to the pages.
  answersQueries: z.boolean().optional(),
})

// The colors Hearth's terminal shows, as `#rrggbb`: its 16 ANSI colors, and
// the foreground, background, and cursor with the default accent. The Relay
// reports them to clients that ask. The terminal is dark in every theme.
export const terminalColors = {
  ansi: [
    // black, red, green, yellow, blue, magenta, cyan, white
    "#1c1917",
    "#f87171",
    "#4ade80",
    "#facc15",
    "#60a5fa",
    "#e879f9",
    "#22d3ee",
    "#d6d3d1",
    // The same, bright.
    "#78716c",
    "#fca5a5",
    "#86efac",
    "#fde68a",
    "#93c5fd",
    "#f0abfc",
    "#67e8f9",
    "#fafaf9",
  ],
  background: "#000000",
  cursor: "#fa822e",
  foreground: "#eceae9",
} as const

// The cursor Hearth's terminal shows, which the Relay reports to clients
// that ask.
export const terminalCursor = { blink: true, style: "bar" } as const

// The colors an `OSC <ident> ; <data>` sequence asks for, read the way xterm
// reads it: palette indices for 4, or 10, 11, and 12 for the foreground,
// background, and cursor (each slot after the first asks for the next, up to
// the cursor). Null when it also sets a color, which only a page can do, so
// it is left whole to the pages. The Relay answers the rest, and pages
// ignore them.
export function terminalColorQuery(
  ident: number,
  data: string
): Array<number> | null {
  const slots = data.split(";")
  const asked: Array<number> = []
  if (ident === 4) {
    // Index and color pairs; xterm skips a pair with an index out of range
    // and a slot left over.
    for (let slot = 0; slot + 1 < slots.length; slot += 2) {
      const index = /^\d+$/.test(slots[slot]!)
        ? Number.parseInt(slots[slot]!, 10)
        : 256
      if (index > 255) continue
      if (slots[slot + 1] === "?") asked.push(index)
      else if (isTerminalColor(slots[slot + 1]!)) return null
    }
    return asked
  }
  if (ident < 10 || ident > 12) return null
  for (let slot = 0; slot < slots.length && ident + slot <= 12; slot += 1) {
    if (slots[slot] === "?") asked.push(ident + slot)
    else if (isTerminalColor(slots[slot]!)) return null
  }
  return asked
}

// A color xterm sets: `rgb:` with 1-4 hex digits per channel, or `#` with
// 3, 6, 9, or 12. It ignores anything else.
function isTerminalColor(spec: string) {
  const value = spec.toLowerCase()
  if (value.startsWith("rgb:")) {
    const channels = value.slice(4).split("/")
    return (
      channels.length === 3 &&
      channels.every(
        (channel) =>
          /^[\da-f]{1,4}$/.test(channel) &&
          channel.length === channels[0]!.length
      )
    )
  }
  return /^#(?:[\da-f]{3}){1,4}$/.test(value)
}

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

// Host shells use the same session protocol as database and app terminals.
export const relayHostTerminalAttachSchema =
  relayDatabaseTerminalAttachSchema.omit({
    databaseId: true,
    password: true,
    username: true,
  })
export const relayHostTerminalWriteSchema =
  relayDatabaseTerminalWriteSchema.omit({ databaseId: true })
export const relayHostTerminalClaimSchema =
  relayDatabaseTerminalClaimSchema.omit({ databaseId: true })
export const relayHostFilesSchema = z.object({
  // `mounting` while the Relay restarts itself with the host's filesystem.
  status: z.enum(["disabled", "unmounted", "mounting", "ready"]),
  // Why the Relay can't read or change some host files, when it can tell.
  limitation: z
    .enum(["rootless", "user-namespace", "non-root", "selinux", "read-only"])
    .nullable(),
  // Why the last attempt to mount the host's filesystem failed.
  mountError: z.string().nullable(),
})
export type RelayHostFiles = z.infer<typeof relayHostFilesSchema>
export const relayHostAccessSchema = z.object({
  terminal: z.boolean(),
  files: relayHostFilesSchema,
  /**
   * The Relay's data folder on its host, where its database and the bundled
   * Traefik's files are, for opening them in its host files. Absent from
   * older Relays.
   */
  dataDirectory: z.string().min(1).optional(),
})

// A Docker named volume on a Relay. Kiln manages two kinds, each with a
// stable ID that names it to backups and deletion:
//
// - `kiln`: one Kiln made for Apps to share, named `kiln-<short ID>-<slug>`
//   after its ID and the name it was made with. No App owns it; any App's
//   configuration may mount it.
// - `app`: one an App's Compose project declares, owned by that App. Its ID
//   is `<App ID>/<name in the Compose file>`, which redeploys keep.
//
// The Relay's own data volume, kind `relay`, is the platform backup's and
// has no ID.
export const relayVolumeIdSchema = z.string().regex(/^[a-f0-9]{40}$/u)
// The key a Compose file declares a volume under.
export const composeVolumeNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u)
  .max(128)
const volumeAppIdSchema = z.string().regex(/^[a-f0-9]{40}$/u)
export const appVolumeIdSchema = z
  .string()
  .regex(/^[a-f0-9]{40}\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u)
  .max(169)
export const relayManagedVolumeIdSchema = z.union([
  relayVolumeIdSchema,
  appVolumeIdSchema,
])
/** The ID of the volume an App's Compose project declares under `name`. */
export function appVolumeId(appId: string, name: string): string {
  return `${appId}/${name}`
}
export const RELAY_VOLUME_NAME_MAX_LENGTH = 64
export const relayVolumeNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(RELAY_VOLUME_NAME_MAX_LENGTH)
// A container that mounts a volume, and the Kiln resource it belongs to, by
// its labels.
export const relayVolumeMountSchema = z.object({
  container: z.string(),
  destination: z.string(),
  kind: z.enum(["app", "database", "instance", "relay", "other"]),
  readOnly: z.boolean(),
  // The app's, database's, or game server's ID, when the container names one.
  resourceId: z.string().nullable(),
  running: z.boolean(),
})
// An App that uses a volume: its configuration names it, deployed or not,
// or one of its containers mounts it now.
export const relayVolumeUserSchema = z.object({
  appId: volumeAppIdSchema,
  configured: z.boolean(),
  mounted: z.boolean(),
})
export const relayVolumeSchema = z.object({
  createdAt: z.string().nullable(),
  dockerName: z.string().min(1),
  // Null for the Relay's own data volume, and for a volume an App's project
  // made under a name another of its volumes now holds, such as after the
  // Compose file renamed it.
  id: relayManagedVolumeIdSchema.nullable(),
  kind: z.enum(["app", "kiln", "relay"]),
  // Where its files are on the host.
  mountpoint: z.string().nullable(),
  mounts: z.array(relayVolumeMountSchema),
  name: z.string(),
  // The App whose Compose project made it, and the name it has there.
  owner: z
    .object({ appId: volumeAppIdSchema, volume: composeVolumeNameSchema })
    .nullable(),
  // Null until Docker has measured it.
  sizeBytes: z.number().int().nonnegative().nullable(),
  users: z.array(relayVolumeUserSchema),
})
// What an App's containers mount that no managed volume or the App's folder
// holds, so backups can't cover it: a volume Docker named itself, a named
// volume Kiln doesn't manage, or a path on the node outside the App's
// folder.
export const relayUncoveredMountSchema = z.object({
  appId: volumeAppIdSchema,
  container: z.string(),
  destination: z.string(),
  kind: z.enum(["anonymous", "bind", "volume"]),
  service: z.string(),
  // The volume's Docker name, or the path on the node.
  source: z.string(),
})
export const relayVolumesSchema = z.object({
  // Whether Docker is measuring the volumes, so sizes are on their way.
  measuring: z.boolean(),
  // Whether every paired Hearth that can configure Apps has told the Relay
  // which volumes its Apps' configurations name. Until they have, `users`
  // may leave some out and deletion is refused, for `reason`.
  protection: z.object({
    ready: z.boolean(),
    reason: z.string().nullable(),
  }),
  uncovered: z.array(relayUncoveredMountSchema),
  volumes: z.array(relayVolumeSchema),
})
// The part of a volume's Docker name its name gives: lowercase letters,
// digits, and dashes, as Docker allows.
export function relayVolumeSlug(name: string): string {
  return (
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+/u, "")
      .slice(0, 40)
      .replace(/-+$/u, "") || "volume"
  )
}
export const relayVolumeCreateSchema = z.strictObject({
  id: relayVolumeIdSchema,
  name: relayVolumeNameSchema,
})
export const relayVolumeRenameSchema = relayVolumeCreateSchema
export const relayVolumeDeleteSchema = z.strictObject({
  id: relayVolumeIdSchema,
})
// Every Kiln volume an App's configuration mounts, replacing those the same
// Hearth sent for it before. Hearth sends the configuration's and the
// saved one's together before saving one that adds a volume, so up to
// twice a configuration's 32 mounts, and the saved one's after each save.
export const relayAppVolumesWriteSchema = z.strictObject({
  appId: volumeAppIdSchema,
  volumeIds: z.array(relayVolumeIdSchema).max(64),
})
// Every App configuration's volumes one Hearth keeps for the Relay,
// replacing all it sent before, and the Apps whose configurations it
// couldn't read, which keep deletion waiting until it can.
export const relayAppVolumesImportSchema = z.strictObject({
  apps: z.array(relayAppVolumesWriteSchema).max(10_000),
  unresolvedAppIds: z.array(volumeAppIdSchema).max(10_000),
})
// The Relay's refusal while it waits for that import, followed by why.
export const RELAY_VOLUME_REFERENCES_PENDING =
  "The Relay doesn't know yet which Apps use its volumes"
export type RelayVolume = z.infer<typeof relayVolumeSchema>
export type RelayVolumes = z.infer<typeof relayVolumesSchema>
export type RelayVolumeMount = z.infer<typeof relayVolumeMountSchema>
export type RelayVolumeUser = z.infer<typeof relayVolumeUserSchema>
export type RelayUncoveredMount = z.infer<typeof relayUncoveredMountSchema>

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

// GitHub builds a Dockerfile or runs a Compose file from a repository. Hearth
// keeps which repository; the Relay gets the commit to deploy with each
// deployment.
export const appSourceTypeSchema = z.enum([
  "image",
  "dockerfile",
  "compose",
  "github",
])

export const appGitHubBuildSchema = z.enum(["dockerfile", "compose"])

// A file in a repository, from its root: no leading slash, no `..`.
export const appRepositoryPathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path
        .split("/")
        .every(
          (segment) => segment !== "" && segment !== "." && segment !== ".."
        ),
    "Use a path inside the repository, like Dockerfile or deploy/compose.yaml"
  )

// owner/name, as GitHub spells them.
export const githubRepositoryNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/u)

export const gitCommitShaSchema = z.string().regex(/^[a-f0-9]{40}$/u)

// What a GitHub deployment builds: one commit of one repository, read with a
// token that only reads that repository and expires within the hour. The
// Relay keeps neither once the deployment finishes.
export const relayAppGitHubCheckoutSchema = z
  .object({
    build: appGitHubBuildSchema,
    commit: gitCommitShaSchema,
    path: appRepositoryPathSchema,
    repository: githubRepositoryNameSchema,
    token: z.string().min(1).max(1_024),
  })
  .strict()

export const appPortSchema = z
  .object({
    containerPort: z.number().int().min(1).max(65_535),
    hostPort: z.number().int().min(1).max(65_535),
    protocol: z.enum(["tcp", "udp"]),
  })
  .strict()

// Memory and CPU limits by service name. A service without an entry has
// none.
export const appServiceLimitsSchema = z
  .record(appServiceNameSchema, serviceResourceLimitsSchema)
  .refine((limits) => Object.keys(limits).length <= 64, "Too many services")

const appContainerPathSchema = z
  .string()
  .max(512)
  .regex(/^\/[^\0:]*$/u, "Use an absolute path inside the container")

// The largest file an app can mount from its config.
export const APP_MOUNT_FILE_MAX_LENGTH = 100_000

// What an app mounts into its containers, which keep nothing else across
// deploys: one of the Relay's named volumes, a path on the node, or a file
// kept in the config.
export const appMountSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("volume"), volumeId: relayVolumeIdSchema }),
  z.strictObject({
    path: z
      .string()
      .max(1_024)
      .regex(/^\/[^\0]*$/u, "Use an absolute path on the node"),
    type: z.literal("host"),
  }),
  z.strictObject({
    content: z.string().max(APP_MOUNT_FILE_MAX_LENGTH),
    type: z.literal("file"),
  }),
])

export const appMountSchema = z.strictObject({
  // Stable across edits; a file mount is kept on the Relay under it.
  id: z.string().regex(/^[a-z0-9]{8,32}$/u),
  readOnly: z.boolean(),
  // The Compose service it's mounted in, or null for every service and for
  // an image's or Dockerfile's one container.
  service: appServiceNameSchema.nullable(),
  source: appMountSourceSchema,
  target: appContainerPathSchema,
})

export const appMountsSchema = z
  .array(appMountSchema)
  .max(32)
  .refine(
    (mounts) =>
      new Set(mounts.map((mount) => mount.id)).size === mounts.length &&
      new Set(mounts.map((mount) => `${mount.service ?? ""}:${mount.target}`))
        .size === mounts.length,
    "Mount each path once"
  )

// Every source is kept, so switching between them loses nothing; only
// `sourceType` deploys.
export const appConfigSchema = z
  .object({
    // Replaces the image's command, for images and Dockerfiles.
    command: z.string().max(4_000),
    compose: z.string().max(400_000),
    dockerfile: z.string().max(200_000),
    // KEY=VALUE lines, as in an env file.
    environment: z.string().max(65_536),
    image: z.string().trim().max(512),
    // Configs saved before mounts have none.
    mounts: appMountsSchema.default([]),
    ports: z.array(appPortSchema).max(32),
    serviceLimits: appServiceLimitsSchema.default({}),
    sourceType: appSourceTypeSchema,
  })
  .strict()

export const defaultAppConfig: z.infer<typeof appConfigSchema> = {
  command: "",
  compose: "",
  dockerfile: "",
  environment: "",
  image: "",
  mounts: [],
  ports: [],
  serviceLimits: {},
  sourceType: "image",
}

export const appDeploymentStateSchema = z.enum([
  "running",
  "succeeded",
  "failed",
])

// Not strict: a newer Relay may report more about its containers.
// One thing a container mounts: a named volume by its name, a bind by its
// path on the node, or a tmpfs, which has no source.
export const relayAppContainerMountSchema = z.object({
  destination: z.string(),
  readOnly: z.boolean(),
  source: z.string(),
  type: z.string(),
})

export const relayAppContainerSchema = z.object({
  createdAt: z.string().datetime().nullable(),
  exitCode: z.number().int().nullable(),
  id: z.string().min(1),
  image: z.string(),
  labels: z.record(z.string(), z.string()),
  // The memory and CPU it runs with. Absent from older Relays.
  limits: observedResourceLimitsSchema.optional(),
  // What it mounts. Absent from older Relays.
  mounts: z.array(relayAppContainerMountSchema).optional(),
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
  // The commit a GitHub deployment built. Absent from older Relays.
  commit: gitCommitShaSchema.nullable().default(null),
  error: z.string().max(2_000).nullable(),
  finishedAt: z.string().datetime().nullable(),
  id: z.string().min(1).max(64),
  // Whether the new containers started beside the old ones and took over
  // once healthy, rather than replacing them stopped. Null until decided,
  // and from older Relays.
  rolling: z.boolean().nullable().default(null),
  sourceType: appSourceTypeSchema,
  startedAt: z.string().datetime(),
  state: appDeploymentStateSchema,
})

export const relayAppSchema = z.object({
  // Databases whose networks its containers are on now.
  connectedDatabaseIds: z.array(databaseIdSchema),
  containers: z.array(relayAppContainerSchema),
  // The app's folder on the Relay's host: a pasted Compose file's project
  // directory and a Dockerfile's build context.
  dataDirectory: z.string(),
  deployment: relayAppDeploymentSchema.nullable(),
  // The name its containers answer to on the app's network.
  hostname: z.string(),
  id: appIdSchema,
  network: z.string(),
  observedState: z.enum([
    "provisioning",
    "starting",
    "running",
    "stopped",
    "failed",
  ]),
  /** Where its provisioning is, until the app exists. */
  provisioning: provisioningStateSchema.optional(),
  // Databases the Relay keeps it connected to, joined on every deploy.
  savedDatabaseIds: z.array(databaseIdSchema),
  shortId: z.string().regex(/^[a-f0-9]{8}$/u),
  status: z.string().min(1).max(280),
})

export const relayCreateAppSchema = z
  .object({ id: appIdSchema, name: appNameSchema })
  .strict()

export const relayPrepareAppSchema = relayCreateAppSchema.extend({
  idempotencyKey: z.uuid(),
})

export const relayProvisionAppSchema = z.object({ appId: appIdSchema }).strict()

/** A manifest digest, as registries name an image's exact content. */
export const imageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u)

export const relayDeployAppSchema = z
  .object({
    appId: appIdSchema,
    config: appConfigSchema,
    // Required when the config's source is GitHub.
    github: relayAppGitHubCheckoutSchema.optional(),
    // For an image source, the digest to deploy in place of whatever its
    // tag names when the deployment pulls it.
    imageDigest: imageDigestSchema.optional(),
    name: appNameSchema,
  })
  .strict()

// What image apps' tags name in their registries now, against the images
// their containers run. Each app names the image its saved config deploys.
export const relayAppImageCheckSchema = z
  .object({
    apps: z
      .array(
        z
          .object({
            appId: appIdSchema,
            image: z.string().trim().min(1).max(512),
          })
          .strict()
      )
      .min(1)
      .max(16),
  })
  .strict()

export const relayAppImageCheckResultSchema = z.discriminatedUnion("status", [
  // The tag's digest now, and the digest the app runs: the one it
  // deployed, or for a container deployed before Kiln labelled that, the
  // digests its image was pulled as.
  z.object({
    appId: appIdSchema,
    latestDigest: imageDigestSchema,
    runningDigests: z.array(imageDigestSchema),
    status: z.literal("checked"),
  }),
  // The app's container runs another image than the one named, as when
  // its config changed since it deployed.
  z.object({ appId: appIdSchema, status: z.literal("changed") }),
  z.object({ appId: appIdSchema, status: z.literal("not_deployed") }),
  // A deployment is running; its outcome decides what runs.
  z.object({ appId: appIdSchema, status: z.literal("deploying") }),
  z.object({
    appId: appIdSchema,
    error: z.string().max(500),
    status: z.literal("error"),
  }),
])

export const relayAppImageCheckResultsSchema = z.array(
  relayAppImageCheckResultSchema
)

// One of the app's recent deployments, with its log: the running one, or one
// the Relay kept.
export const relayAppDeploymentReadSchema = z
  .object({ appId: appIdSchema, deploymentId: z.string().min(1).max(64) })
  .strict()

export const relayAppLimitsSchema = z
  .object({
    appId: appIdSchema,
    serviceLimits: appServiceLimitsSchema,
  })
  .strict()

export const relayAppActionSchema = z
  .object({
    action: z.enum(["start", "stop", "restart", "kill"]),
    appId: appIdSchema,
  })
  .strict()

export const relayDeleteAppSchema = z
  .object({
    appId: appIdSchema,
    deleteData: z.boolean().default(true),
    // The App's own volumes its deletion may take, by ID: those it planned
    // to, and backed up if asked. Any other stays. Left out, every volume
    // only the App's own Compose projects made and nothing mounts goes.
    volumeIds: z.array(appVolumeIdSchema).max(256).optional(),
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
  // Hearth sends `limits` to Relays with `resource-limits-v1`, and
  // `diskLimitBytes` alone to older ones.
  diskLimitBytes: relayRequestedDiskLimitBytesSchema.default(
    DEFAULT_INSTANCE_DISK_LIMIT_BYTES
  ),
  limits: resourceLimitsInputSchema.optional(),
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
    limits: resourceLimitsInputSchema.optional(),
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
    // A game server, an App's service, or a database (see
    // `tailscaleMemberIdSchema`).
    memberId: tailscaleMemberIdSchema,
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

// A label shown beside the hostname. Empty when the route has none.
export const relayInstanceWebRouteNameSchema = z.string().trim().max(32)

// Whether the hostname's www counterpart (www.example.com for example.com,
// or example.com for www.example.com) redirects to it or serves the same.
export const relayWebRouteWwwSchema = z.enum(["none", "redirect", "serve"])

// A route that sends its visitors to another URL instead of a port.
export const relayWebRouteRedirectSchema = z
  .object({
    permanent: z.boolean().default(true),
    preservePath: z.boolean().default(true),
    to: z
      .url({
        hostname: z.regexes.domain,
        normalize: true,
        protocol: /^https?$/u,
      })
      .max(2_048),
  })
  .strict()

const relayInstanceWebRouteConfigurationSchema = z
  .object({
    hostname: webRouteHostnameSchema,
    // Whether plain HTTP requests redirect to HTTPS, or are served as well.
    httpsRedirect: z.boolean().default(true),
    name: relayInstanceWebRouteNameSchema.default(""),
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
    // The domain shown for the server or app, such as in its header.
    primary: z.boolean().default(false),
    redirect: relayWebRouteRedirectSchema.nullable().default(null),
    stripPrefix: z.boolean().default(true),
    // The port it serves; none for a redirect.
    targetPort: z.number().int().min(1).max(65_535).nullable(),
    www: relayWebRouteWwwSchema.default("none"),
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

// Whether a redirect lands back on the route it came from. With the path
// kept, the destination's path is followed by the request's, which starts
// with the route's own path.
function redirectsToItself(
  route: { readonly hostname: string; readonly path: string | null },
  target: URL,
  preservePath: boolean
): boolean {
  if (!webRouteHostnames(route).includes(target.hostname)) return false
  const prefix = route.path ?? "/"
  const landing = preservePath
    ? `${target.pathname.replace(/\/$/u, "")}${prefix}`
    : target.pathname
  return landing.startsWith(prefix)
}

function relayInstanceWebRouteArraySchema<
  Route extends z.ZodType<
    z.output<typeof relayInstanceWebRouteConfigurationSchema>
  >,
>(route: Route) {
  return z
    .array(route)
    .max(16)
    .superRefine((routes, context) => {
      const seen = new Set<string>()
      let primary = false
      routes.forEach((item, index) => {
        const issue = (message: string, field: string) =>
          context.addIssue({ code: "custom", message, path: [index, field] })
        if (item.www !== "none" && wwwCounterpart(item.hostname) === null) {
          issue(`${item.hostname} has no www counterpart`, "www")
        }
        for (const endpoint of webRouteEndpoints(item)) {
          if (seen.has(endpoint)) {
            issue(`${endpoint} is already routed`, "hostname")
          }
          seen.add(endpoint)
        }
        if (item.redirect) {
          if (item.targetPort !== null) {
            issue("A redirect has no port", "targetPort")
          }
          const target = new URL(item.redirect.to)
          if (redirectsToItself(item, target, item.redirect.preservePath)) {
            issue("A route can't redirect to itself", "redirect")
          }
          if (item.redirect.preservePath && (target.search || target.hash)) {
            issue(
              "Remove the query from the destination, or don't keep the path",
              "redirect"
            )
          }
          if (item.primary) issue("A redirect can't be primary", "primary")
        } else if (item.targetPort === null) {
          issue("Enter the port the route serves", "targetPort")
        }
        if (item.primary) {
          if (primary) issue("Only one route can be primary", "primary")
          primary = true
        }
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

// What the Relay's proxy serves: the Traefik configuration it generates (the
// static file only for its bundled Traefik), and each web route with the
// server or app it reaches.
export const relayProxyConfigurationSchema = z.object({
  // Both files only exist for the bundled Traefik.
  dynamicConfiguration: z.string().nullable(),
  routes: z.array(
    z.object({
      hostname: z.string(),
      id: z.string(),
      name: z.string(),
      owner: z.object({
        id: z.string(),
        kind: z.enum(["app", "server"]),
        service: z.string().nullable(),
      }),
      path: z.string().nullable(),
      // Absent from older Relays.
      primary: z.boolean().default(false),
      redirect: relayWebRouteRedirectSchema.nullable().default(null),
      stripPrefix: z.boolean(),
      targetPort: z.number().int().nullable(),
      // Where requests go: the upstream it proxies to, or a redirect's URL.
      upstream: z.string(),
      www: relayWebRouteWwwSchema.default("none"),
    })
  ),
  staticConfiguration: z.string().nullable(),
})

export type RelayProxyConfiguration = z.infer<
  typeof relayProxyConfigurationSchema
>

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

// What the Relay applied; `null` means no limit. Relays before
// `resource-limits-v1` send no CPU limit and 0 for no memory limit.
export const relayInstanceLimitsSchema = z.object({
  cpuMillis: z.number().int().positive().nullable().default(null),
  diskBytes: relayDiskLimitBytesSchema.nullable(),
  memoryBytes: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .transform((bytes) => (bytes === 0 ? null : bytes)),
})

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
  // The server's folder on the Relay's host. Absent from older Relays.
  hostDirectory: z.string().min(1).optional(),
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
    cpuMillis: null,
    diskBytes: DEFAULT_INSTANCE_DISK_LIMIT_BYTES,
    memoryBytes: null,
  }),
  resources: relayInstanceResourcesSchema.nullable().default(null),
  provisioning: relayInstanceProvisioningSchema.optional(),
})

export const relayTailscaleStackBindingSchema =
  relayTailscaleStackBindingInputSchema.extend({
    address: z.ipv4(),
  })

/**
 * Rewrites a stack saved before members were typed: its bindings named the
 * member `instanceId`, a game server by its bare ID. Returns the stack with
 * `memberId` in their place, or null when it has nothing to rewrite. The
 * Relay's `stack.json` and removal snapshots and Hearth's deployments
 * share this shape. Migrations only; everything else reads typed IDs.
 */
export function migrateLegacyTailscaleBindings(
  stack: unknown
): Record<string, unknown> | null {
  if (!stack || typeof stack !== "object" || Array.isArray(stack)) return null
  const { bindings } = stack as { bindings?: unknown }
  if (!Array.isArray(bindings)) return null
  if (
    !bindings.some(
      (binding) =>
        binding && typeof binding === "object" && "instanceId" in binding
    )
  )
    return null
  return {
    ...stack,
    bindings: bindings.map((binding: unknown) => {
      if (!binding || typeof binding !== "object" || !("instanceId" in binding))
        return binding
      const { instanceId, ...rest } = binding as Record<string, unknown>
      const memberId =
        typeof instanceId === "string"
          ? legacyTailscaleMemberId(instanceId)
          : null
      if (!memberId) {
        throw new Error(
          `Tailscale binding names an unknown member: ${String(instanceId)}`
        )
      }
      return { ...rest, memberId }
    }),
  }
}

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
  "schedule-continue-on-failure",
  "tailscale-stacks",
  "tailscale-staged-removal",
])

const relayMemoryBytesSchema = z.number().int().nonnegative()

/**
 * Memory used by the Relay itself, separate from the host totals in
 * `RelayNode.memory`. `process` is the Relay's Node.js process. `container` is
 * the Relay container's cgroup v2 accounting, which also counts page cache the
 * kernel charged to the Relay (for example from walking server directories or
 * reading files for backups); that cache is reclaimable, so it is reported as
 * `fileBytes` rather than folded into the process numbers. `container` is null
 * when the Relay is not in a cgroup v2 container or the files are unreadable.
 */
export const relayProcessMemorySchema = z.object({
  process: z.object({
    rssBytes: relayMemoryBytesSchema,
    heapUsedBytes: relayMemoryBytesSchema,
    heapTotalBytes: relayMemoryBytesSchema,
    externalBytes: relayMemoryBytesSchema,
    arrayBuffersBytes: relayMemoryBytesSchema,
  }),
  container: z
    .object({
      /** `memory.current`: everything charged to the cgroup. */
      usedBytes: relayMemoryBytesSchema,
      /** `memory.max`, or null when the cgroup is unlimited. */
      limitBytes: relayMemoryBytesSchema.nullable(),
      anonBytes: relayMemoryBytesSchema.nullable(),
      fileBytes: relayMemoryBytesSchema.nullable(),
      activeFileBytes: relayMemoryBytesSchema.nullable(),
      inactiveFileBytes: relayMemoryBytesSchema.nullable(),
      kernelBytes: relayMemoryBytesSchema.nullable(),
    })
    .nullable(),
})

/**
 * A Hearth or Relay update a Relay ran, from its own records. Its result
 * outlives the Hearth that asked for it, so a Hearth replaced mid-update
 * learns how it went from the Relay instead of the lost reply.
 */
export const relaySystemUpdateSchema = z.object({
  id: z.uuid(),
  component: z.enum(["hearth", "relay"]),
  error: z.string().max(2_000).nullable(),
  finishedAt: z.string().datetime().nullable(),
  phase: z.string().max(100).optional(),
  /** The Hearth request that started it, when Hearth named one. */
  requestId: z.uuid().optional(),
  startedAt: z.string().datetime(),
  status: z.enum(["failed", "running", "succeeded"]),
  version: z.string().min(1).max(100),
})

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
  /**
   * When the node itself booted, to the minute. Absent from Relays that
   * predate it. `startedAt` and `uptimeSeconds` are the Relay's own.
   */
  bootedAt: z.string().datetime().optional(),
  cpu: z.object({
    cores: z.number().int().positive(),
    /** One-minute load as a percentage of all cores, not 100% per core. */
    loadPercent: z.number().min(0),
    /**
     * Like "AMD EPYC 7763 64-Core Processor". Absent when the CPU doesn't
     * say, and from Relays that predate it.
     */
    model: z.string().min(1).max(200).optional(),
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
  /**
   * The host's operating system as Docker reports it, like "Ubuntu 24.04.1
   * LTS". Absent when Docker can't say, and from Relays that predate it.
   */
  operatingSystem: z.string().min(1).max(200).optional(),
  connectedAt: z.string().datetime(),
  /** Absent from Relays that predate memory reporting. */
  relayMemory: relayProcessMemorySchema.optional(),
  /**
   * The Relay's own usage, sampled like a server's: its container's CPU and
   * memory, and everything Kiln keeps in the Relay's data directory measured
   * against the node's disk. Absent until the first sample, and from Relays
   * that predate it.
   */
  relayResources: relayInstanceResourcesSchema.optional(),
  /**
   * The latest update of each container this Relay updates (itself, and
   * Hearth when it shares the Docker host), running or finished. Absent from
   * Relays that predate it.
   */
  updates: z.array(relaySystemUpdateSchema).max(8).optional(),
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

/**
 * Kiln's own services on a Relay's Docker host: Hearth, its MySQL database,
 * and its cache. A Relay in platform mode installed them and manages them
 * (`relay`); otherwise they were deployed some other way, such as Compose or
 * Coolify, and the Relay only reports them (`external`).
 */
export const relayPlatformManagementSchema = z.enum(["relay", "external"])

export const relayPlatformServiceRoleSchema = z.enum([
  "hearth",
  "database",
  "cache",
])

/**
 * Which of Kiln's containers a v2 request is for: a service, or the Traefik
 * in front of Hearth (`proxy`).
 */
export const relayPlatformTargetSchema = z.enum([
  "hearth",
  "database",
  "cache",
  "proxy",
])

export const relayPlatformServiceSchema = z.object({
  /** Actions this Hearth may take on it. Empty for external services. */
  actions: z.array(z.enum(["restart"])).max(4),
  /**
   * Who runs it: this Relay (`kiln`), Coolify, Docker Compose, or something
   * else. Absent from older Relays.
   */
  managedBy: z.enum(["kiln", "coolify", "compose", "external"]).optional(),
  container: z.string().min(1).max(255).nullable(),
  health: z.enum(["healthy", "starting", "unhealthy"]).nullable(),
  image: z.string().min(1).max(500).nullable(),
  role: relayPlatformServiceRoleSchema,
  startedAt: z.string().datetime().nullable(),
  state: z.enum([
    "running",
    "starting",
    "unhealthy",
    "restarting",
    "stopped",
    "missing",
    "updating",
  ]),
  /**
   * Whether it has a shell to open a terminal in; Hearth's image doesn't.
   * From Relays with `relay-platform-v2`, and null until checked.
   */
  shell: z.boolean().nullable().optional(),
  version: z.string().min(1).max(100).nullable(),
})

export const relayPlatformProxySchema = relayPlatformServiceSchema
  .omit({ role: true })
  .extend({ managedBy: z.enum(["kiln", "coolify", "external"]) })

export const relayPlatformStatusSchema = z.object({
  /** Whether this Hearth may restart and repair them. */
  canManage: z.boolean(),
  checkedAt: z.string().datetime(),
  hearthUrl: z.string().max(2_000).nullable(),
  installationId: z.string().min(1).max(120).nullable(),
  /** Why the Relay is holding off, such as a missing database volume. */
  issue: z.string().max(2_000).nullable(),
  management: relayPlatformManagementSchema,
  /**
   * `installing` until Hearth first starts, `maintenance` while an operator
   * holds Hearth stopped from the Relay's command line, `blocked` when the
   * Relay won't continue without one.
   */
  phase: z.enum(["installing", "ready", "maintenance", "blocked"]),
  /**
   * The Traefik in front of Hearth, from Relays with `relay-platform-v2`:
   * the one this Relay runs (`kiln`), Coolify's, or another found on ports
   * 80 and 443 (`external`). Only Kiln's own can be restarted from here.
   */
  proxy: relayPlatformProxySchema.nullable().optional(),
  services: z.array(relayPlatformServiceSchema).max(8),
})

// `proxy` needs `relay-platform-v2`.
export const relayPlatformLogsInputSchema = z.object({
  lines: z.number().int().min(1).max(2_000).default(500),
  role: relayPlatformTargetSchema,
})

export const relayPlatformLogsSchema = z.object({
  lines: z.array(z.string()).max(2_000),
  role: relayPlatformTargetSchema,
})

export const relayPlatformActionInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("restart"),
    role: relayPlatformTargetSchema,
  }),
  // Recreates whatever is missing and starts whatever stopped.
  z.object({ action: z.literal("repair") }),
])

/** A Relay's Kiln installation ID, and whether it can change (`relay.installation.read`). */
export const relayInstallationSchema = z.object({
  /** Whether KILN_INSTALLATION_ID or the Relay's platform state fixes it. */
  fixed: z.boolean(),
  installationId: z.string().min(1).max(120).nullable(),
})

/**
 * Sets the Relay's installation ID, only while it's still `expected` (null
 * for none). Repeating it once applied succeeds.
 */
export const relayInstallationReplaceInputSchema = z.object({
  expectedInstallationId: z.string().min(1).max(120).nullable(),
  installationId: z.string().min(1).max(120),
})

export type RelayInstallation = z.infer<typeof relayInstallationSchema>

export type RelayPlatformManagement = z.infer<
  typeof relayPlatformManagementSchema
>
export type RelayPlatformStatus = z.infer<typeof relayPlatformStatusSchema>
export type RelayPlatformService = z.infer<typeof relayPlatformServiceSchema>
export type RelayPlatformServiceRole = z.infer<
  typeof relayPlatformServiceRoleSchema
>
export type RelayPlatformActionInput = z.infer<
  typeof relayPlatformActionInputSchema
>
export type RelayPlatformProxy = z.infer<typeof relayPlatformProxySchema>
export type RelayPlatformTarget = z.infer<typeof relayPlatformTargetSchema>

// A shell in one of Kiln's containers, kept like an app's: one per person
// per container. Needs `relay-platform-v2`.
const platformTerminalTargetShape = { role: relayPlatformTargetSchema }

export const relayPlatformTerminalAttachSchema = z
  .object({
    ...platformTerminalTargetShape,
    ...databaseTerminalSizeShape,
    attachmentId: databaseTerminalIdSchema,
    idleTimeoutMs: z
      .number()
      .int()
      .min(60_000)
      .max(24 * 60 * 60_000),
  })
  .strict()

export const relayPlatformTerminalRestartSchema = z
  .object(platformTerminalTargetShape)
  .strict()

export const relayPlatformTerminalWriteSchema = z
  .object({
    ...platformTerminalTargetShape,
    data: z.string().min(1).max(DATABASE_TERMINAL_WRITE_MAX_CHARACTERS),
    sessionId: databaseTerminalIdSchema,
  })
  .strict()

export const relayPlatformTerminalClaimSchema = z
  .object({
    ...platformTerminalTargetShape,
    ...databaseTerminalSizeShape,
    attachmentId: databaseTerminalIdSchema,
    sessionId: databaseTerminalIdSchema,
  })
  .strict()

// Hearth's own database, browsed through its MySQL container with the login
// Hearth itself uses. Needs `relay-platform-database-v1`.
const platformDatabaseLoginShape = {
  databaseName: z.string().regex(/^[A-Za-z0-9_$]{1,64}$/u),
  password: z.string().min(1).max(512),
  username: z.string().min(1).max(128),
}

export const relayPlatformDatabaseReadSchema = z
  .object({ ...platformDatabaseLoginShape, request: databaseReadRequestSchema })
  .strict()

export const relayPlatformDatabaseWriteSchema = z
  .object({
    ...platformDatabaseLoginShape,
    // As `relayDatabaseDataWriteSchema`'s: a guard against mistakes.
    readOnly: z.boolean().optional(),
    request: databaseWriteRequestSchema,
  })
  .strict()

export type RelayPlatformDatabaseRead = z.infer<
  typeof relayPlatformDatabaseReadSchema
>
export type RelayPlatformDatabaseWrite = z.infer<
  typeof relayPlatformDatabaseWriteSchema
>

const relaySnapshotRelaySchema = z.object({
  browserOrigin: relayProxyBrowserMetadataSchema.shape.browserOrigin.optional(),
  id: relayIdSchema,
  name: z.string().min(1).max(120),
  // Held paused by a Hearth, so it runs no changes. See
  // `relayControlOperationRefusedWhilePaused`.
  paused: z.boolean().optional(),
  /**
   * Present when Kiln's own services run on this Relay's Docker host. See
   * `relay.platform.read`.
   */
  platform: z.object({ management: relayPlatformManagementSchema }).optional(),
  proxyMode: relayProxyModeSchema.optional(),
  /**
   * The address players and web visitors reach this Relay's node at, as
   * game servers advertise it. Absent from Relays that predate it.
   */
  publicHost: z.string().min(1).max(253).optional(),
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

export const relayFilePutInputSchema = z
  .object({
    instanceId: fileRootIdSchema,
    path: relayFileMutationPathSchema,
    /**
     * The file's bytes, base64-encoded. 700 KiB of base64 (about 525 KiB of
     * file) keeps the control frame under `relayControlMaxFrameBytes`.
     */
    contentBase64: z.base64().max(700 * 1024),
    /**
     * Write only if the file is unchanged: its modification time, in whole
     * milliseconds, still matches, or null for a file that must not exist.
     * Omitted to write regardless.
     */
    unlessModifiedSince: z.number().int().nonnegative().nullable().optional(),
  })
  .strict()

/**
 * A precondition that failed leaves the file alone and says what's there,
 * so a caller can tell its own earlier write from someone else's.
 */
export const relayFilePutResultSchema = z.union([
  relayRemoteFileUploadResultSchema.extend({ conflict: z.literal(false) }),
  z
    .object({
      conflict: z.literal(true),
      current: z
        .object({
          /** The content's Git blob ID; null for a file too large to hash. */
          blob: z
            .string()
            .regex(/^[a-f0-9]{40}$/u)
            .nullable(),
          modifiedAt: z.number().int().nonnegative(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
])

// The largest image `instance.icon.read` returns. Its base64 stays well
// under `relayControlMaxFrameBytes`.
export const relayIconMaxBytes = 512 * 1024

/**
 * An image for an icon: a file under a file root (a game server's files, or
 * an app's data directory), or a file inside one of an app's containers, by
 * its absolute path there.
 */
export const relayIconReadInputSchema = z.union([
  z
    .object({
      instanceId: fileRootIdSchema,
      path: relayFileMutationPathSchema,
    })
    .strict(),
  z
    .object({
      appId: appIdSchema,
      service: appServiceNameSchema,
      path: z
        .string()
        .min(2)
        .max(1_024)
        .refine(
          (path) => path.startsWith("/") && !path.includes("\0"),
          "Enter an absolute path inside the container"
        ),
    })
    .strict(),
])

/** The image's bytes, or null when nothing is at the path. */
export const relayIconReadResultSchema = z
  .object({
    contentBase64: z.base64().max(Math.ceil(relayIconMaxBytes / 3) * 4),
    modifiedAt: z.number().int().nonnegative(),
    size: z.number().int().nonnegative().max(relayIconMaxBytes),
  })
  .strict()
  .nullable()

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

// Null when the Relay no longer keeps that deployment.
export const relayAppDeploymentLogSchema = z
  .object({
    deployment: relayAppDeploymentSchema,
    // Lines dropped from the front once the log reached its limits.
    dropped: z.number().int().nonnegative(),
    lines: z.array(relayConsoleLineSchema),
  })
  .nullable()

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

// A resource's usage now, null while nothing of it runs, and over the last
// minutes.
export const relayResourceUsageSchema = z.object({
  history: z
    .array(relayInstanceResourcesSchema)
    .max(relayResourceHistoryMaxSamples)
    .default([]),
  resources: relayInstanceResourcesSchema.nullable(),
})

export const relayWorkloadResourceKindSchema = z.enum(["app", "database"])

// An App's or database's usage; an App's by service too.
export const relayWorkloadUsageSchema = relayResourceUsageSchema.extend({
  services: z
    .array(relayResourceUsageSchema.extend({ service: appServiceNameSchema }))
    .max(64)
    .default([]),
})

// Which history a read of an App's or database's usage carries: the
// resource's, one service's, or none, so no answer holds more than one
// window of it.
export const relayWorkloadUsageHistorySchema = z
  .union([
    z.enum(["none", "resource"]),
    z.object({ service: appServiceNameSchema }).strict(),
  ])
  .default("resource")

export const relayWorkloadUsageReadSchema = z
  .object({ appId: appIdSchema, history: relayWorkloadUsageHistorySchema })
  .strict()

export const relayDatabaseUsageReadSchema = z
  .object({
    databaseId: databaseIdSchema,
    history: z.enum(["none", "resource"]).default("resource"),
  })
  .strict()

// What a browser following an App's or database's usage receives: history
// with the first event, the latest sample with each.
export const relayWorkloadUsageEventSchema = relayWorkloadUsageSchema.extend({
  id: z.string().min(1).max(64),
  kind: relayWorkloadResourceKindSchema,
  sequence: z.number().int().nonnegative(),
  type: z.literal("resource.usage"),
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
export type RelayDatabaseLimits = z.infer<typeof relayDatabaseLimitsSchema>
export type RelayDeleteDatabase = z.infer<typeof relayDeleteDatabaseSchema>
export type RelayRotateDatabaseCredentials = z.infer<
  typeof relayRotateDatabaseCredentialsSchema
>
export type DatabaseConnectionMember = z.infer<
  typeof databaseConnectionMemberSchema
>
export type DatabaseConnectionMemberKind = z.infer<
  typeof databaseConnectionMemberKindSchema
>
export type RelayDatabaseMember = z.infer<typeof relayDatabaseMemberSchema>
export type RelayDatabaseNetwork = z.infer<typeof relayDatabaseNetworkSchema>
export type RelayDatabaseNetworkImport = z.infer<
  typeof relayDatabaseNetworkImportSchema
>
export type RelayDatabaseExport = z.infer<typeof relayDatabaseExportSchema>
export type RelayDatabaseImport = z.infer<typeof relayDatabaseImportSchema>
export type RelayDatabaseContainer = z.infer<
  typeof relayDatabaseContainerSchema
>
export type RelayDatabaseWipe = z.infer<typeof relayDatabaseWipeSchema>
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
export type AppMount = z.infer<typeof appMountSchema>
export type AppMountSource = z.infer<typeof appMountSourceSchema>
export type AppDeploymentState = z.infer<typeof appDeploymentStateSchema>
export type RelayApp = z.infer<typeof relayAppSchema>
export type RelayAppContainer = z.infer<typeof relayAppContainerSchema>
export type RelayAppLimits = z.infer<typeof relayAppLimitsSchema>
export type RelayAppDeployment = z.infer<typeof relayAppDeploymentSchema>
export type RelayCreateApp = z.infer<typeof relayCreateAppSchema>
export type RelayDeployApp = z.infer<typeof relayDeployAppSchema>
export type AppGitHubBuild = z.infer<typeof appGitHubBuildSchema>
export type RelayAppGitHubCheckout = z.infer<
  typeof relayAppGitHubCheckoutSchema
>
export type RelayAppDeploymentRead = z.infer<
  typeof relayAppDeploymentReadSchema
>
export type RelayAppDeploymentLog = z.infer<typeof relayAppDeploymentLogSchema>
export type RelayAppImageCheck = z.infer<typeof relayAppImageCheckSchema>
export type RelayAppImageCheckResult = z.infer<
  typeof relayAppImageCheckResultSchema
>
export type RelayAppAction = z.infer<typeof relayAppActionSchema>
export type RelayDeleteApp = z.infer<typeof relayDeleteAppSchema>
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
export type ProvisioningKind = z.infer<typeof provisioningKindSchema>
export type ProvisioningPhase = z.infer<typeof provisioningPhaseSchema>
export type ProvisioningWorkPhase = z.infer<typeof provisioningWorkPhaseSchema>
export type ProvisioningState = z.infer<typeof provisioningStateSchema>
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
export type RelaySystemUpdate = z.infer<typeof relaySystemUpdateSchema>
export type RelaySnapshot = z.infer<typeof relaySnapshotSchema>
export type RelayProcessMemory = z.infer<typeof relayProcessMemorySchema>

/**
 * Builds the control-plane portion of a Relay snapshot update. High-frequency
 * resource samples use their dedicated stream and must not wake every Hearth
 * client through the fleet-wide realtime channel.
 *
 * `nodeResources` also sends the node whenever its resource samples (CPU,
 * memory, storage, uptime, Relay memory) change, for Hearths that advertise
 * `relaySnapshotNodeResourcesFeature`. Those Hearths keep their cached node
 * current and strip resource-only node changes with
 * `relaySnapshotControlDelta` before notifying browsers.
 */
export function createRelaySnapshotDelta(
  previous: RelaySnapshot,
  next: RelaySnapshot,
  options: { readonly nodeResources?: boolean } = {}
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
    options.nodeResources
      ? previous.node
      : relayNodeControlState(previous.node),
    options.nodeResources ? next.node : relayNodeControlState(next.node)
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
  // Node resource samples arrive every few seconds; keep the instances array.
  if (delta.instances.length === 0 && delta.deletedInstanceIds.length === 0) {
    return {
      ...snapshot,
      node: delta.node ?? snapshot.node,
      relay: delta.relay ?? snapshot.relay,
    }
  }
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

/**
 * Drops a node that only carries new resource samples, so a delta received
 * with `relaySnapshotNodeResourcesFeature` wakes browsers exactly as often as
 * a control-only delta. Returns null when nothing control-relevant changed.
 */
export function relaySnapshotControlDelta(
  previous: RelaySnapshot,
  delta: RelaySnapshotDelta
): RelaySnapshotDelta | null {
  if (
    !delta.node ||
    !jsonValueEqual(
      relayNodeControlState(previous.node),
      relayNodeControlState(delta.node)
    )
  ) {
    return delta
  }
  const { node: _node, ...control } = delta
  return control.instances.length === 0 &&
    control.deletedInstanceIds.length === 0 &&
    !control.relay
    ? null
    : control
}

function relayInstanceControlState(instance: RelayInstance) {
  const { resources: _resources, ...control } = instance
  return control
}

function relayNodeControlState(node: RelayNode) {
  const {
    cpu: _cpu,
    memory: _memory,
    relayMemory: _relayMemory,
    relayResources: _relayResources,
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
export type RelayFilePutInput = z.infer<typeof relayFilePutInputSchema>
export type RelayFilePutResult = z.infer<typeof relayFilePutResultSchema>
export type RelayIconReadInput = z.infer<typeof relayIconReadInputSchema>
export type RelayIconReadResult = z.infer<typeof relayIconReadResultSchema>
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
export type RelayResourceUsage = z.infer<typeof relayResourceUsageSchema>
export type RelayWorkloadResourceKind = z.infer<
  typeof relayWorkloadResourceKindSchema
>
export type RelayWorkloadUsage = z.infer<typeof relayWorkloadUsageSchema>
export type RelayWorkloadUsageHistory = z.infer<
  typeof relayWorkloadUsageHistorySchema
>
export type RelayWorkloadUsageEvent = z.infer<
  typeof relayWorkloadUsageEventSchema
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
