import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect, Option, Schema } from "effect"

import { Database } from "@/effect/database"
import { CredentialError, ResourceNotFoundError } from "@/effect/errors"
import { databaseTable } from "@/lib/database-config"
import { domainBlacklistPatternsSchema } from "@/lib/domain-schemas"
import { betterAuthSecrets } from "@/lib/environment"

import { decryptWithKeyring, encryptWithKeyring } from "../../keyring.mjs"

const CLOUDFLARE_INTEGRATION_ID = "cloudflare"
const CLOUDFLARE_API_TOKEN_PURPOSE = "kiln-cloudflare-api-token"
const decodeJsonString = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Unknown)
)

export interface DomainIntegration {
  blacklistPatterns: Array<string>
  domain: string
  enabled: boolean
  id: string
  lastError: string | null
  lastVerifiedAt: string | null
  provider: "cloudflare"
  zoneId: string
  zoneName: string
}

export interface CloudflareIntegrationCredential extends DomainIntegration {
  apiToken: string
}

export interface InstanceDomainAssignment {
  addressRecordId: string | null
  addressRecordType: "A" | "AAAA" | "CNAME" | null
  domain: string
  instanceId: string
  integrationId: string
  lastError: string | null
  publicHost: string
  publicPort: number
  relayId: string
  srvProtocol: "tcp" | "udp" | null
  srvRecordId: string | null
  srvService: string | null
  status: "active" | "error" | "pending"
  supportsSrv: boolean
  vanityLabel: string
}

interface DomainIntegrationRow extends RowDataPacket {
  api_token_ciphertext: string
  blacklist_patterns: unknown
  domain: string
  enabled: boolean | number
  id: string
  last_error: string | null
  last_verified_at: number | null
  provider: "cloudflare"
  zone_id: string
  zone_name: string
}

interface InstanceDomainRow extends RowDataPacket {
  address_record_id: string | null
  address_record_type: "A" | "AAAA" | "CNAME" | null
  domain: string
  instance_id: string
  integration_id: string
  last_error: string | null
  public_host: string
  public_port: number
  relay_id: string
  srv_protocol: "tcp" | "udp" | null
  srv_record_id: string | null
  srv_service: string | null
  status: "active" | "error" | "pending"
  supports_srv: boolean | number
  vanity_label: string
}

export const loadDomainIntegrationEffect = Effect.fn(
  "domains.integration.load"
)(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<DomainIntegrationRow>(
    "domains.integration.load",
    `SELECT id, provider, domain, zone_id, zone_name, api_token_ciphertext,
            blacklist_patterns, enabled, last_verified_at, last_error
       FROM ${databaseTable("domain_integration")}
      WHERE id = ?
      LIMIT 1`,
    [CLOUDFLARE_INTEGRATION_ID]
  )
  const row = rows[0]
  return row ? publicIntegration(row) : null
})

export const loadCloudflareIntegrationCredentialEffect = Effect.fn(
  "domains.integration.credential"
)(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<DomainIntegrationRow>(
    "domains.integration.credential",
    `SELECT id, provider, domain, zone_id, zone_name, api_token_ciphertext,
            blacklist_patterns, enabled, last_verified_at, last_error
       FROM ${databaseTable("domain_integration")}
      WHERE id = ?
      LIMIT 1`,
    [CLOUDFLARE_INTEGRATION_ID]
  )
  const row = rows[0]
  if (!row) {
    return yield* ResourceNotFoundError.make({
      message: "Connect Cloudflare in Infrastructure → Domains first",
      resource: "cloudflare_integration",
    })
  }
  const ciphertext = row.api_token_ciphertext
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
    ...publicIntegration(row),
    apiToken: decrypted.plaintext,
  } satisfies CloudflareIntegrationCredential
})

export const saveCloudflareIntegrationEffect = Effect.fn(
  "domains.integration.save"
)(function* (input: {
  apiToken: string
  blacklistPatterns: Array<string>
  domain: string
  enabled: boolean
  zoneId: string
  zoneName: string
}) {
  const database = yield* Database
  const ciphertext = yield* encryptApiToken(input.apiToken)
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "domains.integration.save",
    `INSERT INTO ${databaseTable("domain_integration")}
       (id, provider, domain, zone_id, zone_name, api_token_ciphertext,
        blacklist_patterns, enabled, last_verified_at, last_error,
        created_at, updated_at)
     VALUES (?, 'cloudflare', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
     ON DUPLICATE KEY UPDATE
       domain = VALUES(domain),
       zone_id = VALUES(zone_id),
       zone_name = VALUES(zone_name),
       api_token_ciphertext = VALUES(api_token_ciphertext),
       blacklist_patterns = VALUES(blacklist_patterns),
       enabled = VALUES(enabled),
       last_verified_at = VALUES(last_verified_at),
       last_error = NULL,
       updated_at = VALUES(updated_at)`,
    [
      CLOUDFLARE_INTEGRATION_ID,
      input.domain,
      input.zoneId,
      input.zoneName,
      ciphertext,
      JSON.stringify(input.blacklistPatterns),
      input.enabled,
      now,
      now,
      now,
    ]
  )
})

export const loadInstanceDomainAssignmentEffect = Effect.fn(
  "domains.assignment.load"
)(function* (relayId: string, instanceId: string) {
  const database = yield* Database
  const rows = yield* database.queryRows<InstanceDomainRow>(
    "domains.assignment.load",
    `${instanceDomainSelect}
      WHERE relay_id = ? AND instance_id = ?
      LIMIT 1`,
    [relayId, instanceId]
  )
  const row = rows[0]
  return row ? domainAssignment(row) : null
})

export const deleteInstanceDomainAssignmentEffect = Effect.fn(
  "domains.assignment.delete"
)(function* (relayId: string, instanceId: string) {
  const database = yield* Database
  yield* database.execute(
    "domains.assignment.delete",
    `DELETE FROM ${databaseTable("instance_domain")}
      WHERE relay_id = ? AND instance_id = ?`,
    [relayId, instanceId]
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
})

export const loadRelayInstanceDomainAssignmentsEffect = Effect.fn(
  "domains.assignments.relay"
)(function* (relayId: string) {
  const database = yield* Database
  const rows = yield* database.queryRows<InstanceDomainRow>(
    "domains.assignments.relay",
    `${instanceDomainSelect} WHERE relay_id = ?`,
    [relayId]
  )
  return rows.map(domainAssignment)
})

export const loadActiveInstanceDomainAssignmentsEffect = Effect.fn(
  "domains.assignments.active"
)(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<InstanceDomainRow>(
    "domains.assignments.active",
    `${instanceDomainSelect}
      WHERE status = 'active'`
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
      ORDER BY domain, vanity_label`
  )
  return rows.map(domainAssignment)
})

export const loadUsedVanityLabelsEffect = Effect.fn(
  "domains.assignments.usedLabels"
)(function* (
  domain: string,
  exclude?: { instanceId: string; relayId: string }
) {
  const database = yield* Database
  const rows = yield* database.queryRows<
    RowDataPacket & { vanity_label: string }
  >(
    "domains.assignments.usedLabels",
    `SELECT vanity_label
       FROM ${databaseTable("instance_domain")}
      WHERE domain = ?${
        exclude ? "\n        AND NOT (relay_id = ? AND instance_id = ?)" : ""
      }`,
    exclude ? [domain, exclude.relayId, exclude.instanceId] : [domain]
  )
  return new Set(rows.map((row) => row.vanity_label))
})

export const reserveInstanceDomainAssignmentEffect = Effect.fn(
  "domains.assignment.reserve"
)(function* (input: {
  domain: string
  instanceId: string
  publicHost: string
  publicPort: number
  relayId: string
  srvProtocol: "tcp" | "udp" | null
  srvService: string | null
  supportsSrv: boolean
  vanityLabel: string
}) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "domains.assignment.reserve",
    `INSERT INTO ${databaseTable("instance_domain")}
       (relay_id, instance_id, integration_id, vanity_label, domain,
        public_host, public_port, supports_srv, srv_service, srv_protocol,
        status, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
     ON DUPLICATE KEY UPDATE
       integration_id = VALUES(integration_id),
       vanity_label = VALUES(vanity_label),
       domain = VALUES(domain),
       public_host = VALUES(public_host),
       public_port = VALUES(public_port),
       supports_srv = VALUES(supports_srv),
       srv_service = VALUES(srv_service),
       srv_protocol = VALUES(srv_protocol),
       status = 'pending',
       last_error = NULL,
       updated_at = VALUES(updated_at)`,
    [
      input.relayId,
      input.instanceId,
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
    ]
  )
})

export const activateInstanceDomainAssignmentEffect = Effect.fn(
  "domains.assignment.activate"
)(function* (input: {
  addressRecordId: string
  addressRecordType: "A" | "AAAA" | "CNAME"
  instanceId: string
  relayId: string
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
      WHERE relay_id = ? AND instance_id = ?`,
    [
      input.addressRecordId,
      input.addressRecordType,
      input.srvRecordId,
      now,
      input.relayId,
      input.instanceId,
    ]
  )
})

export const updateInstanceDomainLabelEffect = Effect.fn(
  "domains.assignment.updateLabel"
)(function* (input: {
  instanceId: string
  relayId: string
  vanityLabel: string
}) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "domains.assignment.updateLabel",
    `UPDATE ${databaseTable("instance_domain")}
        SET vanity_label = ?, status = 'active', last_error = NULL,
            updated_at = ?
      WHERE relay_id = ? AND instance_id = ?`,
    [input.vanityLabel, now, input.relayId, input.instanceId]
  )
})

export const updateInstanceDomainEndpointEffect = Effect.fn(
  "domains.assignment.updateEndpoint"
)(function* (input: {
  addressRecordType: "A" | "AAAA" | "CNAME"
  instanceId: string
  publicHost: string
  publicPort: number
  relayId: string
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
      WHERE relay_id = ? AND instance_id = ?`,
    [
      input.publicHost,
      input.publicPort,
      input.addressRecordType,
      input.supportsSrv,
      input.srvService,
      input.srvProtocol,
      input.srvRecordId,
      now,
      input.relayId,
      input.instanceId,
    ]
  )
})

export const updateInstanceDomainAddressRecordEffect = Effect.fn(
  "domains.assignment.updateAddressRecord"
)(function* (input: {
  addressRecordId: string
  addressRecordType: "A" | "AAAA" | "CNAME"
  instanceId: string
  relayId: string
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
      WHERE relay_id = ? AND instance_id = ?`,
    [
      input.addressRecordId,
      input.addressRecordType,
      now,
      input.relayId,
      input.instanceId,
    ]
  )
})

export const recordInstanceDomainSyncErrorEffect = Effect.fn(
  "domains.assignment.recordSyncError"
)(function* (relayId: string, instanceId: string, message: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "domains.assignment.recordSyncError",
    `UPDATE ${databaseTable("instance_domain")}
        SET last_error = ?, updated_at = ?
      WHERE relay_id = ? AND instance_id = ?`,
    [message.slice(0, 512), now, relayId, instanceId]
  )
})

export const recordInstanceDomainErrorEffect = Effect.fn(
  "domains.assignment.recordError"
)(function* (relayId: string, instanceId: string, message: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "domains.assignment.recordError",
    `UPDATE ${databaseTable("instance_domain")}
        SET status = 'error', last_error = ?, updated_at = ?
      WHERE relay_id = ? AND instance_id = ?`,
    [message.slice(0, 512), now, relayId, instanceId]
  )
})

const instanceDomainSelect = `SELECT relay_id, instance_id, integration_id,
       vanity_label, domain, public_host, public_port, supports_srv,
       srv_service, srv_protocol, address_record_id, address_record_type,
       srv_record_id, status, last_error
  FROM ${databaseTable("instance_domain")}`

function publicIntegration(row: DomainIntegrationRow): DomainIntegration {
  return {
    blacklistPatterns: parseBlacklistPatterns(row.blacklist_patterns),
    domain: row.domain,
    enabled: Boolean(row.enabled),
    id: row.id,
    lastError: row.last_error,
    lastVerifiedAt: timestamp(row.last_verified_at),
    provider: row.provider,
    zoneId: row.zone_id,
    zoneName: row.zone_name,
  }
}

function domainAssignment(row: InstanceDomainRow): InstanceDomainAssignment {
  return {
    addressRecordId: row.address_record_id,
    addressRecordType: row.address_record_type,
    domain: row.domain,
    instanceId: row.instance_id,
    integrationId: row.integration_id,
    lastError: row.last_error,
    publicHost: row.public_host,
    publicPort: row.public_port,
    relayId: row.relay_id,
    srvProtocol: row.srv_protocol,
    srvRecordId: row.srv_record_id,
    srvService: row.srv_service,
    status: row.status,
    supportsSrv: Boolean(row.supports_srv),
    vanityLabel: row.vanity_label,
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
