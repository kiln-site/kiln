import type { AccessPermission } from "@workspace/contracts"

import { loadAppImageUpdatesEffect } from "@/effect/app-image-updates"
import { loadAppGitHubSourceEffect } from "@/effect/app-deployments"
import { listRelayAppConfigsEffect } from "@/effect/managed-apps"
import { listRegistryTagsEffect } from "@/effect/registry-tags"
import { runAppEffect } from "@/effect/runtime"
import {
  loadSecurityFindingsEffect,
  loadSecuritySummaryEffect,
  loadSecurityTargetsEffect,
  requestSecurityScanEffect,
  securityResourceNamesEffect,
} from "@/effect/security"
import { isPlatformAdmin, listUserGrants } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { listPersistedRelaysEffect } from "@/lib/relay-registry"
import {
  parseImageReference,
  suggestImageTags,
  type ImageTagSuggestion,
} from "@/lib/image-tags"
import { effectiveScopePermissions } from "@/lib/resource-permissions"
import {
  scanRelaySoon,
  securityNotifyPermissions,
} from "@/lib/security-scans.server"
import {
  groupSecurityFindings,
  parseSecurityScope,
  securityScopeKey,
  securityVerdict,
  type ResourceSecuritySummary,
  type SecurityFix,
  type SecurityItem,
  type SecurityPackage,
  type SecurityResource,
  type SecurityOverview,
  type SecurityTarget,
} from "@/lib/security"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { promiseEffect } from "@/effect/promise"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"
import { authorizedAppFor } from "@/server/app-access"
import { requireEligibleResourceUser } from "@/server/auth"

// Rows read for one inventory's rollup: past any real image or host, and a
// limit on one that isn't. Only so many of each package's are sent.
const FINDINGS_READ = 20_000
const FINDINGS_SHOWN_PER_PACKAGE = 40

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
    holds,
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

type LoadedTarget = Awaited<ReturnType<typeof runSecurityTargets>>[number]

function runSecurityTargets(relayIds: ReadonlyArray<string>) {
  return runAppEffect(
    "security.loadTargets",
    loadSecurityTargetsEffect(relayIds)
  )
}

// What the viewer may see in the scope. A scope is on one Relay, so only that
// one is read: this runs for every resource page.
async function visibleTargets(
  user: AuthenticatedUser,
  scope: string | null,
  own = false
) {
  const access = await securityAccess(user)
  const parsed = scope === null ? null : parseSecurityScope(scope)
  const relayIds = parsed
    ? access.relayIds.filter((id) => id === parsed.relayId)
    : access.relayIds
  const targets = (await runSecurityTargets(relayIds)).filter(
    (target) => access.canView(target) && inScope(target, scope, own)
  )
  return { access, targets }
}

const uniqueInventories = (targets: ReadonlyArray<LoadedTarget>) => [
  ...new Map(
    targets.map((target) => [
      `${target.relayId}/${target.sbomKey}`,
      { relayId: target.relayId, sbomKey: target.sbomKey },
    ])
  ).values(),
]

export async function getSecurityOverviewHandler(input: {
  own?: boolean
  scope: string | null
}): Promise<SecurityOverview> {
  const user = await requireEligibleResourceUser()
  const { access, targets } = await visibleTargets(
    user,
    input.scope,
    input.own ?? false
  )
  const [summary, resources, fixes] = await Promise.all([
    runAppEffect(
      "security.loadSummary",
      loadSecuritySummaryEffect(uniqueInventories(targets))
    ),
    securityResources(targets),
    securityFixes(access, targets),
  ])
  return {
    items: securityItems(targets, resources, fixes),
    resources,
    summary,
    scannable: [
      ...new Set(targets.filter(access.canScan).map((target) => target.scope)),
    ],
  }
}

// `docker.io/library/nginx@sha256:…` as anyone would write it.
function readableImage(image: string): string {
  const [name = image] = image.split("@")
  return name.replace(/^(?:docker\.io\/)?(?:library\/)?/u, "")
}

// One entry per image on each Relay, however many resources run it, and per
// host. Another Relay's copy of an image is its own entry: Hearth can't verify
// what a Relay says an image holds, so one can't speak for the other.
function securityItems(
  targets: ReadonlyArray<LoadedTarget>,
  resources: ReadonlyArray<SecurityResource>,
  fixes: ReadonlyMap<string, SecurityFix>
): Array<SecurityItem> {
  const named = new Map(resources.map((resource) => [resource.scope, resource]))
  const items = new Map<string, SecurityItem>()
  for (const target of targets) {
    const host = target.sbomKey === "host"
    const key = `${target.relayId}/${target.sbomKey}`
    const item = items.get(key) ?? {
      checkedAt: target.checkedAt,
      counts: target.counts,
      error: target.error,
      fixable: target.fixable,
      fixableCritical: target.fixableCritical,
      inventory: { relayId: target.relayId, sbomKey: target.sbomKey },
      key,
      kind: host ? ("host" as const) : ("image" as const),
      knownExploited: target.knownExploited,
      name: host
        ? (target.distro ?? "Host")
        : readableImage(target.image ?? target.sbomKey),
      packages: target.packages,
      status: target.status,
      uses: [],
      verdict: target.status === "checked" ? securityVerdict(target) : null,
    }
    const resource = named.get(target.scope)
    const fix = fixes.get(target.targetKey)
    if (fix) {
      // Docker names a deployed image by its digest; its app, as it was set.
      if ("image" in fix && fix.image) item.name = fix.image
      item.uses.push({
        component:
          target.component && target.component !== "app" && !host
            ? target.component
            : null,
        fix,
        name: resource?.name ?? target.resourceId.slice(0, 8),
        relayId: target.relayId,
        relayName: resource?.relayName ?? "Relay",
        resourceId: target.resourceId,
        resourceType: target.resourceType,
        running: target.running,
        scope: target.scope,
      })
    }
    items.set(key, item)
  }
  return [...items.values()]
}

// What fixes each target, from what Hearth knows of where it came from. Apps
// are read once per Relay, not per target.
async function securityFixes(
  access: Awaited<ReturnType<typeof securityAccess>>,
  targets: ReadonlyArray<LoadedTarget>
) {
  const appRelays = [
    ...new Set(
      targets
        .filter((target) => target.resourceType === "app")
        .map((target) => target.relayId)
    ),
  ]
  const apps = new Map(
    (
      await Promise.all(
        appRelays.map((relayId) =>
          runAppEffect(
            "security.fixes.apps",
            listRelayAppConfigsEffect(relayId)
          )
        )
      )
    )
      .flat()
      .map((app) => [app.appId, app])
  )
  const imageUpdates = await runAppEffect(
    "security.fixes.imageUpdates",
    loadAppImageUpdatesEffect(
      [...apps.values()]
        .filter((app) => app.config.sourceType === "image")
        .map((app) => app.appId)
    )
  )
  const githubApps = [...apps.values()].filter(
    (app) => app.config.sourceType === "github"
  )
  const sources = new Map(
    await Promise.all(
      githubApps.map(
        async (app) =>
          [
            app.appId,
            await runAppEffect(
              "security.fixes.github",
              loadAppGitHubSourceEffect(app.appId)
            ),
          ] as const
      )
    )
  )
  const fixFor = (target: LoadedTarget): SecurityFix => {
    switch (target.resourceType) {
      case "relay":
        return target.sbomKey === "host"
          ? {
              allowed: access.holds(target, "relay.terminal"),
              kind: "host-packages",
            }
          : { kind: "kiln-update" }
      case "database":
        return { kind: "database" }
      case "instance":
        return { kind: "game-server" }
      case "app": {
        const app = apps.get(target.resourceId)
        const allowed = access.holds(target, "app.manage")
        const { sourceType } = app?.config ?? {}
        if (sourceType === "image") {
          const update = imageUpdates.get(target.resourceId)
          const image = app?.config.image ?? target.image ?? ""
          return update?.state === "available" && update.latestDigest
            ? { allowed, image, kind: "deploy-update" }
            : { allowed, image, kind: "change-version" }
        }
        const source = sources.get(target.resourceId)
        return {
          kind: "rebuild",
          repository: source
            ? { branch: source.branch, name: source.repository }
            : null,
          source:
            sourceType === "compose"
              ? "compose"
              : source
                ? "github"
                : "dockerfile",
        }
      }
    }
  }
  return new Map(targets.map((target) => [target.targetKey, fixFor(target)]))
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
  const { targets } = await visibleTargets(user, input.scope, true)
  const checked = targets.filter((target) => target.checkedAt !== null)
  if (!checked.length) return null
  const summary = await runAppEffect(
    "security.loadSummary",
    loadSecuritySummaryEffect(uniqueInventories(checked))
  )
  return {
    ...summary,
    checkedAt: Math.min(...checked.map((target) => target.checkedAt ?? 0)),
    verdict: securityVerdict(summary),
  }
}

/** One inventory's packages, for someone who may see what runs it. */
export async function getSecurityPackagesHandler(input: {
  relayId: string
  sbomKey: string
}): Promise<Array<SecurityPackage>> {
  const user = await requireEligibleResourceUser()
  const access = await securityAccess(user)
  const visible =
    access.relayIds.includes(input.relayId) &&
    (await runSecurityTargets([input.relayId])).some(
      (target) => target.sbomKey === input.sbomKey && access.canView(target)
    )
  if (!visible) throw new Error("You can't see this image's vulnerabilities")
  const findings = await runAppEffect(
    "security.loadFindings",
    loadSecurityFindingsEffect(input.relayId, input.sbomKey, FINDINGS_READ)
  )
  return groupSecurityFindings(findings, FINDINGS_SHOWN_PER_PACKAGE)
}

/** Newer versions of the image an app runs, as its registry lists them. */
export async function getSecurityImageVersionsHandler(input: {
  appId: string
  relayId: string
}): Promise<{ image: string; suggestions: Array<ImageTagSuggestion> }> {
  const user = await requireEligibleResourceUser()
  const { app } = await authorizedAppFor(user, input, "app.read")
  const { image } = app.config
  const reference = parseImageReference(image)
  if (!reference) return { image, suggestions: [] }
  const tags = await runAppEffect(
    "security.registryTags",
    listRegistryTagsEffect(reference)
  )
  return { image, suggestions: suggestImageTags(reference, tags) }
}

/**
 * Checks the scope's inventories against the current vulnerability data
 * now, collecting the host's again for a Relay, or everything the user may
 * scan without a scope.
 */
// Scanning now only records what's due and wakes the scanner, which does
// the scans in its own time; it holds nothing, and is an operation for its
// trace and audit.
const scanNow = operation<{ readonly scope: string | null }>()({
  name: "security.scanNow",
  doing: "Asking for a security scan",
  authorize: ({ user }) => signedIn(user),
  locks: () => [],
  run: ({ context: user, input }) =>
    promiseEffect(() => scanSecurityNowFor(user, input)),
  // What was asked to be scanned: the scope's resource, or everything.
  audit: ({ input }) => {
    const scope = input.scope === null ? null : parseSecurityScope(input.scope)
    return scope
      ? {
          id: scope.resourceId,
          kind: scope.resourceType,
          relayId: scope.relayId,
        }
      : { id: "all", kind: "security" }
  },
})

export async function scanSecurityNowHandler(input: { scope: string | null }) {
  return runOperationPromise(scanNow, input, {
    user: await requireEligibleResourceUser(),
  })
}

async function scanSecurityNowFor(
  user: AuthenticatedUser,
  input: { scope: string | null }
) {
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
