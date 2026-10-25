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
  /** The scan targets, by `targetKey`, it was found in. */
  targets: Array<string>
  firstSeenAt: number
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
  knownExploited: number
}

export const emptySecuritySummary = (): SecuritySummary => ({
  counts: emptySeverityCounts(),
  fixable: 0,
  knownExploited: 0,
})

export interface SecurityOverview {
  resources: Array<SecurityResource>
  summary: SecuritySummary
  targets: Array<SecurityTarget & { targetKey: string }>
  findings: Array<SecurityFindingSummary>
  /** Scopes the viewer may scan again. */
  scannable: Array<string>
}

/** What one resource's page shows about its vulnerabilities. */
export interface ResourceSecuritySummary {
  checkedAt: number | null
  counts: SeverityCounts
  fixable: number
  knownExploited: number
  top: Array<
    Pick<
      SecurityFindingSummary,
      | "fixedVersion"
      | "installedVersions"
      | "knownExploited"
      | "packageName"
      | "severity"
      | "vulnerabilityId"
    >
  >
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
