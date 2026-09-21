import { z } from "zod"

export const permissionScopeTypes = ["relay", "instance", "database"] as const
export const permissionScopeTypeSchema = z.enum(permissionScopeTypes)
export type PermissionScopeType = (typeof permissionScopeTypes)[number]

export const permissionSelectionSchema = z
  .object({
    kind: z.enum(["permission", "collection"]),
    key: z.string().min(1).max(128),
  })
  .strict()
export const permissionSelectionsSchema = z
  .array(permissionSelectionSchema)
  .max(256)
export type PermissionSelection = z.infer<typeof permissionSelectionSchema>

export const legacyAccessPermissions = [
  "relay.read",
  "relay.configure",
  "relay.delete",
  "access.invite",
  "access.manage",
  "instance.read",
  "instance.console.read",
  "instance.console.write",
  "instance.files.read",
  "instance.files.write",
  "instance.delete",
  "instance.power",
  "instance.settings",
  "instance.logs.share",
  "instance.network.read",
  "instance.network.write",
  "instance.network.public-port.write",
  "instance.sftp.connect",
  "database.read",
  "database.create",
  "database.credentials.read",
  "database.credentials.rotate",
  "database.power",
  "database.delete",
  "database.network.read",
  "database.network.write",
  "database.dump.export",
  "database.dump.import",
  "backup.read",
  "backup.create",
  "backup.download",
  "backup.restore",
  "backup.delete",
  "schedule.read",
  "schedule.create",
  "schedule.execute",
  "schedule.update",
  "schedule.delete",
] as const

export const accessPermissions = [
  ...legacyAccessPermissions,
  "access.read",
  "preset.read",
  "preset.create",
  "preset.manage",
  "instance.create",
  "instance.configuration.read",
  "instance.configuration.write",
  "instance.limits.write",
  "instance.power.start",
  "instance.power.stop",
  "instance.power.restart",
  "instance.power.kill",
  "instance.files.delete",
  "instance.files.chmod",
  "instance.logs.read",
  "relay.update",
  "relay.pause",
  "relay.connections.read",
  "relay.connections.manage",
  "relay.audit.read",
] as const
export type AccessPermission = (typeof accessPermissions)[number]
Object.freeze(accessPermissions)
Object.freeze(legacyAccessPermissions)

/**
 * relay/instance/database permissions belong to one resource kind and carry
 * that kind's base visibility. shared permissions (access, presets, backups,
 * schedules) apply wherever they are assigned and carry the target's visibility.
 */
export type PermissionFamily = "relay" | "instance" | "database" | "shared"

export interface PermissionDefinition {
  readonly key: AccessPermission
  readonly label: string
  readonly description: string
  readonly block: string
  readonly family: PermissionFamily
  readonly scopeTypes: readonly PermissionScopeType[]
  readonly implies: readonly AccessPermission[]
  readonly supportedCapabilities: readonly string[]
  readonly compatibilityOnly: boolean
}
export interface PermissionCollection {
  readonly key: string
  readonly label: string
  readonly scopeTypes: readonly PermissionScopeType[]
  readonly selections: readonly PermissionSelection[]
  /** Members expand for this resource kind even when selected at Relay scope. */
  readonly childScope?: PermissionScopeType
}
export interface PermissionPreset extends PermissionCollection {
  readonly description: string
}

const allScopes = Object.freeze([...permissionScopeTypes])
const instanceScopes = Object.freeze(["relay", "instance"] as const)
const databaseScopes = Object.freeze(["relay", "database"] as const)
const relayScopes = Object.freeze(["relay"] as const)

const implicationEdges: Partial<
  Record<AccessPermission, readonly AccessPermission[]>
> = {
  "access.invite": ["access.read", "preset.create"],
  "access.manage": ["access.invite"],
  "preset.create": ["preset.read"],
  "preset.manage": ["preset.create"],
  "instance.console.write": ["instance.console.read"],
  "instance.files.write": ["instance.files.read"],
  "instance.files.delete": ["instance.files.read"],
  "instance.files.chmod": ["instance.files.read"],
  "instance.sftp.connect": ["instance.files.read"],
  "instance.power": ["instance.power.kill"],
  "instance.power.stop": ["instance.power.start"],
  "instance.power.restart": ["instance.power.stop"],
  "instance.power.kill": ["instance.power.restart"],
  "instance.settings": [
    "instance.configuration.write",
    "instance.limits.write",
  ],
  "instance.configuration.write": ["instance.configuration.read"],
  "instance.limits.write": ["instance.configuration.read"],
  "instance.logs.share": ["instance.logs.read"],
  "instance.network.write": ["instance.network.read"],
  "instance.network.public-port.write": ["instance.network.write"],
  "database.credentials.rotate": ["database.credentials.read"],
  "database.network.write": ["database.network.read"],
  "backup.create": ["backup.read"],
  "backup.download": ["backup.read"],
  "backup.restore": ["backup.read"],
  "backup.delete": ["backup.read"],
  "schedule.create": ["schedule.read"],
  "schedule.update": ["schedule.read"],
  "schedule.execute": ["schedule.read"],
  "schedule.delete": ["schedule.read"],
  "relay.connections.manage": ["relay.connections.read"],
}

/** Explicit editor block and family for every permission; no naming heuristics. */
const permissionPlacement: Record<
  AccessPermission,
  readonly [block: string, family: PermissionFamily]
> = {
  "relay.read": ["overview", "relay"],
  "relay.configure": ["relay.configuration", "relay"],
  "relay.update": ["relay.configuration", "relay"],
  "relay.pause": ["relay.configuration", "relay"],
  "relay.delete": ["resource.deletion", "relay"],
  "relay.connections.read": ["relay.connections", "relay"],
  "relay.connections.manage": ["relay.connections", "relay"],
  "relay.audit.read": ["relay.activity", "relay"],
  "instance.create": ["resource.creation", "relay"],
  "database.create": ["resource.creation", "relay"],
  "access.read": ["access", "shared"],
  "access.invite": ["access", "shared"],
  "access.manage": ["access", "shared"],
  "preset.read": ["preset", "shared"],
  "preset.create": ["preset", "shared"],
  "preset.manage": ["preset", "shared"],
  "backup.read": ["backup", "shared"],
  "backup.create": ["backup", "shared"],
  "backup.download": ["backup", "shared"],
  "backup.restore": ["backup", "shared"],
  "backup.delete": ["backup", "shared"],
  "schedule.read": ["schedule", "shared"],
  "schedule.create": ["schedule", "shared"],
  "schedule.execute": ["schedule", "shared"],
  "schedule.update": ["schedule", "shared"],
  "schedule.delete": ["schedule", "shared"],
  "instance.read": ["overview", "instance"],
  "instance.console.read": ["instance.console", "instance"],
  "instance.console.write": ["instance.console", "instance"],
  "instance.files.read": ["instance.files", "instance"],
  "instance.files.write": ["instance.files", "instance"],
  "instance.files.delete": ["instance.files", "instance"],
  "instance.files.chmod": ["instance.files", "instance"],
  "instance.sftp.connect": ["instance.files", "instance"],
  "instance.delete": ["resource.deletion", "instance"],
  "instance.power": ["instance.power", "instance"],
  "instance.power.start": ["instance.power", "instance"],
  "instance.power.stop": ["instance.power", "instance"],
  "instance.power.restart": ["instance.power", "instance"],
  "instance.power.kill": ["instance.power", "instance"],
  "instance.settings": ["instance.configuration", "instance"],
  "instance.configuration.read": ["instance.configuration", "instance"],
  "instance.configuration.write": ["instance.configuration", "instance"],
  "instance.limits.write": ["instance.configuration", "instance"],
  "instance.logs.read": ["instance.logs", "instance"],
  "instance.logs.share": ["instance.logs", "instance"],
  "instance.network.read": ["instance.network", "instance"],
  "instance.network.write": ["instance.network", "instance"],
  "instance.network.public-port.write": ["instance.network", "instance"],
  "database.read": ["overview", "database"],
  "database.credentials.read": ["database.credentials", "database"],
  "database.credentials.rotate": ["database.credentials", "database"],
  "database.power": ["database.power", "database"],
  "database.delete": ["resource.deletion", "database"],
  "database.network.read": ["database.network", "database"],
  "database.network.write": ["database.network", "database"],
  "database.dump.export": ["database.dump", "database"],
  "database.dump.import": ["database.dump", "database"],
}

const familyScopes: Record<PermissionFamily, readonly PermissionScopeType[]> = {
  relay: relayScopes,
  instance: instanceScopes,
  database: databaseScopes,
  shared: allScopes,
}

/** Base visibility a family always carries; shared permissions take the target's. */
const familyVisibility: Record<PermissionFamily, AccessPermission | null> = {
  relay: "relay.read",
  instance: "instance.read",
  database: "database.read",
  shared: null,
}

/**
 * Shared blocks assigned at Relay scope that operate on child resources also
 * reveal those children. Managing people or presets on a Relay does not.
 */
const relayScopeChildVisibility: Record<string, readonly AccessPermission[]> = {
  backup: ["instance.read", "database.read"],
  schedule: ["instance.read", "database.read"],
}

/** Legacy umbrella permissions kept only so migrated selections stay valid. */
const compatibilityOnlyPermissions: ReadonlySet<AccessPermission> = new Set([
  "instance.power",
  "instance.settings",
])

const permissionCopy: Record<
  AccessPermission,
  Pick<PermissionDefinition, "label" | "description">
> = {
  "relay.read": {
    label: "View Relay",
    description: "See Relay status and basic details.",
  },
  "relay.configure": {
    label: "Configure Relay",
    description: "Change Relay settings and connection details.",
  },
  "relay.delete": {
    label: "Remove Relay",
    description: "Remove the Relay from Hearth.",
  },
  "access.read": {
    label: "View users",
    description: "See who has access and their assigned permissions.",
  },
  "access.invite": {
    label: "Invite users",
    description: "Invite people to use this resource.",
  },
  "access.manage": {
    label: "Manage access",
    description: "Change permissions and revoke user access.",
  },
  "preset.read": {
    label: "View presets",
    description: "See saved permission presets.",
  },
  "preset.create": {
    label: "Create or copy presets",
    description: "Save reusable permission choices for this resource.",
  },
  "preset.manage": {
    label: "Manage presets",
    description: "Edit or delete presets. Changes apply to linked assignments.",
  },
  "instance.read": {
    label: "View server",
    description: "See server status and basic details.",
  },
  "instance.create": {
    label: "Create servers",
    description: "Provision new servers on this Relay.",
  },
  "instance.console.read": {
    label: "View console",
    description: "Read live server console output.",
  },
  "instance.console.write": {
    label: "Send commands",
    description: "Run commands in the server console.",
  },
  "instance.files.read": {
    label: "View and download files",
    description: "Browse server files and download their contents.",
  },
  "instance.files.write": {
    label: "Edit files",
    description: "Create, upload, edit, copy, move, and rename server files.",
  },
  "instance.files.delete": {
    label: "Delete files",
    description: "Remove server files and folders.",
  },
  "instance.files.chmod": {
    label: "Change file permissions",
    description: "Change which users can read, write, or run server files.",
  },
  "instance.sftp.connect": {
    label: "Connect using SFTP",
    description:
      "Browse files with an SFTP client. File changes need the matching file permissions.",
  },
  "instance.delete": {
    label: "Delete server",
    description: "Permanently remove the server and its data.",
  },
  "instance.power": {
    label: "Control server power",
    description: "Start, stop, restart, or force stop the server.",
  },
  "instance.power.start": {
    label: "Start server",
    description: "Start a stopped server.",
  },
  "instance.power.stop": {
    label: "Stop server",
    description: "Shut down the server gracefully. Also allows starting it.",
  },
  "instance.power.restart": {
    label: "Restart server",
    description:
      "Stop and start the server. Also allows starting and stopping it separately.",
  },
  "instance.power.kill": {
    label: "Force stop server",
    description:
      "Stop the server immediately. Also allows starting, stopping, and restarting it.",
  },
  "instance.settings": {
    label: "Manage server settings",
    description: "Change startup configuration and resource limits.",
  },
  "instance.configuration.read": {
    label: "View configuration",
    description: "See the server’s startup settings and Brick configuration.",
  },
  "instance.configuration.write": {
    label: "Manage configuration",
    description:
      "Change startup settings, switch Bricks, and reinstall the server.",
  },
  "instance.limits.write": {
    label: "Manage resource limits",
    description: "Change the server’s memory and disk limits.",
  },
  "instance.logs.read": {
    label: "View saved logs",
    description: "Read the server’s saved log files.",
  },
  "instance.logs.share": {
    label: "Share logs",
    description: "Publish server logs through a shareable link.",
  },
  "instance.network.read": {
    label: "View server network",
    description: "See the server’s addresses, ports, and routes.",
  },
  "instance.network.write": {
    label: "Manage server network",
    description: "Change the server’s network settings and routes.",
  },
  "instance.network.public-port.write": {
    label: "Assign public ports",
    description:
      "Assign ports that make the server reachable outside its private network.",
  },
  "database.read": {
    label: "View database",
    description: "See database status and basic details.",
  },
  "database.create": {
    label: "Create databases",
    description: "Provision new databases on this Relay.",
  },
  "database.credentials.read": {
    label: "View database credentials",
    description: "Reveal the username and password used to connect.",
  },
  "database.credentials.rotate": {
    label: "Reset database password",
    description: "Generate a new password for database connections.",
  },
  "database.power": {
    label: "Control database power",
    description: "Start, stop, or restart the database.",
  },
  "database.delete": {
    label: "Delete database",
    description: "Permanently remove the database and its data.",
  },
  "database.network.read": {
    label: "View database network",
    description: "See which servers can connect to the database.",
  },
  "database.network.write": {
    label: "Manage database network",
    description:
      "Connect or disconnect servers. Also requires network access for each server.",
  },
  "database.dump.export": {
    label: "Export database data",
    description: "Download a database dump for migration or safekeeping.",
  },
  "database.dump.import": {
    label: "Import database data",
    description: "Load a database dump into the database.",
  },
  "backup.read": {
    label: "View backups",
    description: "See available backups and their status.",
  },
  "backup.create": {
    label: "Create backups",
    description: "Save a new backup of this resource.",
  },
  "backup.download": {
    label: "Download backups",
    description: "Download backup files.",
  },
  "backup.restore": {
    label: "Restore backups",
    description: "Replace current data with a saved backup.",
  },
  "backup.delete": {
    label: "Delete backups",
    description: "Remove saved backups.",
  },
  "schedule.read": {
    label: "View schedules",
    description: "See scheduled tasks and their run history.",
  },
  "schedule.create": {
    label: "Create schedules",
    description: "Set up tasks to run automatically.",
  },
  "schedule.execute": {
    label: "Run schedules",
    description: "Start a scheduled task immediately.",
  },
  "schedule.update": {
    label: "Edit schedules",
    description: "Change scheduled tasks and when they run.",
  },
  "schedule.delete": {
    label: "Delete schedules",
    description: "Remove scheduled tasks.",
  },
  "relay.update": {
    label: "Update Relay",
    description: "Install a newer version of the Relay software.",
  },
  "relay.pause": {
    label: "Pause or resume Relay",
    description: "Disable or re-enable Hearth’s connection to this Relay.",
  },
  "relay.connections.read": {
    label: "View Relay connections",
    description: "See paired clients and pending pairing invitations.",
  },
  "relay.connections.manage": {
    label: "Manage Relay connections",
    description: "Pair clients, change their access, and revoke connections.",
  },
  "relay.audit.read": {
    label: "View Relay activity",
    description: "Read the Relay’s activity history.",
  },
}

/** Stable IDs are an allowlist, never wildcard patterns. */
export const permissionCatalog: readonly PermissionDefinition[] = Object.freeze(
  accessPermissions.map((key) => {
    const [block, family] = permissionPlacement[key]
    const implies = [...(implicationEdges[key] ?? [])]
    const visibility = familyVisibility[family]
    if (visibility && visibility !== key) implies.push(visibility)
    return Object.freeze({
      key,
      ...permissionCopy[key],
      block,
      family,
      scopeTypes: familyScopes[family],
      implies: Object.freeze([...new Set(implies)]),
      supportedCapabilities: Object.freeze(
        block === "database.dump" ? ["database.logical-backups"] : []
      ),
      compatibilityOnly: compatibilityOnlyPermissions.has(key),
    })
  })
)

const definitions = new Map(
  permissionCatalog.map((entry) => [entry.key, entry])
)
export function accessPermissionSupported(
  permission: string,
  scopeType: PermissionScopeType,
  capabilities?: readonly string[]
): permission is AccessPermission {
  const definition = definitions.get(permission as AccessPermission)
  return (
    !!definition &&
    definition.scopeTypes.includes(scopeType) &&
    (capabilities === undefined ||
      definition.supportedCapabilities.every((capability) =>
        capabilities.includes(capability)
      ))
  )
}

const blockLabels: Record<string, string> = {
  overview: "Overview",
  "instance.power": "Server power",
  "instance.console": "Console",
  "instance.files": "Files",
  "instance.logs": "Logs",
  "instance.configuration": "Configuration",
  "instance.network": "Networking",
  access: "People and access",
  preset: "Presets",
  backup: "Backups",
  schedule: "Schedules",
  "database.power": "Database power",
  "database.credentials": "Database credentials",
  "database.network": "Database networking",
  "database.dump": "Database data",
  "resource.deletion": "Resource deletion",
  "resource.creation": "Resource creation",
  "relay.configuration": "Relay configuration",
  "relay.connections": "Relay connections",
  "relay.activity": "Relay activity",
}
export const permissionBlocks = Object.freeze(
  [...new Set(permissionCatalog.map((entry) => entry.block))].map((key) =>
    Object.freeze({
      key,
      label: blockLabels[key] ?? key,
      permissions: Object.freeze(
        permissionCatalog
          .filter((entry) => entry.block === key && !entry.compatibilityOnly)
          .map((entry) => entry.key)
      ),
    })
  )
)

function selection(
  kind: PermissionSelection["kind"],
  key: string
): PermissionSelection {
  return Object.freeze({ kind, key })
}

export const permissionCollections: readonly PermissionCollection[] =
  Object.freeze([
    ...permissionBlocks.map((block) =>
      Object.freeze({
        key: `${block.key}.all`,
        label: `All ${block.label.toLowerCase()}`,
        scopeTypes: Object.freeze(
          permissionScopeTypes.filter((scope) =>
            block.permissions.some((key) =>
              accessPermissionSupported(key, scope)
            )
          )
        ),
        selections: Object.freeze(
          block.permissions.map((key) => selection("permission", key))
        ),
      })
    ),
    ...permissionScopeTypes.map((scope) =>
      Object.freeze({
        key: `${scope}.all`,
        label: `All ${scope} permissions`,
        scopeTypes: familyScopes[scope],
        ...(scope === "relay" ? {} : { childScope: scope }),
        selections: Object.freeze(
          permissionBlocks
            .filter((block) =>
              block.permissions.some((key) =>
                accessPermissionSupported(key, scope)
              )
            )
            .map((block) => selection("collection", `${block.key}.all`))
        ),
      })
    ),
    Object.freeze({
      key: "all",
      label: "All permissions",
      scopeTypes: allScopes,
      selections: Object.freeze(
        permissionBlocks.map((block) =>
          selection("collection", `${block.key}.all`)
        )
      ),
    }),
  ])
const collections = new Map(
  permissionCollections.map((entry) => [entry.key, entry])
)

/** Fails closed on stale IDs and malformed/cyclic catalog definitions. */
export function validatePermissionCatalog(
  catalog: readonly PermissionDefinition[] = permissionCatalog,
  groups: readonly PermissionCollection[] = permissionCollections
): void {
  const nodes = new Map<string, string[]>()
  for (const entry of catalog) {
    const key = `permission:${entry.key}`
    if (nodes.has(key)) throw new Error(`Duplicate permission: ${entry.key}`)
    nodes.set(
      key,
      entry.implies.map((id) => `permission:${id}`)
    )
  }
  for (const entry of groups) {
    const key = `collection:${entry.key}`
    if (nodes.has(key)) throw new Error(`Duplicate collection: ${entry.key}`)
    nodes.set(
      key,
      entry.selections.map((child) => `${child.kind}:${child.key}`)
    )
  }
  const complete = new Set<string>()
  const visiting = new Set<string>()
  function visit(key: string): void {
    if (complete.has(key)) return
    if (visiting.has(key)) throw new Error(`Permission catalog cycle: ${key}`)
    const children = nodes.get(key)
    if (!children)
      throw new Error(`Unknown permission catalog reference: ${key}`)
    visiting.add(key)
    for (const child of children) visit(child)
    visiting.delete(key)
    complete.add(key)
  }
  for (const key of nodes.keys()) visit(key)
}
validatePermissionCatalog()

const closures = new Map<AccessPermission, readonly AccessPermission[]>()
function implicationClosure(
  key: AccessPermission
): readonly AccessPermission[] {
  const cached = closures.get(key)
  if (cached) return cached
  const result = Object.freeze([
    ...new Set([
      key,
      ...definitions.get(key)!.implies.flatMap(implicationClosure),
    ]),
  ])
  closures.set(key, result)
  return result
}
for (const key of accessPermissions) implicationClosure(key)

/** Collections retain future opt-in in storage; this produces only today's effective IDs. */
export function expandPermissionSelections(
  selections: readonly PermissionSelection[],
  scopeType: PermissionScopeType,
  capabilities?: readonly string[]
): AccessPermission[] {
  const scope = permissionScopeTypeSchema.parse(scopeType)
  const parsed = permissionSelectionsSchema.parse(selections)
  const result = new Set<AccessPermission>()
  function expand(
    item: PermissionSelection,
    selectedScope: PermissionScopeType,
    nested: boolean
  ): void {
    if (item.kind === "permission") {
      if (!definitions.has(item.key as AccessPermission))
        throw new Error(`Unknown permission: ${item.key}`)
      if (!accessPermissionSupported(item.key, selectedScope, capabilities)) {
        if (nested) return
        throw new Error(
          `Permission ${item.key} is unsupported for ${selectedScope}`
        )
      }
      for (const permission of implicationClosure(item.key))
        result.add(permission)
      const definition = definitions.get(item.key as AccessPermission)!
      // Shared permissions reveal the target they are assigned to, never secrets.
      if (definition.family === "shared") {
        result.add(`${selectedScope}.read`)
        if (selectedScope === "relay")
          for (const child of relayScopeChildVisibility[definition.block] ?? [])
            result.add(child)
      }
      return
    }
    const group = collections.get(item.key)
    if (!group) throw new Error(`Unknown permission collection: ${item.key}`)
    if (!group.scopeTypes.includes(selectedScope)) {
      if (nested) return
      throw new Error(
        `Collection ${item.key} is unsupported for ${selectedScope}`
      )
    }
    const groupScope = group.childScope ?? selectedScope
    for (const child of group.selections) expand(child, groupScope, true)
  }
  for (const item of parsed) expand(item, scope, false)
  // Any Relay-scope assignment reveals the Relay it was granted on.
  if (scope === "relay" && result.size > 0) result.add("relay.read")
  return accessPermissions.filter((key) => result.has(key))
}

export const builtinPermissionPresets: readonly PermissionPreset[] =
  Object.freeze([
    Object.freeze({
      key: "kiln.observer",
      label: "Observer",
      description:
        "Inspect status, console, configuration, networks, backups, and schedules. Does not include downloading files, backups, or credentials.",
      scopeTypes: allScopes,
      selections: Object.freeze(
        [
          "overview.all",
          "instance.console.read",
          "instance.configuration.read",
          "instance.network.read",
          "database.network.read",
          "backup.read",
          "schedule.read",
        ].map((key) =>
          selection(key.endsWith(".all") ? "collection" : "permission", key)
        )
      ),
    }),
    Object.freeze({
      key: "kiln.operator",
      label: "Operator",
      description:
        "Operate servers, files, networks, backups, and schedules without managing people or deleting resources.",
      scopeTypes: allScopes,
      selections: Object.freeze(
        [
          "overview.all",
          "instance.power.restart",
          "instance.console.all",
          "instance.files.all",
          "instance.logs.all",
          "instance.network.write",
          "database.power",
          "database.network.write",
          "backup.all",
          "schedule.all",
        ].map((key) =>
          selection(key.endsWith(".all") ? "collection" : "permission", key)
        )
      ),
    }),
    Object.freeze({
      key: "kiln.administrator",
      label: "Administrator",
      description:
        "All current and future permissions in this scope. Does not transfer ownership or grant platform authority.",
      scopeTypes: allScopes,
      selections: Object.freeze([selection("collection", "all")]),
    }),
  ])

/** Defaults compose across resource kinds; omitted unsupported options are explicit at this boundary. */
export function builtinPresetSelections(
  key: string,
  scopeType: PermissionScopeType
): PermissionSelection[] {
  const preset = builtinPermissionPresets.find((entry) => entry.key === key)
  if (!preset) throw new Error(`Unknown built-in preset: ${key}`)
  permissionScopeTypeSchema.parse(scopeType)
  return preset.selections
    .filter((entry) =>
      entry.kind === "permission"
        ? accessPermissionSupported(entry.key, scopeType)
        : collections.get(entry.key)?.scopeTypes.includes(scopeType)
    )
    .map((entry) => ({ ...entry }))
}

/** Relay actions a read-only machine client may perform; Relay enforces the same list. */
export const relayReadOnlyMachineActions = [
  "relay.read",
  "relay.audit.read",
  "relay.pairing.list",
  "relay.clients.list",
  "brick.read",
  "database.read",
  "database.dump.export",
  "backup.read",
  "backup.download",
  "schedule.read",
  "instance.read",
  "instance.console.read",
  "instance.sftp.connect",
  "instance.files.list",
  "instance.files.read",
  "instance.files.download",
  "instance.network.read",
  "instance.logs.read",
] as const

/** Human authority required to delegate a Relay machine client's unrestricted resource scope. */
export function permissionsForRelayClientPolicy(
  role: "custom" | "full_access" | "read_only",
  actions: readonly string[] = []
): AccessPermission[] {
  const required = new Set<AccessPermission>()
  const requireAll = () => {
    for (const permission of accessPermissions) required.add(permission)
  }
  if (role === "full_access") requireAll()
  else
    for (const action of role === "read_only"
      ? relayReadOnlyMachineActions
      : actions) {
      let permissions: readonly string[]
      switch (action) {
        case "relay.pairing.create":
        case "relay.clients.update":
          requireAll()
          continue
        case "relay.pairing.list":
        case "relay.clients.list":
          permissions = ["relay.connections.read"]
          break
        case "relay.pairing.revoke":
        case "relay.clients.revoke":
          permissions = ["relay.connections.manage"]
          break
        case "relay.rename":
          permissions = ["relay.configure"]
          break
        case "relay.read":
          permissions = ["relay.read", "instance.configuration.read"]
          break
        case "brick.read":
          permissions = ["instance.create"]
          break
        case "instance.create":
          permissions = [
            ...expandPermissionSelections(
              [{ kind: "collection", key: "instance.all" }],
              "relay"
            ),
            "instance.create",
          ]
          break
        case "instance.rename":
          permissions = ["instance.configuration.write"]
          break
        case "instance.files.list":
        case "instance.files.download":
          permissions = ["instance.files.read"]
          break
        case "instance.files.create":
        case "instance.files.rename":
        case "instance.files.upload":
        case "instance.files.upload-url":
          permissions = ["instance.files.write"]
          break
        case "schedule.write":
          permissions = [
            "schedule.create",
            "schedule.update",
            "schedule.execute",
            "schedule.delete",
          ]
          break
        default:
          permissions = [action]
      }
      for (const permission of permissions) {
        if (!accessPermissionSupported(permission, "relay"))
          throw new Error(`Unknown machine permission: ${permission}`)
        for (const implied of expandPermissionSelections(
          [{ kind: "permission", key: permission }],
          "relay"
        ))
          required.add(implied)
      }
    }
  return [...required]
}
