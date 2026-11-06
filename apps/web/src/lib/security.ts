import { z } from "zod"

// Shared by Hearth's security worker, its server functions, and the pages
// that show what they found.

/** Grype's severities, least to most severe, as stored (their index). */
export const securitySeverities = [
  "negligible",
  "low",
  "medium",
  "high",
  "critical",
] as const
export type SecuritySeverity = (typeof securitySeverities)[number]

export const securitySeverityLabels = {
  critical: "Critical",
  high: "High",
  low: "Low",
  medium: "Medium",
  negligible: "Negligible",
} satisfies Record<SecuritySeverity, string>

export function severityRank(severity: SecuritySeverity): number {
  return securitySeverities.indexOf(severity)
}

export function severityAt(rank: number): SecuritySeverity {
  return securitySeverities[Math.max(0, Math.min(4, rank))] ?? "negligible"
}

/**
 * What Kiln says about an image or host as a whole, so nobody has to read its
 * vulnerabilities to know whether to act. Unsafe means act now: something is
 * being exploited, or a critical one has a fix. A critical one without a fix
 * is only risky, or an image already on its newest version would stay red
 * with nothing anyone could do about it.
 */
export type SecurityVerdict = "clean" | "minor" | "risky" | "unsafe"

/** Worst first. */
export const securityVerdicts = [
  "unsafe",
  "risky",
  "minor",
  "clean",
] as const satisfies ReadonlyArray<SecurityVerdict>

/** What a verdict means for whoever reads it, as a sentence. */
export const securityVerdictSentences = {
  clean: "Nothing known is wrong with this",
  minor: "Nothing here needs you now",
  risky: "This should be updated",
  unsafe: "This is unsafe to keep running",
} satisfies Record<SecurityVerdict, string>

export const securityVerdictLabels = {
  clean: "Clean",
  minor: "Minor",
  risky: "Risky",
  unsafe: "Unsafe",
} satisfies Record<SecurityVerdict, string>

export function securityVerdict(
  found: Pick<SecuritySummary, "counts" | "fixableCritical" | "knownExploited">
): SecurityVerdict {
  const { counts, fixableCritical, knownExploited } = found
  if (knownExploited > 0 || fixableCritical > 0) return "unsafe"
  if (counts.critical > 0 || counts.high > 0) return "risky"
  return counts.medium + counts.low + counts.negligible > 0 ? "minor" : "clean"
}

/** Says why, in a few words, from the worst of what was found. */
export function securityVerdictReason(
  found: Pick<SecuritySummary, "counts" | "fixable" | "knownExploited">
): string {
  const { counts, fixable, knownExploited } = found
  const lesser = counts.medium + counts.low + counts.negligible
  const worst =
    knownExploited > 0
      ? `${knownExploited.toLocaleString()} being exploited in the wild`
      : counts.critical > 0
        ? `${counts.critical.toLocaleString()} critical`
        : counts.high > 0
          ? `${counts.high.toLocaleString()} high`
          : lesser > 0
            ? `${lesser.toLocaleString()} minor`
            : "No known vulnerabilities"
  if (worst === "No known vulnerabilities") return worst
  return `${worst}, ${fixable > 0 ? `${fixable.toLocaleString()} fixable` : "no known fix"}`
}

/** How many findings of each severity, from negligible to critical. */
export type SeverityCounts = Record<SecuritySeverity, number>

export const emptySeverityCounts = (): SeverityCounts => ({
  critical: 0,
  high: 0,
  low: 0,
  medium: 0,
  negligible: 0,
})

/**
 * The resource a scan target belongs to, keyed as the scope picker keys its
 * options: `relay:<relayId>:<relayId>`, `server:<relayId>:<id>`, and so on.
 */
export type SecurityScopeKind = "app" | "database" | "relay" | "server"

export const securityScopeSchema = z
  .string()
  .regex(
    /^(app|database|relay|server):[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/u
  )

/** What a person wants to hear about the software Kiln runs for them. */
export const securityNotificationSettingsSchema = z.strictObject({
  /** The least severe vulnerability that notifies. */
  severity: z.enum(["critical", "high", "medium", "low"]),
  /** Only vulnerabilities an update fixes. */
  fixableOnly: z.boolean(),
})
export type SecurityNotificationSettings = z.infer<
  typeof securityNotificationSettingsSchema
>

export const defaultSecurityNotificationSettings: SecurityNotificationSettings =
  { fixableOnly: true, severity: "high" }

/** Where an inventory stands: waiting, collected and checked, or failed. */
export type SecurityTargetStatus =
  | "checked"
  | "failed"
  | "pending"
  | "unsupported"

export interface SecurityTarget {
  /** The scope picker key of the resource it belongs to. */
  scope: string
  relayId: string
  resourceType: "app" | "database" | "instance" | "relay"
  resourceId: string
  /** The app service or Kiln service, or "host" for the Relay's host. */
  component: string | null
  image: string | null
  running: boolean
  status: SecurityTargetStatus
  error: string | null
  collectedAt: number | null
  checkedAt: number | null
  packages: number | null
  distro: string | null
  counts: SeverityCounts
  /** Findings an update fixes. */
  fixable: number
  /** Of those, the critical ones. */
  fixableCritical: number
  knownExploited: number
}

export interface SecurityFindingSummary {
  vulnerabilityId: string
  severity: SecuritySeverity
  packageName: string
  packageType: string
  installedVersions: Array<string>
  fixedVersion: string | null
  fixState: "fixed" | "not-fixed" | "unknown" | "wont-fix"
  knownExploited: boolean
  url: string | null
  firstSeenAt: number
}

/**
 * One package's vulnerabilities together, since one update clears them all:
 * what someone acts on, where a vulnerability is only a reason to.
 */
export interface SecurityPackage {
  name: string
  type: string
  installedVersions: Array<string>
  /** What its vulnerabilities are fixed in, the most urgent's first. */
  fixedVersions: Array<string>
  worst: SecuritySeverity
  counts: SeverityCounts
  total: number
  fixable: number
  knownExploited: number
  /** Its most urgent vulnerabilities, up to the number asked for. */
  vulnerabilities: Array<SecurityFindingSummary>
}

/**
 * Rolls findings up by package, most urgent first: what's being exploited,
 * then the worst severity, then how many an update clears. Findings arrive
 * most urgent first, so each keeps its worst.
 */
export function groupSecurityFindings(
  findings: ReadonlyArray<SecurityFindingSummary>,
  shownPerPackage: number
): Array<SecurityPackage> {
  const packages = new Map<string, SecurityPackage>()
  for (const finding of findings) {
    const found = packages.get(finding.packageName) ?? {
      counts: emptySeverityCounts(),
      fixable: 0,
      fixedVersions: [],
      installedVersions: [],
      knownExploited: 0,
      name: finding.packageName,
      total: 0,
      type: finding.packageType,
      vulnerabilities: [],
      worst: finding.severity,
    }
    found.counts[finding.severity] += 1
    found.total += 1
    if (finding.knownExploited) found.knownExploited += 1
    if (severityRank(finding.severity) > severityRank(found.worst)) {
      found.worst = finding.severity
    }
    if (finding.fixedVersion) {
      found.fixable += 1
      if (!found.fixedVersions.includes(finding.fixedVersion)) {
        found.fixedVersions.push(finding.fixedVersion)
      }
    }
    for (const version of finding.installedVersions) {
      if (!found.installedVersions.includes(version)) {
        found.installedVersions.push(version)
      }
    }
    if (found.vulnerabilities.length < shownPerPackage) {
      found.vulnerabilities.push(finding)
    }
    packages.set(finding.packageName, found)
  }
  return [...packages.values()].sort(
    (left, right) =>
      Number(right.knownExploited > 0) - Number(left.knownExploited > 0) ||
      severityRank(right.worst) - severityRank(left.worst) ||
      right.fixable - left.fixable ||
      right.total - left.total ||
      left.name.localeCompare(right.name)
  )
}

/** A resource the overview's targets belong to, named for the viewer. */
export interface SecurityResource {
  scope: string
  kind: SecurityScopeKind
  relayId: string
  id: string
  name: string
  relayName: string
}

/** Every finding in view, counted once per vulnerability and package. */
export interface SecuritySummary {
  counts: SeverityCounts
  fixable: number
  fixableCritical: number
  knownExploited: number
}

export const emptySecuritySummary = (): SecuritySummary => ({
  counts: emptySeverityCounts(),
  fixable: 0,
  fixableCritical: 0,
  knownExploited: 0,
})

/** The inventory findings are read from, as `getSecurityFindings` asks. */
export interface SecurityInventoryRef {
  relayId: string
  sbomKey: string
}

/**
 * What fixes what a resource runs, by what Kiln can do about it. Where Kiln
 * does it, `allowed` says whether the viewer may.
 */
export type SecurityFix =
  /** An image app whose tag names a newer image: deploy it. */
  | { allowed: boolean; kind: "deploy-update"; image: string }
  /** An image app on a version that stopped moving: choose a newer one. */
  | { allowed: boolean; kind: "change-version"; image: string }
  /** The Relay's host: update its OS packages. */
  | { allowed: boolean; kind: "host-packages" }
  /** An app Kiln builds, from a repository or a pasted file. */
  | {
      kind: "rebuild"
      repository: { branch: string; name: string } | null
      source: "compose" | "dockerfile" | "github"
    }
  /** Kiln's own services: an update of Kiln replaces them. */
  | { kind: "kiln-update" }
  /** Kiln picks these images itself, so they change with its releases. */
  | { kind: "database" }
  | { kind: "game-server" }

/** One resource running an image, or the Relay its host belongs to. */
export interface SecurityUse {
  scope: string
  relayId: string
  relayName: string
  resourceType: SecurityTarget["resourceType"]
  resourceId: string
  name: string
  /** The app service or Kiln service, unless it's the resource itself. */
  component: string | null
  running: boolean
  fix: SecurityFix
}

/**
 * One image, however many run it, or one Relay's host: what the Security
 * page lists. An unchecked one has no verdict yet.
 */
export interface SecurityItem {
  key: string
  kind: "host" | "image"
  /** The image as it's named, or the host's distribution. */
  name: string
  inventory: SecurityInventoryRef
  status: SecurityTargetStatus
  error: string | null
  verdict: SecurityVerdict | null
  counts: SeverityCounts
  fixable: number
  fixableCritical: number
  knownExploited: number
  packages: number | null
  checkedAt: number | null
  uses: Array<SecurityUse>
}

/** Who an entry is about, as anyone would call it. */
export function securityItemTitle(item: SecurityItem): string {
  const [first] = item.uses
  if (!first) return item.name
  if (item.kind === "host") return first.relayName
  const names = [...new Set(item.uses.map((use) => use.name))]
  return names.length === 1
    ? (names[0] ?? item.name)
    : `${names[0]} +${(names.length - 1).toLocaleString()} more`
}

/** What that entry runs, under its name. */
export function securityItemDetail(item: SecurityItem): string {
  if (item.kind === "host") return `Host · ${item.name}`
  const [first] = item.uses
  return first?.component ? `${first.component} · ${item.name}` : item.name
}

/** What sort of thing an entry is. */
export function securityItemKind(
  item: SecurityItem,
  use: SecurityUse | undefined = item.uses[0]
): string {
  if (!use) return ""
  if (item.kind === "host") return "Relay host"
  switch (use.resourceType) {
    case "relay":
      return "Kiln service"
    case "app":
      return use.component ? `App · ${use.component}` : "App"
    case "database":
      return "Database"
    case "instance":
      return "Game server"
  }
}

/** The resource an entry's identity card shows: a host is its Relay's. */
export function securityItemInstance(
  item: SecurityItem,
  use: SecurityUse | undefined = item.uses[0]
) {
  const relayId = use?.relayId ?? item.inventory.relayId
  if (item.kind === "host" || !use || use.resourceType === "relay") {
    return { id: relayId, kind: "relay" as const, relayId }
  }
  return {
    id: use.resourceId,
    kind:
      use.resourceType === "instance" ? ("server" as const) : use.resourceType,
    relayId,
  }
}

export interface SecurityOverview {
  resources: Array<SecurityResource>
  summary: SecuritySummary
  items: Array<SecurityItem>
  /** Scopes the viewer may scan again. */
  scannable: Array<string>
}

/** What one resource's Info rail shows about its vulnerabilities. */
export interface ResourceSecuritySummary extends SecuritySummary {
  checkedAt: number | null
  verdict: SecurityVerdict
}

export function securityScopeKey(
  resourceType: SecurityTarget["resourceType"],
  relayId: string,
  resourceId: string
): string {
  const kind = resourceType === "instance" ? "server" : resourceType
  return `${kind}:${relayId}:${resourceId}`
}

export function parseSecurityScope(scope: string): {
  relayId: string
  resourceId: string
  resourceType: SecurityTarget["resourceType"]
} | null {
  if (!securityScopeSchema.safeParse(scope).success) return null
  const [kind, relayId, resourceId] = scope.split(":") as [
    SecurityScopeKind,
    string,
    string,
  ]
  return {
    relayId,
    resourceId,
    resourceType: kind === "server" ? "instance" : kind,
  }
}
