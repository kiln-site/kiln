import { Result } from "effect"
import {
  expandPermissionSelections,
  permissionBlocks,
  permissionCatalog,
  permissionCollections,
  type AccessPermission,
  type PermissionDefinition,
  type PermissionScopeType,
  type PermissionSelection,
} from "@workspace/contracts"

/**
 * Text names for permission selections, as typed in the permission editor:
 * `instance.files.write`, `instance.files.*` for a block, `*` for everything.
 * They only exist in the browser; storage keeps the catalog's selection keys.
 */
export function permissionNode(selection: PermissionSelection): string {
  if (selection.kind === "permission") return selection.key
  return selection.key === "all" ? "*" : selection.key.replace(/\.all$/u, ".*")
}

export interface PermissionNodeOption {
  selection: PermissionSelection
  node: string
  label: string
  description: string
  /** Heading the option is listed under. */
  group: string
  /** Catalog scopes the option can be granted on. */
  scopeTypes: ReadonlyArray<PermissionScopeType>
}

const scopeCollectionCopy: Record<
  string,
  [label: string, description: string]
> = {
  all: [
    "All permissions",
    "Every permission for this resource, including ones Kiln adds later.",
  ],
  "relay.all": [
    "All Relay permissions",
    "Every Relay permission, including host access and ones Kiln adds later.",
  ],
  "instance.all": [
    "All game server permissions",
    "Every game server permission, including ones Kiln adds later.",
  ],
  "database.all": [
    "All database permissions",
    "Every database permission, including ones Kiln adds later.",
  ],
}

const blockLabels = new Map(
  permissionBlocks.map((block) => [block.key, block.label])
)
const definitions = new Map<string, PermissionDefinition>(
  permissionCatalog.map((entry) => [entry.key, entry])
)

export const permissionNodeOptions: ReadonlyArray<PermissionNodeOption> = [
  ...permissionCollections.map((collection) => {
    const block = collection.key.replace(/\.all$/u, "")
    const [label, description] = scopeCollectionCopy[collection.key] ?? [
      `All ${(blockLabels.get(block) ?? block).toLowerCase()}`,
      `Every ${(blockLabels.get(block) ?? block).toLowerCase()} permission, including ones Kiln adds later.`,
    ]
    const selection: PermissionSelection = {
      kind: "collection",
      key: collection.key,
    }
    return {
      selection,
      node: permissionNode(selection),
      label,
      description,
      group: "Groups",
      scopeTypes: collection.scopeTypes,
    }
  }),
  ...permissionCatalog
    .filter((entry) => !entry.compatibilityOnly)
    .map((entry) => {
      const selection: PermissionSelection = {
        kind: "permission",
        key: entry.key,
      }
      return {
        selection,
        node: entry.key,
        label: entry.label,
        description: entry.description,
        group: blockLabels.get(entry.block) ?? entry.block,
        scopeTypes: entry.scopeTypes,
      }
    }),
].sort(compareNodes)

const optionsByKey = new Map(
  permissionNodeOptions.map((option) => [
    selectionKey(option.selection),
    option,
  ])
)

export function selectionKey(selection: PermissionSelection) {
  return `${selection.kind}:${selection.key}`
}

/** Catalog copy for a selection; stale keys get a bare entry so they can be removed. */
export function permissionNodeOption(
  selection: PermissionSelection
): PermissionNodeOption {
  return (
    optionsByKey.get(selectionKey(selection)) ?? {
      selection,
      node: permissionNode(selection),
      label: definitions.get(selection.key)?.label ?? "Unknown permission",
      description:
        definitions.get(selection.key)?.description ??
        "Kiln no longer recognizes this permission.",
      group: "Other",
      scopeTypes: [],
    }
  )
}

/** Wildcards sort before what they cover, then alphabetically by node. */
export function compareNodes(
  a: Pick<PermissionNodeOption, "node">,
  b: Pick<PermissionNodeOption, "node">
) {
  return a.node < b.node ? -1 : a.node > b.node ? 1 : 0
}

/** Ranks options for a typed query: node prefix, then node, then copy. */
export function searchPermissionNodes(
  query: string,
  options: ReadonlyArray<PermissionNodeOption> = permissionNodeOptions
): Array<PermissionNodeOption> {
  const text = query.trim().toLowerCase()
  if (!text) return [...options]
  const ranked: Array<[number, PermissionNodeOption]> = []
  for (const option of options) {
    const node = option.node.toLowerCase()
    const rank =
      node === text
        ? 0
        : node.startsWith(text)
          ? 1
          : node.includes(text)
            ? 2
            : option.label.toLowerCase().includes(text)
              ? 3
              : option.description.toLowerCase().includes(text) ||
                  option.group.toLowerCase().includes(text)
                ? 4
                : -1
    if (rank >= 0) ranked.push([rank, option])
  }
  return ranked
    .sort((a, b) => a[0] - b[0] || compareNodes(a[1], b[1]))
    .map(([, option]) => option)
}

/** Effective permissions, or null when the selections don't apply to the scope. */
export function tryExpandSelections(
  selections: ReadonlyArray<PermissionSelection>,
  scopeType: PermissionScopeType,
  capabilities?: ReadonlyArray<string>
): Array<AccessPermission> | null {
  const result = Result.try(() =>
    expandPermissionSelections(selections, scopeType, capabilities)
  )
  return Result.isSuccess(result) ? result.success : null
}

/** Permissions whose grant includes `key`, excluding itself. */
export function permissionsIncluding(
  key: AccessPermission,
  scopeType: PermissionScopeType,
  capabilities?: ReadonlyArray<string>
): Array<PermissionDefinition> {
  return permissionCatalog.filter(
    (entry) =>
      entry.key !== key &&
      !entry.compatibilityOnly &&
      tryExpandSelections(
        [{ kind: "permission", key: entry.key }],
        scopeType,
        capabilities
      )?.includes(key)
  )
}

export function permissionDefinition(key: string) {
  return definitions.get(key)
}

/** Grants that reach the Relay's host node, beyond Kiln's own resources. */
const hostLevelPermissions: ReadonlySet<string> = new Set([
  "relay.terminal",
  "relay.files.read",
  "relay.files.write",
  "relay.files.mount",
  "relay.database.read",
  "app.manage",
  "app.terminal",
])
export function isHostLevel(permission: string) {
  return hostLevelPermissions.has(permission)
}
export function isDestructive(permission: string) {
  return (
    permission.endsWith(".delete") ||
    permission === "backup.restore" ||
    permission === "database.dump.import"
  )
}
