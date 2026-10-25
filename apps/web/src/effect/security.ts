import { createHash } from "node:crypto"

import type { RowDataPacket } from "mysql2/promise"
import type {
  RelaySecurityContainer,
  RelaySecurityTargets,
} from "@workspace/contracts"
import { Clock, Effect } from "effect"

import { Database } from "@/effect/database"
import type { GrypeFinding } from "@/effect/grype"
import { databaseTable } from "@/lib/database-config"
import {
  emptySecuritySummary,
  emptySeverityCounts,
  securityScopeKey,
  severityAt,
  type ResourceSecuritySummary,
  type SecurityFindingSummary,
  type SecuritySummary,
  type SecurityTarget,
} from "@/lib/security"

// What Hearth keeps of each Relay's inventories and what Grype found in
// them. See migration 0027 for the tables.

/** The inventory a target's host or image is described by. */
const HOST_SBOM = "host"
// An inventory that failed is asked for again after this long.
const INVENTORY_RETRY_MS = 6 * 60 * 60_000
// The host's packages change; its inventory is collected again this often.
export const HOST_INVENTORY_MAX_AGE_MS = 24 * 60 * 60_000
// A check that failed is tried again this long after.
const MATCH_RETRY_MS = 60 * 60_000

type ResourceType = SecurityTarget["resourceType"]

// A vulnerability counts once per source package: `linux-image-…` and
// `linux-modules-…` are one kernel, and `libssl3` and `openssl` one OpenSSL.
const findingPackage = "COALESCE(f.package_source, f.package_name)"

interface TargetRow {
  readonly component: string | null
  readonly image: string | null
  readonly resourceId: string
  readonly resourceType: ResourceType
  readonly running: boolean
  readonly sbomKey: string
  readonly targetKey: string
}

// Where each thing the Relay reported is kept. A resource's containers
// share one target per service, so a deployment's rollover, which briefly
// runs two, keeps the target its alerts belong to.
function targetRows(
  relayId: string,
  report: RelaySecurityTargets
): Array<TargetRow> {
  const rows = new Map<string, TargetRow>()
  rows.set("host", {
    component: "host",
    image: null,
    resourceId: relayId,
    resourceType: "relay",
    running: true,
    sbomKey: HOST_SBOM,
    targetKey: "host",
  })
  for (const container of report.containers) {
    const row = containerTarget(relayId, container)
    const previous = rows.get(row.targetKey)
    if (!previous || (row.running && !previous.running)) {
      rows.set(row.targetKey, row)
    }
  }
  return [...rows.values()]
}

function containerTarget(
  relayId: string,
  container: RelaySecurityContainer
): TargetRow {
  const { resource } = container
  const resourceId = resource.type === "relay" ? relayId : resource.id
  const component =
    resource.type === "relay" || resource.type === "app"
      ? (container.component ?? "app")
      : null
  return {
    component,
    image: container.image,
    resourceId,
    resourceType: resource.type,
    running: container.running,
    sbomKey: container.imageId,
    targetKey: [
      resource.type,
      resource.type === "relay" ? null : resourceId,
      component,
    ]
      .filter((part) => part !== null)
      .join(":")
      .slice(0, 255),
  }
}

/**
 * Replaces what Hearth knows runs on the Relay with what it reported, keeping
 * inventories still in use, and adding one to collect for each new image.
 */
export const syncSecurityTargetsEffect = Effect.fn("security.syncTargets")(
  function* (relayId: string, report: RelaySecurityTargets) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const rows = targetRows(relayId, report)
    yield* database.transaction("security.syncTargets", (tx) =>
      Effect.gen(function* () {
        const keys = rows.map((row) => row.targetKey)
        yield* tx.execute(
          `DELETE FROM ${databaseTable("security_target")}
            WHERE relay_id = ? AND target_key NOT IN (${keys.map(() => "?").join(", ")})`,
          [relayId, ...keys]
        )
        yield* tx.execute(
          `DELETE FROM ${databaseTable("security_alert")}
            WHERE relay_id = ? AND target_key NOT IN (${keys.map(() => "?").join(", ")})`,
          [relayId, ...keys]
        )
        yield* tx.execute(
          `INSERT INTO ${databaseTable("security_target")}
             (relay_id, target_key, resource_type, resource_id, component,
              image, sbom_key, running, observed_at, inventory_since)
           VALUES ${rows.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
           ON DUPLICATE KEY UPDATE
             resource_type = VALUES(resource_type),
             resource_id = VALUES(resource_id),
             component = VALUES(component),
             image = VALUES(image),
             -- Before sbom_key changes, which MySQL assigns in order.
             inventory_since = IF(sbom_key = VALUES(sbom_key),
               inventory_since, VALUES(inventory_since)),
             sbom_key = VALUES(sbom_key),
             running = VALUES(running),
             observed_at = VALUES(observed_at)`,
          rows.flatMap((row) => [
            relayId,
            row.targetKey,
            row.resourceType,
            row.resourceId,
            row.component,
            row.image?.slice(0, 512) ?? null,
            row.sbomKey,
            row.running ? 1 : 0,
            now,
            now,
          ])
        )
        const inventories = new Map(rows.map((row) => [row.sbomKey, row.image]))
        yield* tx.execute(
          `INSERT IGNORE INTO ${databaseTable("security_sbom")}
             (relay_id, sbom_key, image)
           VALUES ${[...inventories].map(() => "(?, ?, ?)").join(", ")}`,
          [...inventories].flatMap(([key, image]) => [
            relayId,
            key,
            image?.slice(0, 512) ?? null,
          ])
        )
        // An image nothing runs any more is forgotten with its findings.
        yield* tx.execute(
          `DELETE FROM ${databaseTable("security_sbom")}
            WHERE relay_id = ? AND sbom_key NOT IN (${[...inventories.keys()].map(() => "?").join(", ")})`,
          [relayId, ...inventories.keys()]
        )
      })
    )
  }
)

export interface DueInventory {
  readonly collectedAt: number | null
  readonly image: string | null
  readonly requested: boolean
  readonly sbomKey: string
}

/**
 * The Relay's inventories Hearth should ask for: images it has none of yet,
 * failures due another try, its host when that's old, and any someone
 * asked to scan again.
 */
export const dueInventoriesEffect = Effect.fn("security.dueInventories")(
  function* (relayId: string) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const rows = yield* database.queryRows<
      RowDataPacket & {
        collected_at: number | string | null
        image: string | null
        requested: number
        sbom_key: string
      }
    >(
      "security.dueInventories",
      `SELECT sbom_key, image, collected_at,
              (requested_at IS NOT NULL
                AND (collected_at IS NULL OR requested_at > collected_at))
                AS requested
         FROM ${databaseTable("security_sbom")}
        WHERE relay_id = ?
          AND ((requested_at IS NOT NULL
                 AND (collected_at IS NULL OR requested_at > collected_at)
                 AND (inventory_attempted_at IS NULL
                   OR inventory_attempted_at < requested_at))
            OR (document IS NULL
                 AND (inventory_attempted_at IS NULL
                   OR inventory_attempted_at < ?))
            OR (sbom_key = ? AND collected_at < ?
                 AND (inventory_attempted_at IS NULL
                   OR inventory_attempted_at < ?)))
        ORDER BY sbom_key = ? DESC, sbom_key`,
      [
        relayId,
        now - INVENTORY_RETRY_MS,
        HOST_SBOM,
        now - HOST_INVENTORY_MAX_AGE_MS,
        now - INVENTORY_RETRY_MS,
        HOST_SBOM,
      ]
    )
    return rows.map((row): DueInventory => ({
      collectedAt: row.collected_at === null ? null : Number(row.collected_at),
      image: row.image,
      requested: Boolean(row.requested),
      sbomKey: row.sbom_key,
    }))
  }
)

/** Keeps an inventory the Relay collected, to be checked again. */
export const recordInventoryEffect = Effect.fn("security.recordInventory")(
  function* (
    relayId: string,
    sbomKey: string,
    inventory: {
      readonly collectedAt: number
      readonly distro: string | null
      readonly document: Buffer
      readonly generator: string
      readonly packageCount: number
    }
  ) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "security.recordInventory",
      `UPDATE ${databaseTable("security_sbom")}
          SET document = ?, generator = ?, distro = ?, package_count = ?,
              collected_at = ?, inventory_error = NULL,
              inventory_attempted_at = ?, matched_db = NULL,
              match_error = NULL
        WHERE relay_id = ? AND sbom_key = ?`,
      [
        inventory.document,
        inventory.generator.slice(0, 64),
        inventory.distro?.slice(0, 128) ?? null,
        inventory.packageCount,
        inventory.collectedAt,
        now,
        relayId,
        sbomKey,
      ]
    )
  }
)

export const recordInventoryFailureEffect = Effect.fn(
  "security.recordInventoryFailure"
)(function* (relayId: string, sbomKey: string, error: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "security.recordInventoryFailure",
    `UPDATE ${databaseTable("security_sbom")}
        SET inventory_error = ?, inventory_attempted_at = ?
      WHERE relay_id = ? AND sbom_key = ?`,
    [error.slice(0, 1024), now, relayId, sbomKey]
  )
})

/**
 * Inventories not yet checked against the database built at `builtAt`. One
 * whose check failed is tried again after an hour.
 */
export const pendingMatchesEffect = Effect.fn("security.pendingMatches")(
  function* (builtAt: number) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const rows = yield* database.queryRows<
      RowDataPacket & { relay_id: string; sbom_key: string }
    >(
      "security.pendingMatches",
      `SELECT relay_id, sbom_key FROM ${databaseTable("security_sbom")}
        WHERE document IS NOT NULL
          AND (matched_db IS NULL OR matched_db <> ?)
          AND (match_error IS NULL OR matched_at < ?)
        ORDER BY matched_db IS NULL DESC
        LIMIT 100`,
      [String(builtAt), now - MATCH_RETRY_MS]
    )
    return rows.map((row) => ({ relayId: row.relay_id, sbomKey: row.sbom_key }))
  }
)

/** Whether Hearth holds any inventory, so it needs Grype's database. */
export const hasInventoriesEffect = Effect.fn("security.hasInventories")(
  function* () {
    const database = yield* Database
    const rows = yield* database.queryRows<RowDataPacket & { found: number }>(
      "security.hasInventories",
      `SELECT 1 AS found FROM ${databaseTable("security_sbom")}
        WHERE document IS NOT NULL LIMIT 1`
    )
    return rows.length > 0
  }
)

export const loadInventoryDocumentEffect = Effect.fn(
  "security.loadInventoryDocument"
)(function* (relayId: string, sbomKey: string) {
  const database = yield* Database
  const rows = yield* database.queryRows<
    RowDataPacket & { document: Buffer | null }
  >(
    "security.loadInventoryDocument",
    `SELECT document FROM ${databaseTable("security_sbom")}
      WHERE relay_id = ? AND sbom_key = ?`,
    [relayId, sbomKey]
  )
  return rows[0]?.document ?? null
})

/**
 * Replaces an inventory's findings with Grype's, keeping when each was
 * first seen, and what Grype says about each vulnerability.
 */
export const recordFindingsEffect = Effect.fn("security.recordFindings")(
  function* (
    relayId: string,
    sbomKey: string,
    builtAt: number,
    findings: ReadonlyArray<GrypeFinding>
  ) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    yield* database.transaction("security.recordFindings", (tx) =>
      Effect.gen(function* () {
        const sbom = yield* tx.queryRows<RowDataPacket & { found: number }>(
          `SELECT 1 AS found FROM ${databaseTable("security_sbom")}
            WHERE relay_id = ? AND sbom_key = ? FOR UPDATE`,
          [relayId, sbomKey]
        )
        // Forgotten while Grype checked it.
        if (sbom.length === 0) return
        const keys = findings.map((finding) => finding.findingKey)
        yield* tx.execute(
          `DELETE FROM ${databaseTable("security_finding")}
            WHERE relay_id = ? AND sbom_key = ?${
              keys.length
                ? ` AND finding_key NOT IN (${keys.map(() => "?").join(", ")})`
                : ""
            }`,
          [relayId, sbomKey, ...keys]
        )
        for (let start = 0; start < findings.length; start += 200) {
          const batch = findings.slice(start, start + 200)
          yield* tx.execute(
            `INSERT INTO ${databaseTable("security_finding")}
               (relay_id, sbom_key, finding_key, vulnerability_id,
                package_name, package_version, package_type, package_source,
                location, severity, fix_state, fixed_version, risk,
                first_seen_at)
             VALUES ${batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
             ON DUPLICATE KEY UPDATE
               package_source = VALUES(package_source),
               location = VALUES(location),
               severity = VALUES(severity),
               fix_state = VALUES(fix_state),
               fixed_version = VALUES(fixed_version),
               risk = VALUES(risk)`,
            batch.flatMap((finding) => [
              relayId,
              sbomKey,
              finding.findingKey,
              finding.vulnerabilityId,
              finding.packageName,
              finding.packageVersion,
              finding.packageType,
              finding.packageSource,
              finding.location,
              finding.severity,
              finding.fixState,
              finding.fixedVersion,
              finding.risk,
              now,
            ])
          )
          const vulnerabilities = new Map(
            batch.map((finding) => [finding.vulnerabilityId, finding])
          )
          yield* tx.execute(
            `INSERT INTO ${databaseTable("security_vulnerability")}
               (id, severity, description, url, cvss, epss, known_exploited,
                updated_at)
             VALUES ${[...vulnerabilities].map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
             ON DUPLICATE KEY UPDATE
               severity = VALUES(severity),
               description = VALUES(description),
               url = VALUES(url),
               cvss = VALUES(cvss),
               epss = VALUES(epss),
               known_exploited = VALUES(known_exploited),
               updated_at = VALUES(updated_at)`,
            [...vulnerabilities.values()].flatMap((finding) => [
              finding.vulnerabilityId,
              finding.severity,
              finding.description,
              finding.url,
              finding.cvss,
              finding.epss,
              finding.knownExploited ? 1 : 0,
              now,
            ])
          )
        }
        yield* tx.execute(
          `UPDATE ${databaseTable("security_sbom")}
              SET matched_db = ?, matched_at = ?, match_error = NULL
            WHERE relay_id = ? AND sbom_key = ?`,
          [String(builtAt), now, relayId, sbomKey]
        )
      })
    )
  }
)

/**
 * A failed check keeps the findings the last one found, and is tried again
 * after an hour.
 */
export const recordMatchFailureEffect = Effect.fn(
  "security.recordMatchFailure"
)(function* (relayId: string, sbomKey: string, error: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "security.recordMatchFailure",
    `UPDATE ${databaseTable("security_sbom")}
        SET matched_at = ?, match_error = ?
      WHERE relay_id = ? AND sbom_key = ?`,
    [now, error.slice(0, 1024), relayId, sbomKey]
  )
})

/**
 * Checks the scope's inventories again, and collects its Relay's host's
 * again when the scope is the Relay. Answers how many it marked.
 */
export const requestSecurityScanEffect = Effect.fn("security.requestScan")(
  function* (
    relayId: string,
    resource: { readonly id: string; readonly type: ResourceType } | null
  ) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const sbom = databaseTable("security_sbom")
    const target = databaseTable("security_target")
    if (resource === null || resource.type === "relay") {
      yield* database.execute(
        "security.requestScan.host",
        `UPDATE ${sbom} SET requested_at = ?
          WHERE relay_id = ? AND sbom_key = ?`,
        [now, relayId, HOST_SBOM]
      )
    }
    const result = yield* database.execute(
      "security.requestScan",
      `UPDATE ${sbom} s
          SET s.matched_db = NULL,
              s.match_error = NULL,
              s.inventory_attempted_at = IF(s.document IS NULL, NULL, s.inventory_attempted_at)
        WHERE s.relay_id = ?${
          resource === null
            ? ""
            : ` AND s.sbom_key IN (
              SELECT t.sbom_key FROM ${target} t
               WHERE t.relay_id = ? AND t.resource_type = ? AND t.resource_id = ?)`
        }`,
      resource === null
        ? [relayId]
        : [relayId, relayId, resource.type, resource.id]
    )
    return result.affectedRows
  }
)

interface TargetStateRow extends RowDataPacket {
  checked_at: number | string | null
  collected_at: number | string | null
  component: string | null
  distro: string | null
  has_document: number
  image: string | null
  inventory_error: string | null
  match_error: string | null
  matched_db: string | null
  package_count: number | null
  relay_id: string
  resource_id: string
  resource_type: ResourceType
  running: number
  sbom_key: string
  target_key: string
}

interface CountRow extends RowDataPacket {
  findings: number
  fixable: number | string
  known_exploited: number | string
  relay_id: string
  sbom_key: string
  severity: number
}

interface FindingRow extends RowDataPacket {
  first_seen_at: number | string
  fix_state: SecurityFindingSummary["fixState"]
  fixed_version: string | null
  known_exploited: number | null
  package_name: string
  package_type: string
  package_version: string
  relay_id: string
  sbom_key: string
  severity: number
  url: string | null
  vulnerability_id: string
}

/** Every target on these Relays, with what its inventory found. */
export const loadSecurityTargetsEffect = Effect.fn("security.loadTargets")(
  function* (relayIds: ReadonlyArray<string>) {
    if (!relayIds.length) return []
    const database = yield* Database
    const placeholders = relayIds.map(() => "?").join(", ")
    const [targets, counts] = yield* Effect.all([
      database.queryRows<TargetStateRow>(
        "security.loadTargets",
        `SELECT t.relay_id, t.target_key, t.resource_type, t.resource_id,
                t.component, t.image, t.running, t.sbom_key,
                s.collected_at, s.matched_at AS checked_at, s.matched_db,
                s.inventory_error, s.match_error, s.package_count, s.distro,
                s.document IS NOT NULL AS has_document
           FROM ${databaseTable("security_target")} t
           JOIN ${databaseTable("security_sbom")} s
             ON s.relay_id = t.relay_id AND s.sbom_key = t.sbom_key
          WHERE t.relay_id IN (${placeholders})`,
        [...relayIds]
      ),
      database.queryRows<CountRow>(
        "security.loadTargets.counts",
        `SELECT f.relay_id, f.sbom_key, f.severity,
                COUNT(DISTINCT f.vulnerability_id, ${findingPackage}) AS findings,
                COUNT(DISTINCT CASE WHEN f.fix_state = 'fixed'
                  THEN CONCAT(f.vulnerability_id, ' ', ${findingPackage}) END)
                  AS fixable,
                COUNT(DISTINCT CASE WHEN v.known_exploited = 1
                  THEN CONCAT(f.vulnerability_id, ' ', ${findingPackage}) END)
                  AS known_exploited
           FROM ${databaseTable("security_finding")} f
           LEFT JOIN ${databaseTable("security_vulnerability")} v
             ON v.id = f.vulnerability_id
          WHERE f.relay_id IN (${placeholders})
          GROUP BY f.relay_id, f.sbom_key, f.severity`,
        [...relayIds]
      ),
    ])
    const summaries = new Map<
      string,
      Pick<SecurityTarget, "counts" | "fixable" | "knownExploited">
    >()
    for (const row of counts) {
      const key = `${row.relay_id}/${row.sbom_key}`
      const summary = summaries.get(key) ?? {
        counts: emptySeverityCounts(),
        fixable: 0,
        knownExploited: 0,
      }
      summary.counts[severityAt(row.severity)] += Number(row.findings)
      summary.fixable += Number(row.fixable)
      summary.knownExploited += Number(row.known_exploited)
      summaries.set(key, summary)
    }
    return targets.map(
      (row): SecurityTarget & { sbomKey: string; targetKey: string } => {
        const summary = summaries.get(`${row.relay_id}/${row.sbom_key}`)
        const checked = row.matched_db !== null && row.match_error === null
        return {
          checkedAt: checked ? Number(row.checked_at) : null,
          collectedAt:
            row.collected_at === null ? null : Number(row.collected_at),
          component: row.component,
          counts: summary?.counts ?? emptySeverityCounts(),
          distro: row.distro,
          error: row.inventory_error ?? row.match_error,
          fixable: summary?.fixable ?? 0,
          image: row.image,
          knownExploited: summary?.knownExploited ?? 0,
          packages: row.package_count,
          relayId: row.relay_id,
          resourceId: row.resource_id,
          resourceType: row.resource_type,
          running: row.running === 1,
          sbomKey: row.sbom_key,
          scope: securityScopeKey(
            row.resource_type,
            row.relay_id,
            row.resource_id
          ),
          status: checked
            ? "checked"
            : (row.inventory_error && !row.has_document) || row.match_error
              ? "failed"
              : "pending",
          targetKey: `${row.relay_id}/${row.target_key}`,
        }
      }
    )
  }
)

/**
 * The findings in these inventories, one per vulnerability and package in
 * each inventory, most urgent first: known exploited, then by severity, then by risk.
 */
export const loadSecurityFindingsEffect = Effect.fn("security.loadFindings")(
  function* (
    inventories: ReadonlyArray<{
      readonly relayId: string
      readonly sbomKey: string
      readonly targetKeys: ReadonlyArray<string>
    }>,
    // Only the most urgent, as a resource's page shows; all without one.
    limit?: number
  ) {
    if (!inventories.length) {
      return { findings: [], summary: emptySecuritySummary() }
    }
    const database = yield* Database
    const pairs = inventories.flatMap((inventory) => [
      inventory.relayId,
      inventory.sbomKey,
    ])
    const inPairs = `(f.relay_id, f.sbom_key) IN (${inventories.map(() => "(?, ?)").join(", ")})`
    const totals = yield* database.queryRows<
      RowDataPacket & {
        findings: number
        fixable: number | string
        known_exploited: number | string
        severity: number
      }
    >(
      "security.loadFindings.summary",
      `SELECT f.severity,
              COUNT(DISTINCT f.vulnerability_id, ${findingPackage}) AS findings,
              COUNT(DISTINCT CASE WHEN f.fix_state = 'fixed'
                THEN CONCAT(f.vulnerability_id, ' ', ${findingPackage}) END)
                AS fixable,
              COUNT(DISTINCT CASE WHEN v.known_exploited = 1
                THEN CONCAT(f.vulnerability_id, ' ', ${findingPackage}) END)
                AS known_exploited
         FROM ${databaseTable("security_finding")} f
         LEFT JOIN ${databaseTable("security_vulnerability")} v
           ON v.id = f.vulnerability_id
        WHERE ${inPairs}
        GROUP BY f.severity`,
      pairs
    )
    const summary = emptySecuritySummary()
    for (const row of totals) {
      summary.counts[severityAt(row.severity)] += Number(row.findings)
      summary.fixable += Number(row.fixable)
      summary.knownExploited += Number(row.known_exploited)
    }
    const rows = yield* database.queryRows<FindingRow>(
      "security.loadFindings",
      `SELECT f.relay_id, f.sbom_key, f.vulnerability_id,
              ${findingPackage} AS package_name, f.package_version, f.package_type, f.severity, f.fix_state,
              f.fixed_version, f.first_seen_at, v.url, v.known_exploited
         FROM ${databaseTable("security_finding")} f
         LEFT JOIN ${databaseTable("security_vulnerability")} v
           ON v.id = f.vulnerability_id
        WHERE (f.relay_id, f.sbom_key) IN (${inventories.map(() => "(?, ?)").join(", ")})
        ORDER BY COALESCE(v.known_exploited, 0) DESC, f.severity DESC,
                 f.fix_state = 'fixed' DESC, f.risk DESC, f.vulnerability_id${
                   limit === undefined ? "" : ` LIMIT ${Math.max(1, limit * 8)}`
                 }`,
      inventories.flatMap((inventory) => [inventory.relayId, inventory.sbomKey])
    )
    const targets = new Map(
      inventories.map((inventory) => [
        `${inventory.relayId}/${inventory.sbomKey}`,
        inventory.targetKeys,
      ])
    )
    const findings = new Map<string, SecurityFindingSummary>()
    for (const row of rows) {
      // Per inventory, so each says what's installed and what fixes it there.
      const key = `${row.relay_id}/${row.sbom_key}\u0000${row.vulnerability_id}\u0000${row.package_name}`
      const finding = findings.get(key) ?? {
        firstSeenAt: Number(row.first_seen_at),
        fixState: row.fix_state,
        fixedVersion: row.fixed_version,
        installedVersions: [],
        knownExploited: row.known_exploited === 1,
        packageName: row.package_name,
        packageType: row.package_type,
        severity: severityAt(row.severity),
        targets: [],
        url: row.url,
        vulnerabilityId: row.vulnerability_id,
      }
      if (!finding.installedVersions.includes(row.package_version)) {
        finding.installedVersions.push(row.package_version)
      }
      for (const target of targets.get(`${row.relay_id}/${row.sbom_key}`) ??
        []) {
        if (!finding.targets.includes(target)) finding.targets.push(target)
      }
      finding.firstSeenAt = Math.min(
        finding.firstSeenAt,
        Number(row.first_seen_at)
      )
      findings.set(key, finding)
    }
    const all = [...findings.values()]
    return {
      findings: limit === undefined ? all : all.slice(0, limit),
      summary,
    }
  }
)

/** What one resource's page says about its vulnerabilities. */
export function resourceSecuritySummary(
  targets: ReadonlyArray<SecurityTarget>,
  findings: ReadonlyArray<SecurityFindingSummary>,
  summary: SecuritySummary
): ResourceSecuritySummary | null {
  const checked = targets.filter((target) => target.checkedAt !== null)
  if (!checked.length) return null
  return {
    checkedAt: Math.min(...checked.map((target) => target.checkedAt ?? 0)),
    ...summary,
    top: findings.slice(0, 3).map((finding) => ({
      fixedVersion: finding.fixedVersion,
      installedVersions: finding.installedVersions,
      knownExploited: finding.knownExploited,
      packageName: finding.packageName,
      severity: finding.severity,
      vulnerabilityId: finding.vulnerabilityId,
    })),
  }
}

// ------------------------------------------------------------- announcing

export interface SecurityAnnouncement {
  readonly component: string | null
  readonly findings: ReadonlyArray<AnnouncedFinding>
  readonly relayId: string
  readonly resourceId: string
  readonly resourceType: ResourceType
}

export interface AnnouncedFinding {
  /** When it was first seen where it is now, so one that returns is news. */
  readonly firstSeenAt: number
  readonly fixedVersion: string | null
  readonly fixable: boolean
  readonly knownExploited: boolean
  readonly packageName: string
  readonly packageVersion: string
  readonly severity: number
  readonly vulnerabilityId: string
}

/** Which alerts an announcement records as told, and which it forgets. */
export interface SecurityAlertChanges {
  readonly gone: ReadonlyArray<{ alertKey: string; targetKey: string }>
  readonly told: ReadonlyArray<{ alertKey: string; targetKey: string }>
}

/**
 * The checked targets' findings nobody has been told about, grouped by
 * resource, and the alert changes to record once they're delivered. A
 * finding is news again once it can be fixed, once it's known to be
 * exploited, or once its severity changes; one that goes away is forgotten,
 * so it's news if it comes back.
 */
export const pendingSecurityAnnouncementsEffect = Effect.fn(
  "security.pendingAnnouncements"
)(function* (relayId: string) {
  const database = yield* Database
  const [rows, alerted] = yield* Effect.all([
    database.queryRows<
      RowDataPacket & {
        component: string | null
        first_seen_at: number | string
        fix_state: string
        fixed_version: string | null
        known_exploited: number | null
        package_name: string
        package_version: string
        resource_id: string
        resource_type: ResourceType
        severity: number
        target_key: string
        vulnerability_id: string
      }
    >(
      "security.pendingAnnouncements",
      `SELECT t.target_key, t.resource_type, t.resource_id, t.component,
              f.vulnerability_id, ${findingPackage} AS package_name,
              f.package_version, f.severity, f.fix_state, f.fixed_version,
              GREATEST(f.first_seen_at, t.inventory_since) AS first_seen_at,
              v.known_exploited
         FROM ${databaseTable("security_target")} t
         JOIN ${databaseTable("security_sbom")} s
           ON s.relay_id = t.relay_id AND s.sbom_key = t.sbom_key
         JOIN ${databaseTable("security_finding")} f
           ON f.relay_id = s.relay_id AND f.sbom_key = s.sbom_key
         LEFT JOIN ${databaseTable("security_vulnerability")} v
           ON v.id = f.vulnerability_id
        WHERE t.relay_id = ? AND s.matched_db IS NOT NULL
          AND s.match_error IS NULL`,
      [relayId]
    ),
    database.queryRows<
      RowDataPacket & { alert_key: string; target_key: string }
    >(
      "security.pendingAnnouncements.alerts",
      `SELECT target_key, alert_key FROM ${databaseTable("security_alert")}
        WHERE relay_id = ?`,
      [relayId]
    ),
  ])
  const alreadyTold = new Set(
    alerted.map((row) => `${row.target_key}\u0000${row.alert_key}`)
  )
  const current = new Set<string>()
  const told: Array<{ alertKey: string; targetKey: string }> = []
  const byResource = new Map<string, SecurityAnnouncement>()
  for (const row of rows) {
    const fixable = row.fix_state === "fixed"
    const knownExploited = row.known_exploited === 1
    const alertKey = createHash("sha256")
      .update(
        [
          row.vulnerability_id,
          row.package_name,
          fixable ? "fixed" : "",
          knownExploited ? "exploited" : "",
          String(row.severity),
        ].join("\u0000")
      )
      .digest("hex")
    const key = `${row.target_key}\u0000${alertKey}`
    if (current.has(key)) continue
    current.add(key)
    if (alreadyTold.has(key)) continue
    told.push({ alertKey, targetKey: row.target_key })
    const resourceKey = `${row.resource_type}:${row.resource_id}:${
      row.resource_type === "relay" ? (row.component ?? "") : ""
    }`
    const announcement = byResource.get(resourceKey) ?? {
      component: row.resource_type === "relay" ? row.component : null,
      findings: [],
      relayId,
      resourceId: row.resource_id,
      resourceType: row.resource_type,
    }
    ;(announcement.findings as Array<AnnouncedFinding>).push({
      firstSeenAt: Number(row.first_seen_at),
      fixable,
      fixedVersion: row.fixed_version,
      knownExploited,
      packageName: row.package_name,
      packageVersion: row.package_version,
      severity: row.severity,
      vulnerabilityId: row.vulnerability_id,
    })
    byResource.set(resourceKey, announcement)
  }
  const gone = alerted
    .filter((row) => !current.has(`${row.target_key}\u0000${row.alert_key}`))
    .map((row) => ({ alertKey: row.alert_key, targetKey: row.target_key }))
  return {
    announcements: [...byResource.values()],
    changes: { gone, told } satisfies SecurityAlertChanges,
  }
})

/**
 * Records announced findings as told and forgets those that went away, once
 * their notifications are delivered. Until then, every sweep finds them news
 * again, and delivering them again is a no-op.
 */
export const recordSecurityAnnouncementsEffect = Effect.fn(
  "security.recordAnnouncements"
)(function* (relayId: string, changes: SecurityAlertChanges) {
  if (!changes.gone.length && !changes.told.length) return
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.transaction("security.recordAnnouncements", (tx) =>
    Effect.gen(function* () {
      for (let start = 0; start < changes.gone.length; start += 500) {
        const batch = changes.gone.slice(start, start + 500)
        yield* tx.execute(
          `DELETE FROM ${databaseTable("security_alert")}
            WHERE relay_id = ? AND (target_key, alert_key) IN (${batch.map(() => "(?, ?)").join(", ")})`,
          [relayId, ...batch.flatMap((row) => [row.targetKey, row.alertKey])]
        )
      }
      for (let start = 0; start < changes.told.length; start += 500) {
        const batch = changes.told.slice(start, start + 500)
        yield* tx.execute(
          `INSERT IGNORE INTO ${databaseTable("security_alert")}
             (relay_id, target_key, alert_key, alerted_at)
           VALUES ${batch.map(() => "(?, ?, ?, ?)").join(", ")}`,
          batch.flatMap((row) => [relayId, row.targetKey, row.alertKey, now])
        )
      }
    })
  )
})

/** Names for the resources announcements are about. */
export const securityResourceNamesEffect = Effect.fn("security.resourceNames")(
  function* (relayId: string) {
    const database = yield* Database
    const [relays, instances, databases, apps] = yield* Effect.all([
      database.queryRows<RowDataPacket & { id: string; name: string }>(
        "security.resourceNames.relay",
        `SELECT id, name FROM ${databaseTable("relay")} WHERE id = ?`,
        [relayId]
      ),
      database.queryRows<RowDataPacket & { id: string; name: string | null }>(
        "security.resourceNames.instance",
        `SELECT instance_id AS id, COALESCE(display_name, source_name) AS name
           FROM ${databaseTable("instance")} WHERE relay_id = ?`,
        [relayId]
      ),
      database.queryRows<RowDataPacket & { id: string; name: string }>(
        "security.resourceNames.database",
        `SELECT database_id AS id, name FROM ${databaseTable("database")}
          WHERE relay_id = ?`,
        [relayId]
      ),
      database.queryRows<RowDataPacket & { id: string; name: string }>(
        "security.resourceNames.app",
        `SELECT app_id AS id, name FROM ${databaseTable("app")}
          WHERE relay_id = ?`,
        [relayId]
      ),
    ])
    const names = new Map<string, string>()
    for (const row of relays) names.set(`relay:${row.id}`, row.name)
    for (const row of instances) {
      if (row.name) names.set(`instance:${row.id}`, row.name)
    }
    for (const row of databases) names.set(`database:${row.id}`, row.name)
    for (const row of apps) names.set(`app:${row.id}`, row.name)
    return names
  }
)
