import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect, Option, Schema } from "effect"

import { Database } from "@/effect/database"
import {
  CredentialError,
  DomainConfigurationError,
  ResourceNotFoundError,
} from "@/effect/errors"
import { databaseTable } from "@/lib/database-config"
import { domainBlacklistPatternsSchema } from "@/lib/domain-schemas"
import { betterAuthSecrets } from "@/lib/environment"

import { decryptWithKeyring, encryptWithKeyring } from "../../keyring.mjs"

const CLOUDFLARE_INTEGRATION_ID = "cloudflare"
const CLOUDFLARE_API_TOKEN_PURPOSE = "kiln-cloudflare-api-token"
const decodeJsonString = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Unknown)
)

export type DomainAssignmentStrategy = "balanced" | "default" | "random"

/** A domain Kiln can create `<vanity>.<domain>` names under. */
export interface ManagedDomain {
  domain: string
  /**
   * Offered to new game servers. A disabled domain still serves, syncs, and
   * renames the game server domains already on it.
   */
  enabled: boolean
  isDefault: boolean
  zoneId: string
  zoneName: string
}

export interface DomainIntegration {
  blacklistPatterns: Array<string>
  /** The default first, then enabled domains, each sorted by name. */
  domains: Array<ManagedDomain>
  enabled: boolean
  id: string
  lastError: string | null
  lastVerifiedAt: string | null
  provider: "cloudflare"
  strategy: DomainAssignmentStrategy
}

export interface CloudflareIntegrationCredential extends DomainIntegration {
  apiToken: string
}

export interface InstanceDomainAssignment {
  addressRecordId: string | null
  addressRecordType: "A" | "AAAA" | "CNAME" | null
  domain: string
  id: string
  instanceId: string
  integrationId: string
  lastError: string | null
  /** The domain Hearth advertises as the game server's connect address. */
  primary: boolean
  publicHost: string
  publicPort: number
  relayId: string
  srvProtocol: "tcp" | "udp" | null
  srvRecordId: string | null
  srvService: string | null
  status: "active" | "error" | "pending" | "removing"
  supportsSrv: boolean
  vanityLabel: string
  /** Null only if the domain is no longer configured. */
  zoneId: string | null
}

interface DomainIntegrationRow extends RowDataPacket {
  api_token_ciphertext: string
  assignment_strategy: DomainAssignmentStrategy
  blacklist_patterns: unknown
  enabled: boolean | number
  id: string
  last_error: string | null
  last_verified_at: number | null
  provider: "cloudflare"
}

interface DomainZoneRow extends RowDataPacket {
  domain: string
  enabled: boolean | number
  is_default: boolean | number
  zone_id: string
  zone_name: string
}

interface InstanceDomainRow extends RowDataPacket {
  address_record_id: string | null
  address_record_type: "A" | "AAAA" | "CNAME" | null
  domain: string
  id: string
  instance_id: string
  integration_id: string
  is_primary: boolean | number
  last_error: string | null
  public_host: string
  public_port: number
  relay_id: string
  srv_protocol: "tcp" | "udp" | null
  srv_record_id: string | null
  srv_service: string | null
  status: "active" | "error" | "pending" | "removing"
  supports_srv: boolean | number
  vanity_label: string
  zone_id: string | null
}

const loadIntegrationRowEffect = Effect.fnUntraced(function* (
  operation: string
) {
  const database = yield* Database
  const [rows, zones] = yield* Effect.all(
    [
      database.queryRows<DomainIntegrationRow>(
        operation,
        `SELECT id, provider, api_token_ciphertext, blacklist_patterns,
                enabled, assignment_strategy, last_verified_at, last_error
           FROM ${databaseTable("domain_integration")}
          WHERE id = ?
          LIMIT 1`,
        [CLOUDFLARE_INTEGRATION_ID]
      ),
      database.queryRows<DomainZoneRow>(
        `${operation}.domains`,
        `SELECT domain, zone_id, zone_name, is_default, enabled
           FROM ${databaseTable("domain_zone")}
          WHERE integration_id = ?
          ORDER BY is_default DESC, enabled DESC, domain`,
        [CLOUDFLARE_INTEGRATION_ID]
      ),
    ],
    { concurrency: 2 }
  )
  const row = rows[0]
  return row ? { row, zones } : null
})

export const loadDomainIntegrationEffect = Effect.fn(
  "domains.integration.load"
)(function* () {
  const loaded = yield* loadIntegrationRowEffect("domains.integration.load")
  return loaded ? publicIntegration(loaded.row, loaded.zones) : null
})

export const loadCloudflareIntegrationCredentialEffect = Effect.fn(
  "domains.integration.credential"
)(function* () {
  const database = yield* Database
  const loaded = yield* loadIntegrationRowEffect(
    "domains.integration.credential"
  )
  if (!loaded) {
    return yield* ResourceNotFoundError.make({
      message: "Connect Cloudflare in Infrastructure → Domains first",
      resource: "cloudflare_integration",
    })
  }
  const ciphertext = loaded.row.api_token_ciphertext
  const decrypted = yield* Effect.try({
    try: () =>
      decryptWithKeyring(
        ciphertext,
        betterAuthSecrets(),
        CLOUDFLARE_API_TOKEN_PURPOSE
      ),
    catch: (cause) =>
      CredentialError.make({
        cause,
        operation: "decrypt_cloudflare_api_token",
      }),
  })
  if (decrypted.needsRotation) {
    const rotated = yield* encryptApiToken(decrypted.plaintext)
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "domains.integration.rotateCredential",
      `UPDATE ${databaseTable("domain_integration")}
          SET api_token_ciphertext = ?, updated_at = ?
        WHERE id = ? AND api_token_ciphertext = ?`,
      [rotated, now, CLOUDFLARE_INTEGRATION_ID, ciphertext]
    )
  }
  return {
    ...publicIntegration(loaded.row, loaded.zones),
    apiToken: decrypted.plaintext,
  } satisfies CloudflareIntegrationCredential
})

/**
 * Saves the integration and its enabled domains. A domain left out keeps a
 * disabled row while game server domains are on it, since their records
 * live in its zone; otherwise it goes. Decided under locks, so a game server
 * domain reserved meanwhile can't lose its zone.
 */
export const saveCloudflareIntegrationEffect = Effect.fn(
  "domains.integration.save"
)(function* (input: {
  apiToken: string
  blacklistPatterns: Array<string>
  /** The enabled domains, in zones the token reaches. */
  domains: ReadonlyArray<ManagedDomain>
  enabled: boolean
  /** Zones the token can manage; kept domains must be among them. */
  reachableZoneIds: ReadonlySet<string>
  strategy: DomainAssignmentStrategy
}) {
  const database = yield* Database
  const ciphertext = yield* encryptApiToken(input.apiToken)
  const now = yield* Clock.currentTimeMillis
  yield* database.transaction("domains.integration.save", (transaction) =>
    Effect.gen(function* () {
      yield* transaction.execute(
        `INSERT INTO ${databaseTable("domain_integration")}
           (id, provider, api_token_ciphertext, blacklist_patterns, enabled,
            assignment_strategy, last_verified_at, last_error, created_at,
            updated_at)
         VALUES (?, 'cloudflare', ?, ?, ?, ?, ?, NULL, ?, ?)
         ON DUPLICATE KEY UPDATE
           api_token_ciphertext = VALUES(api_token_ciphertext),
           blacklist_patterns = VALUES(blacklist_patterns),
           enabled = VALUES(enabled),
           assignment_strategy = VALUES(assignment_strategy),
           last_verified_at = VALUES(last_verified_at),
           last_error = NULL,
           updated_at = VALUES(updated_at)`,
        [
          CLOUDFLARE_INTEGRATION_ID,
          ciphertext,
          JSON.stringify(input.blacklistPatterns),
          input.enabled,
          input.strategy,
          now,
          now,
          now,
        ]
      )
      // Locking reads: a reservation waits for this save, or this save sees it.
      const previous = yield* transaction.queryRows<DomainZoneRow>(
        `SELECT domain, zone_id, zone_name, is_default, enabled
           FROM ${databaseTable("domain_zone")}
          WHERE integration_id = ?
          FOR UPDATE`,
        [CLOUDFLARE_INTEGRATION_ID]
      )
      const assigned = yield* transaction.queryRows<
        RowDataPacket & { domain: string }
      >(`SELECT domain FROM ${databaseTable("instance_domain")} FOR SHARE`)
      const usage = new Map<string, number>()
      for (const row of assigned) {
        usage.set(row.domain, (usage.get(row.domain) ?? 0) + 1)
      }
      const requested = new Map(
        input.domains.map((domain) => [domain.domain, domain])
      )
      const requestedZones = new Set(
        input.domains.map((domain) => domain.zoneId)
      )
      const kept: Array<ManagedDomain> = []
      for (const row of previous) {
        const total = usage.get(row.domain) ?? 0
        if (total === 0) continue
        const count = `${total} game server ${total === 1 ? "domain" : "domains"}`
        const next = requested.get(row.domain)
        if (next) {
          if (next.zoneId !== row.zone_id) {
            return yield* DomainConfigurationError.make({
              message: `Delete the ${count} on ${row.domain} before moving it to another zone`,
            })
          }
          continue
        }
        if (!input.reachableZoneIds.has(row.zone_id)) {
          return yield* DomainConfigurationError.make({
            message: `This token can't manage ${row.domain}, which still has ${count}. Use a token that can, or delete them first.`,
          })
        }
        if (requestedZones.has(row.zone_id)) {
          return yield* DomainConfigurationError.make({
            message: `Delete the ${count} on ${row.domain} before using another domain in its zone`,
          })
        }
        kept.push({
          domain: row.domain,
          enabled: false,
          isDefault: false,
          zoneId: row.zone_id,
          zoneName: row.zone_name,
        })
      }
      yield* transaction.execute(
        `DELETE FROM ${databaseTable("domain_zone")}
          WHERE integration_id = ?`,
        [CLOUDFLARE_INTEGRATION_ID]
      )
      for (const domain of [...input.domains, ...kept]) {
        yield* transaction.execute(
          `INSERT INTO ${databaseTable("domain_zone")}
             (domain, integration_id, zone_id, zone_name, is_default,
              enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            domain.domain,
            CLOUDFLARE_INTEGRATION_ID,
            domain.zoneId,
            domain.zoneName,
            domain.isDefault,
            domain.enabled,
            now,
            now,
          ]
        )
      }
    })
  )
})

export const loadInstanceDomainAssignmentEffect = Effect.fn(
  "domains.assignment.load"
)(function* (id: string) {
  const database = yield* Database
  const rows = yield* database.queryRows<InstanceDomainRow>(
    "domains.assignment.load",
    `${instanceDomainSelect}
      WHERE assignment.id = ?
      LIMIT 1`,
    [id]
  )
  const row = rows[0]
  return row ? domainAssignment(row) : null
})

/** A game server's domains, primary first. */
export const loadInstanceDomainAssignmentsForInstanceEffect = Effect.fn(
  "domains.assignments.instance"
)(function* (relayId: string, instanceId: string) {
  const database = yield* Database
  const rows = yield* database.queryRows<InstanceDomainRow>(
    "domains.assignments.instance",
    `${instanceDomainSelect}
      WHERE assignment.relay_id = ? AND assignment.instance_id = ?
      ORDER BY assignment.is_primary DESC, assignment.created_at,
               assignment.id`,
    [relayId, instanceId]
  )
  return rows.map(domainAssignment)
})

export const deleteInstanceDomainAssignmentEffect = Effect.fn(
  "domains.assignment.delete"
)(function* (id: string) {
  const database = yield* Database
  yield* database.execute(
    "domains.assignment.delete",
    `DELETE FROM ${databaseTable("instance_domain")} WHERE id = ?`,
    [id]
  )
})

export const deleteRelayInstanceDomainAssignmentsEffect = Effect.fn(
  "domains.assignments.deleteRelay"
)(function* (relayId: string) {
  const database = yield* Database
  yield* database.execute(
    "domains.assignments.deleteRelay",
    `DELETE FROM ${databaseTable("instance_domain")} WHERE relay_id = ?`,
    [relayId]
  )
  yield* database.execute(
    "domains.optOuts.deleteRelay",
    `DELETE FROM ${databaseTable("instance_domain_opt_out")} WHERE relay_id = ?`,
    [relayId]
  )
})

/**
 * Gives a game server's domains to another server, as a move to a new
 * server does. Domains being removed stay with their removal. Reports how
 * many moved.
 */
export const reassignInstanceDomainsEffect = Effect.fn(
  "domains.assignments.reassign"
)(function* (
  from: { readonly instanceId: string; readonly relayId: string },
  to: { readonly instanceId: string; readonly relayId: string }
) {
  const database = yield* Database
  const result = yield* database.execute(
    "domains.assignments.reassign",
    `UPDATE ${databaseTable("instance_domain")}
        SET relay_id = ?, instance_id = ?
      WHERE relay_id = ? AND instance_id = ? AND status <> 'removing'`,
    [to.relayId, to.instanceId, from.relayId, from.instanceId]
  )
  return result.affectedRows
})

export const loadInstanceDomainOptOutEffect = Effect.fn("domains.optOut.load")(
  function* (relayId: string, instanceId: string) {
    const database = yield* Database
    const rows = yield* database.queryRows<RowDataPacket>(
      "domains.optOut.load",
      `SELECT 1 FROM ${databaseTable("instance_domain_opt_out")}
      WHERE relay_id = ? AND instance_id = ?
      LIMIT 1`,
      [relayId, instanceId]
    )
    return rows.length > 0
  }
)

export const setInstanceDomainOptOutEffect = Effect.fn("domains.optOut.set")(
  function* (relayId: string, instanceId: string, optedOut: boolean) {
    const database = yield* Database
    if (!optedOut) {
      yield* database.execute(
        "domains.optOut.clear",
        `DELETE FROM ${databaseTable("instance_domain_opt_out")}
          WHERE relay_id = ? AND instance_id = ?`,
        [relayId, instanceId]
      )
      return
    }
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "domains.optOut.save",
      `INSERT IGNORE INTO ${databaseTable("instance_domain_opt_out")}
         (relay_id, instance_id, created_at)
       VALUES (?, ?, ?)`,
      [relayId, instanceId, now]
    )
  }
)

export const loadRelayInstanceDomainAssignmentsEffect = Effect.fn(
  "domains.assignments.relay"
)(function* (relayId: string) {
  const database = yield* Database
  const rows = yield* database.queryRows<InstanceDomainRow>(
    "domains.assignments.relay",
    `${instanceDomainSelect} WHERE assignment.relay_id = ?`,
    [relayId]
  )
  return rows.map(domainAssignment)
})

/** Active domains, each game server's primary before its other domains. */
export const loadActiveInstanceDomainAssignmentsEffect = Effect.fn(
  "domains.assignments.active"
)(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<InstanceDomainRow>(
    "domains.assignments.active",
    `${instanceDomainSelect}
      WHERE assignment.status = 'active'
      ORDER BY assignment.is_primary DESC, assignment.created_at,
               assignment.id`
  )
  return rows.map(domainAssignment)
})

export const loadInstanceDomainAssignmentsEffect = Effect.fn(
  "domains.assignments.all"
)(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<InstanceDomainRow>(
    "domains.assignments.all",
    `${instanceDomainSelect}
      ORDER BY assignment.domain, assignment.vanity_label`
  )
  return rows.map(domainAssignment)
})

/** How many game server domains each domain holds. */
export const countInstanceDomainsByDomainEffect = Effect.fn(
  "domains.assignments.countByDomain"
)(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<
    RowDataPacket & { domain: string; total: number }
  >(
    "domains.assignments.countByDomain",
    `SELECT domain, COUNT(*) AS total
       FROM ${databaseTable("instance_domain")}
      GROUP BY domain`
  )
  return new Map(rows.map((row) => [row.domain, Number(row.total)]))
})

export const loadUsedVanityLabelsEffect = Effect.fn(
  "domains.assignments.usedLabels"
)(function* (domain: string, excludeId?: string) {
  const database = yield* Database
  const rows = yield* database.queryRows<
    RowDataPacket & { vanity_label: string }
  >(
    "domains.assignments.usedLabels",
    `SELECT vanity_label
       FROM ${databaseTable("instance_domain")}
      WHERE domain = ?${excludeId ? " AND id <> ?" : ""}`,
    excludeId ? [domain, excludeId] : [domain]
  )
  return new Set(rows.map((row) => row.vanity_label))
})

interface DomainReservation {
  domain: string
  id: string
  instanceId: string
  primary: boolean
  publicHost: string
  publicPort: number
  relayId: string
  srvProtocol: "tcp" | "udp" | null
  srvService: string | null
  supportsSrv: boolean
  vanityLabel: string
  /** The zone its records go in, as the domain was loaded. */
  zoneId: string
}

/**
 * Holds a name for a new domain before its records exist. A name another row
 * holds fails on the unique key rather than taking that row over.
 */
export const insertInstanceDomainAssignmentEffect = Effect.fn(
  "domains.assignment.insert"
)(function* (input: DomainReservation) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  // Only into an enabled domain still in the zone its records will go in: a
  // save that removes or moves it either waits for this row or this insert
  // finds nothing.
  const result = yield* database.execute(
    "domains.assignment.insert",
    `INSERT INTO ${databaseTable("instance_domain")}
       (id, relay_id, instance_id, is_primary, integration_id, vanity_label,
        domain, public_host, public_port, supports_srv, srv_service,
        srv_protocol, status, last_error, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?
       FROM ${databaseTable("domain_zone")}
      WHERE domain = ? AND zone_id = ? AND enabled = 1`,
    [
      input.id,
      input.relayId,
      input.instanceId,
      input.primary,
      CLOUDFLARE_INTEGRATION_ID,
      input.vanityLabel,
      input.domain,
      input.publicHost,
      input.publicPort,
      input.supportsSrv,
      input.srvService,
      input.srvProtocol,
      now,
      now,
      input.domain,
      input.zoneId,
    ]
  )
  if (result.affectedRows === 0) {
    return yield* DomainConfigurationError.make({
      message: `${input.domain} isn't taking new game server domains`,
    })
  }
})

/**
 * Holds a new name for a domain whose records were released. Locks its
 * domain's row before the assignment's, the order a save takes them in, and
 * only while the domain is still in the zone its records will go in.
 */
export const reserveInstanceDomainAssignmentEffect = Effect.fn(
  "domains.assignment.reserve"
)(function* (
  input: Omit<DomainReservation, "instanceId" | "primary" | "relayId">
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.transaction("domains.assignment.reserve", (transaction) =>
    Effect.gen(function* () {
      const zones = yield* transaction.queryRows<RowDataPacket>(
        `SELECT 1 FROM ${databaseTable("domain_zone")}
          WHERE domain = ? AND zone_id = ?
          FOR SHARE`,
        [input.domain, input.zoneId]
      )
      if (zones.length === 0) {
        return yield* DomainConfigurationError.make({
          message: `${input.domain} is no longer a configured vanity domain`,
        })
      }
      yield* transaction.execute(
        `UPDATE ${databaseTable("instance_domain")}
            SET vanity_label = ?,
                domain = ?,
                public_host = ?,
                public_port = ?,
                supports_srv = ?,
                srv_service = ?,
                srv_protocol = ?,
                address_record_id = NULL,
                address_record_type = NULL,
                srv_record_id = NULL,
                status = 'pending',
                last_error = NULL,
                updated_at = ?
          WHERE id = ?`,
        [
          input.vanityLabel,
          input.domain,
          input.publicHost,
          input.publicPort,
          input.supportsSrv,
          input.srvService,
          input.srvProtocol,
          now,
          input.id,
        ]
      )
    })
  )
})

/**
 * Marks a domain as being deleted. It keeps its row, and records Kiln
 * couldn't delete yet, until a delete finishes, and nothing re-creates it.
 */
export const markInstanceDomainRemovingEffect = Effect.fn(
  "domains.assignment.markRemoving"
)(function* (id: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "domains.assignment.markRemoving",
    `UPDATE ${databaseTable("instance_domain")}
        SET status = 'removing', is_primary = 0, updated_at = ?
      WHERE id = ?`,
    [now, id]
  )
})

/** Forgets records Kiln has deleted from Cloudflare. */
export const clearInstanceDomainRecordsEffect = Effect.fn(
  "domains.assignment.clearRecords"
)(function* (id: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "domains.assignment.clearRecords",
    `UPDATE ${databaseTable("instance_domain")}
        SET address_record_id = NULL,
            address_record_type = NULL,
            srv_record_id = NULL,
            status = IF(status = 'active', 'pending', status),
            updated_at = ?
      WHERE id = ?`,
    [now, id]
  )
})

export const activateInstanceDomainAssignmentEffect = Effect.fn(
  "domains.assignment.activate"
)(function* (input: {
  addressRecordId: string
  addressRecordType: "A" | "AAAA" | "CNAME"
  id: string
  srvRecordId: string | null
}) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "domains.assignment.activate",
    `UPDATE ${databaseTable("instance_domain")}
        SET address_record_id = ?,
            address_record_type = ?,
            srv_record_id = ?,
            status = 'active',
            last_error = NULL,
            updated_at = ?
      WHERE id = ?`,
    [
      input.addressRecordId,
      input.addressRecordType,
      input.srvRecordId,
      now,
      input.id,
    ]
  )
})

/** Makes one domain its game server's primary and demotes the rest. */
export const setInstanceDomainPrimaryEffect = Effect.fn(
  "domains.assignment.setPrimary"
)(function* (input: { id: string; instanceId: string; relayId: string }) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "domains.assignment.setPrimary",
    `UPDATE ${databaseTable("instance_domain")}
        SET is_primary = (id = ?), updated_at = ?
      WHERE relay_id = ? AND instance_id = ?`,
    [input.id, now, input.relayId, input.instanceId]
  )
})

export const updateInstanceDomainLabelEffect = Effect.fn(
  "domains.assignment.updateLabel"
)(function* (input: { domain: string; id: string; vanityLabel: string }) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "domains.assignment.updateLabel",
    `UPDATE ${databaseTable("instance_domain")}
        SET vanity_label = ?, domain = ?, status = 'active',
            last_error = NULL, updated_at = ?
      WHERE id = ?`,
    [input.vanityLabel, input.domain, now, input.id]
  )
})

export const updateInstanceDomainEndpointEffect = Effect.fn(
  "domains.assignment.updateEndpoint"
)(function* (input: {
  addressRecordType: "A" | "AAAA" | "CNAME"
  id: string
  publicHost: string
  publicPort: number
  srvProtocol: "tcp" | "udp" | null
  srvRecordId: string | null
  srvService: string | null
  supportsSrv: boolean
}) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "domains.assignment.updateEndpoint",
    `UPDATE ${databaseTable("instance_domain")}
        SET public_host = ?,
            public_port = ?,
            address_record_type = ?,
            supports_srv = ?,
            srv_service = ?,
            srv_protocol = ?,
            srv_record_id = ?,
            status = 'active',
            last_error = NULL,
            updated_at = ?
      WHERE id = ?`,
    [
      input.publicHost,
      input.publicPort,
      input.addressRecordType,
      input.supportsSrv,
      input.srvService,
      input.srvProtocol,
      input.srvRecordId,
      now,
      input.id,
    ]
  )
})

export const updateInstanceDomainAddressRecordEffect = Effect.fn(
  "domains.assignment.updateAddressRecord"
)(function* (input: {
  addressRecordId: string
  addressRecordType: "A" | "AAAA" | "CNAME"
  id: string
}) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "domains.assignment.updateAddressRecord",
    `UPDATE ${databaseTable("instance_domain")}
        SET address_record_id = ?,
            address_record_type = ?,
            last_error = NULL,
            updated_at = ?
      WHERE id = ?`,
    [input.addressRecordId, input.addressRecordType, now, input.id]
  )
})

export const recordInstanceDomainSyncErrorEffect = Effect.fn(
  "domains.assignment.recordSyncError"
)(function* (id: string, message: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "domains.assignment.recordSyncError",
    `UPDATE ${databaseTable("instance_domain")}
        SET last_error = ?, updated_at = ?
      WHERE id = ?`,
    [message.slice(0, 512), now, id]
  )
})

export const recordInstanceDomainErrorEffect = Effect.fn(
  "domains.assignment.recordError"
)(function* (id: string, message: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "domains.assignment.recordError",
    `UPDATE ${databaseTable("instance_domain")}
        SET status = 'error', last_error = ?, updated_at = ?
      WHERE id = ?`,
    [message.slice(0, 512), now, id]
  )
})

const instanceDomainSelect = `SELECT assignment.id, assignment.relay_id,
       assignment.instance_id, assignment.is_primary,
       assignment.integration_id, assignment.vanity_label, assignment.domain,
       assignment.public_host, assignment.public_port, assignment.supports_srv,
       assignment.srv_service, assignment.srv_protocol,
       assignment.address_record_id, assignment.address_record_type,
       assignment.srv_record_id, assignment.status, assignment.last_error,
       zone.zone_id
  FROM ${databaseTable("instance_domain")} assignment
  LEFT JOIN ${databaseTable("domain_zone")} zone
    ON zone.domain = assignment.domain`

function publicIntegration(
  row: DomainIntegrationRow,
  zones: ReadonlyArray<DomainZoneRow>
): DomainIntegration {
  return {
    blacklistPatterns: parseBlacklistPatterns(row.blacklist_patterns),
    domains: zones.map((zone) => ({
      domain: zone.domain,
      enabled: Boolean(zone.enabled),
      isDefault: Boolean(zone.is_default),
      zoneId: zone.zone_id,
      zoneName: zone.zone_name,
    })),
    enabled: Boolean(row.enabled),
    id: row.id,
    lastError: row.last_error,
    lastVerifiedAt: timestamp(row.last_verified_at),
    provider: row.provider,
    strategy: row.assignment_strategy,
  }
}

function domainAssignment(row: InstanceDomainRow): InstanceDomainAssignment {
  return {
    addressRecordId: row.address_record_id,
    addressRecordType: row.address_record_type,
    domain: row.domain,
    id: row.id,
    instanceId: row.instance_id,
    integrationId: row.integration_id,
    lastError: row.last_error,
    primary: Boolean(row.is_primary),
    publicHost: row.public_host,
    publicPort: row.public_port,
    relayId: row.relay_id,
    srvProtocol: row.srv_protocol,
    srvRecordId: row.srv_record_id,
    srvService: row.srv_service,
    status: row.status,
    supportsSrv: Boolean(row.supports_srv),
    vanityLabel: row.vanity_label,
    zoneId: row.zone_id,
  }
}

function parseBlacklistPatterns(value: unknown): Array<string> {
  const decoded = decodeJson(value)
  const parsed = domainBlacklistPatternsSchema.safeParse(decoded)
  return parsed.success ? parsed.data : []
}

function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  return Option.getOrNull(decodeJsonString(value))
}

function timestamp(value: number | null): string | null {
  if (value === null) return null
  const date = new Date(Number(value))
  return Number.isNaN(date.valueOf()) ? null : date.toISOString()
}

function encryptApiToken(
  apiToken: string
): Effect.Effect<string, CredentialError> {
  return Effect.try({
    try: () =>
      encryptWithKeyring(
        apiToken,
        betterAuthSecrets(),
        CLOUDFLARE_API_TOKEN_PURPOSE
      ),
    catch: (cause) =>
      CredentialError.make({
        cause,
        operation: "encrypt_cloudflare_api_token",
      }),
  })
}
