import type { AccessPermission } from "@workspace/contracts"

import { runAppEffect } from "@/effect/runtime"
import {
  loadSecurityFindingsEffect,
  loadSecurityTargetsEffect,
  requestSecurityScanEffect,
  resourceSecuritySummary,
  securityResourceNamesEffect,
} from "@/effect/security"
import { isPlatformAdmin, listUserGrants } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { listPersistedRelaysEffect } from "@/lib/relay-registry"
import { effectiveScopePermissions } from "@/lib/resource-permissions"
import {
  scanRelaySoon,
  securityNotifyPermissions,
} from "@/lib/security-scans.server"
import {
  parseSecurityScope,
  securityScopeKey,
  type ResourceSecuritySummary,
  type SecurityResource,
  type SecurityOverview,
  type SecurityTarget,
} from "@/lib/security"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { requireEligibleResourceUser } from "@/server/auth"

// Who sees what Kiln found in a resource: anyone who can see the resource.
// The Relay's host and Kiln's own services are the Relay's.
const viewPermissions = {
  app: "app.read",
  database: "database.read",
  instance: "instance.read",
  relay: "relay.read",
} as const satisfies Record<SecurityTarget["resourceType"], AccessPermission>

// What the user may see and scan, from one read of their grants.
async function securityAccess(user: AuthenticatedUser) {
  const admin = isPlatformAdmin(user)
  const grants = admin ? [] : await listUserGrants(user.id)
  const relayIds = admin
    ? (await runAppEffect("security.relays", listPersistedRelaysEffect())).map(
        (relay) => relay.id
      )
    : [...new Set(grants.map((grant) => grant.relayId))]
  const holds = (
    target: Pick<SecurityTarget, "relayId" | "resourceId" | "resourceType">,
    permission: AccessPermission
  ) =>
    admin ||
    effectiveScopePermissions(grants, {
      relayId: target.relayId,
      resourceId: target.resourceId,
      resourceType: target.resourceType,
    }).has(permission)
  return {
    relayIds,
    canScan: (target: Parameters<typeof holds>[0]) =>
      holds(target, securityNotifyPermissions[target.resourceType]),
    canView: (target: Parameters<typeof holds>[0]) =>
      holds(target, viewPermissions[target.resourceType]),
  }
}

// The targets a scope covers: a Relay's covers everything on it, or with
// `own`, only its host and Kiln's services.
function inScope(
  target: SecurityTarget,
  scope: string | null,
  own = false
): boolean {
  if (scope === null) return true
  const parsed = parseSecurityScope(scope)
  if (!parsed || parsed.relayId !== target.relayId) return false
  return parsed.resourceType === "relay"
    ? !own || target.resourceType === "relay"
    : parsed.resourceType === target.resourceType &&
        parsed.resourceId === target.resourceId
}

async function visibleFindings(
  user: AuthenticatedUser,
  scope: string | null,
  options: { limit?: number; own?: boolean } = {}
) {
  const access = await securityAccess(user)
  const targets = (
    await runAppEffect(
      "security.loadTargets",
      loadSecurityTargetsEffect(access.relayIds)
    )
  ).filter(
    (target) =>
      access.canView(target) && inScope(target, scope, options.own ?? false)
  )
  const inventories = new Map<
    string,
    { relayId: string; sbomKey: string; targetKeys: Array<string> }
  >()
  for (const target of targets) {
    const key = `${target.relayId}/${target.sbomKey}`
    const inventory = inventories.get(key) ?? {
      relayId: target.relayId,
      sbomKey: target.sbomKey,
      targetKeys: [],
    }
    inventory.targetKeys.push(target.targetKey)
    inventories.set(key, inventory)
  }
  const { findings, summary } = await runAppEffect(
    "security.loadFindings",
    loadSecurityFindingsEffect([...inventories.values()], options.limit)
  )
  return { access, findings, summary, targets }
}

export async function getSecurityOverviewHandler(input: {
  scope: string | null
}): Promise<SecurityOverview> {
  const user = await requireEligibleResourceUser()
  const { access, findings, summary, targets } = await visibleFindings(
    user,
    input.scope
  )
  return {
    findings,
    resources: await securityResources(targets),
    summary,
    scannable: [
      ...new Set(targets.filter(access.canScan).map((target) => target.scope)),
    ],
    targets: targets.map(({ sbomKey: _sbomKey, ...target }) => target),
  }
}

// The resources the targets belong to, with their names, and their Relays,
// which the scope picker offers too.
async function securityResources(
  targets: ReadonlyArray<SecurityTarget>
): Promise<Array<SecurityResource>> {
  const relayIds = [...new Set(targets.map((target) => target.relayId))]
  const names = new Map(
    await Promise.all(
      relayIds.map(
        async (relayId) =>
          [
            relayId,
            await runAppEffect(
              "security.resourceNames",
              securityResourceNamesEffect(relayId)
            ),
          ] as const
      )
    )
  )
  const resources = new Map<string, SecurityResource>()
  for (const target of targets) {
    const relayNames = names.get(target.relayId)
    const relayName = relayNames?.get(`relay:${target.relayId}`) ?? "Relay"
    for (const resource of [
      { id: target.relayId, type: "relay" as const },
      { id: target.resourceId, type: target.resourceType },
    ]) {
      const scope = securityScopeKey(resource.type, target.relayId, resource.id)
      if (resources.has(scope)) continue
      resources.set(scope, {
        id: resource.id,
        kind: resource.type === "instance" ? "server" : resource.type,
        name:
          relayNames?.get(`${resource.type}:${resource.id}`) ??
          resource.id.slice(0, 8),
        relayId: target.relayId,
        relayName,
        scope,
      })
    }
  }
  return [...resources.values()]
}

export async function getResourceSecurityHandler(input: {
  scope: string
}): Promise<ResourceSecuritySummary | null> {
  const user = await requireEligibleResourceUser()
  if (!parseSecurityScope(input.scope)) return null
  // A Relay's page speaks for its host and Kiln's services, not everything
  // it runs.
  const { findings, summary, targets } = await visibleFindings(
    user,
    input.scope,
    { limit: 3, own: true }
  )
  return resourceSecuritySummary(targets, findings, summary)
}

/**
 * Checks the scope's inventories against the current vulnerability data
 * now, collecting the host's again for a Relay, or everything the user may
 * scan without a scope.
 */
export async function scanSecurityNowHandler(input: { scope: string | null }) {
  const user = await requireEligibleResourceUser()
  const access = await securityAccess(user)
  const parsed = input.scope === null ? null : parseSecurityScope(input.scope)
  if (input.scope !== null && !parsed) throw new Error("Unknown scope")
  const targets = await runAppEffect(
    "security.loadTargets",
    loadSecurityTargetsEffect(
      parsed
        ? [parsed.relayId].filter((id) => access.relayIds.includes(id))
        : access.relayIds
    )
  )
  const scopes = parsed
    ? [parsed]
    : [
        ...new Map(
          targets.filter(access.canScan).map((target) => [
            target.scope,
            {
              relayId: target.relayId,
              resourceId: target.resourceId,
              resourceType: target.resourceType,
            },
          ])
        ).values(),
      ]
  if (parsed && !access.canScan(parsed)) {
    throw new Error("You do not have permission to scan this")
  }
  const relays = new Set<string>()
  for (const scope of scopes) {
    await runAppEffect(
      "security.requestScan",
      requestSecurityScanEffect(
        scope.relayId,
        // A scan of everything rescans each Relay's host only for its admins.
        scope.resourceType === "relay"
          ? null
          : { id: scope.resourceId, type: scope.resourceType }
      )
    )
    relays.add(scope.relayId)
  }
  for (const relayId of relays) scanRelaySoon(relayId)
  if (relays.size) {
    publishRealtimeChange({
      audience: { kind: "relays", relayIds: [...relays] },
      topics: ["security"],
      type: "hearth.invalidate",
    })
  }
  return { scopes: scopes.length }
}
