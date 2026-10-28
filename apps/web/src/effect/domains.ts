import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect, Option, Schema } from "effect"

import { Database } from "@/effect/database"
import {
  CredentialError,
  DomainConfigurationError,
  ResourceNotFoundError,
} from "@/effect/errors"
import {
  claimHostnamesEffect,
  moveHostnameClaimsEffect,
  releaseUnusedHostnamesEffect,
} from "@/effect/hostname-claims"
import { handOverWebHostnamesEffect } from "@/effect/web-hostnames"
import { databaseTable } from "@/lib/database-config"
import { domainBlacklistPatternsSchema } from "@/lib/domain-schemas"
import { betterAuthSecrets } from "@/lib/environment"

import { decryptWithKeyring, encryptWithKeyring } from "../../keyring.mjs"

/** The connection an install that predates owned connections kept. */
export const PLATFORM_CONNECTION_ID = "cloudflare"
const CLOUDFLARE_API_TOKEN_PURPOSE = "kiln-cloudflare-api-token"
const decodeJsonString = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Unknown)
)
const ZonesSchema = Schema.Array(
  Schema.Struct({ id: Schema.String, name: Schema.String })
)

/**
 * A vanity domain: Kiln creates `<name>.<domain>` addresses under it for game
 * servers and apps.
 */
export interface ManagedDomain {
  /** The Cloudflare connection whose token manages its zone. */
  connectionId: string
  domain: string
  /**
   * Offered to new game servers and apps. A disabled domain still serves,
   * syncs, and renames the addresses already on it.
   */
  enabled: boolean
  /** Its owner's default; each owner has at most one. */
  isDefault: boolean
  /** Null for the platform's domains, which everyone may use. */
  ownerId: string | null
  zoneId: string
  zoneName: string
}

export interface DomainZone {
  id: string
  name: string
}

/** A Cloudflare API token someone, or the platform, connected. */
export interface DomainConnection {
  /**
   * Names nobody may take under its vanity domains, as case-insensitive
   * patterns. Only a shared (platform) connection has any.
   */
  blacklistPatterns: Array<string>
  /** Its vanity domains, the default first, then enabled ones by name. */
  domains: Array<ManagedDomain>
  id: string
  lastError: string | null
  lastVerifiedAt: string | null
  name: string
  /** Null for the platform's. */
  ownerId: string | null
  provider: "cloudflare"
  /** The zones its token reached when last checked, by name. */
  zones: Array<DomainZone>
}

export interface DomainConnectionCredential extends DomainConnection {
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
  /**
   * The name a rename is moving it to, held alongside its current one until
   * Cloudflare has it; null when no rename is under way.
   */
  next: { domain: string; vanityLabel: string } | null
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

interface DomainConnectionRow extends RowDataPacket {
  api_token_ciphertext: string
  blacklist_patterns: unknown
  id: string
  last_error: string | null
  last_verified_at: number | null
  name: string
  owner_id: string | null
  provider: "cloudflare"
  zones: unknown
}

interface DomainZoneRow extends RowDataPacket {
  domain: string
  enabled: boolean | number
  integration_id: string
  is_default: boolean | number
  owner_id: string | null
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
  next_domain: string | null
  next_vanity_label: string | null
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

const connectionColumns = `id, provider, owner_id, name, api_token_ciphertext,
       blacklist_patterns, zones, last_verified_at, last_error`
const domainZoneSelect = `SELECT zone.domain, zone.integration_id, zone.zone_id,
       zone.zone_name, zone.is_default, zone.enabled, connection.owner_id
  FROM ${databaseTable("domain_zone")} zone
  JOIN ${databaseTable("domain_integration")} connection
    ON connection.id = zone.integration_id`

/**
 * Connections, each with its vanity domains: the platform's (`null`) and
 * the named people's, or every one.
 */
export const listDomainConnectionsEffect = Effect.fn(
  "domains.connections.list"
)(function* (owners: ReadonlyArray<string | null> | "all") {
  const database = yield* Database
  const people = owners === "all" ? [] : owners.filter((id) => id !== null)
  const platform = owners === "all" || owners.includes(null)
  if (owners !== "all" && people.length === 0 && !platform) return []
  const where =
    owners === "all"
      ? ""
      : `WHERE ${[
          platform ? "connection.owner_id IS NULL" : null,
          people.length > 0
            ? `connection.owner_id IN (${people.map(() => "?").join(", ")})`
            : null,
        ]
          .filter(Boolean)
          .join(" OR ")}`
  const [rows, zones] = yield* Effect.all(
    [
      database.queryRows<DomainConnectionRow>(
        "domains.connections.list",
        `SELECT ${connectionColumns}
           FROM ${databaseTable("domain_integration")} connection
          ${where}
          ORDER BY connection.owner_id IS NOT NULL, connection.created_at,
                   connection.id`,
        people
      ),
      database.queryRows<DomainZoneRow>(
        "domains.connections.domains",
        `${domainZoneSelect}
          ${where}
          ORDER BY zone.is_default DESC, zone.enabled DESC, zone.domain`,
        people
      ),
    ],
    { concurrency: 2 }
  )
  return rows.map((row) => publicConnection(row, zones))
})

export const loadDomainConnectionEffect = Effect.fn("domains.connection.load")(
  function* (id: string) {
    const database = yield* Database
    const [rows, zones] = yield* Effect.all(
      [
        database.queryRows<DomainConnectionRow>(
          "domains.connection.load",
          `SELECT ${connectionColumns}
             FROM ${databaseTable("domain_integration")}
            WHERE id = ?
            LIMIT 1`,
          [id]
        ),
        database.queryRows<DomainZoneRow>(
          "domains.connection.domains",
          `${domainZoneSelect}
            WHERE zone.integration_id = ?
            ORDER BY zone.is_default DESC, zone.enabled DESC, zone.domain`,
          [id]
        ),
      ],
      { concurrency: 2 }
    )
    const row = rows[0]
    return row ? { connection: publicConnection(row, zones), row } : null
  }
)

/** A connection with its decrypted token, for calling Cloudflare. */
export const loadDomainConnectionCredentialEffect = Effect.fn(
  "domains.connection.credential"
)(function* (id: string) {
  const database = yield* Database
  const loaded = yield* loadDomainConnectionEffect(id)
  if (!loaded) {
    return yield* ResourceNotFoundError.make({
      message: "That Cloudflare connection was removed",
      resource: "cloudflare_connection",
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
      "domains.connection.rotateCredential",
      `UPDATE ${databaseTable("domain_integration")}
          SET api_token_ciphertext = ?, updated_at = ?
        WHERE id = ? AND api_token_ciphertext = ?`,
      [rotated, now, id, ciphertext]
    )
  }
  return {
    ...loaded.connection,
    apiToken: decrypted.plaintext,
  } satisfies DomainConnectionCredential
})

/**
 * Saves a connection and its enabled vanity domains. A domain left out keeps
 * a disabled row while game server domains are on it, since their records
 * live in its zone; otherwise it goes. Decided under locks, so a game server
 * domain reserved meanwhile can't lose its zone.
 */
export const saveDomainConnectionEffect = Effect.fn("domains.connection.save")(
  function* (input: {
    /** Omitted to keep the saved token. */
    apiToken: string | undefined
    /** Empty for a person's connection: names under it are theirs. */
    blacklistPatterns: ReadonlyArray<string>
    /** The enabled domains, in zones the token reaches. */
    domains: ReadonlyArray<Omit<ManagedDomain, "connectionId" | "ownerId">>
    id: string
    /** A new connection; an existing ID fails rather than taking it over. */
    insert: boolean
    name: string
    ownerId: string | null
    /** Zones the token can manage; kept domains must be among them. */
    zones: ReadonlyArray<DomainZone>
  }) {
    const database = yield* Database
    const ciphertext =
      input.apiToken === undefined
        ? null
        : yield* encryptApiToken(input.apiToken)
    const now = yield* Clock.currentTimeMillis
    const reachableZoneIds = new Set(input.zones.map((zone) => zone.id))
    yield* database.transaction("domains.connection.save", (transaction) =>
      Effect.gen(function* () {
        if (input.insert) {
          if (ciphertext === null) {
            return yield* DomainConfigurationError.make({
              message: "Enter a Cloudflare API token",
            })
          }
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("domain_integration")}
               (id, provider, owner_id, name, api_token_ciphertext,
                blacklist_patterns, zones, last_verified_at, last_error,
                created_at, updated_at)
             VALUES (?, 'cloudflare', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
            [
              input.id,
              input.ownerId,
              input.name,
              ciphertext,
              JSON.stringify(input.blacklistPatterns),
              JSON.stringify(input.zones),
              now,
              now,
              now,
            ]
          )
        } else {
          const result = yield* transaction.execute(
            `UPDATE ${databaseTable("domain_integration")}
                SET name = ?,
                    api_token_ciphertext = COALESCE(?, api_token_ciphertext),
                    blacklist_patterns = ?,
                    zones = ?,
                    last_verified_at = ?,
                    last_error = NULL,
                    updated_at = ?
              WHERE id = ? AND owner_id <=> ?`,
            [
              input.name,
              ciphertext,
              JSON.stringify(input.blacklistPatterns),
              JSON.stringify(input.zones),
              now,
              now,
              input.id,
              input.ownerId,
            ]
          )
          if (result.affectedRows === 0) {
            return yield* ResourceNotFoundError.make({
              message: "That Cloudflare connection was removed",
              resource: "cloudflare_connection",
            })
          }
        }
        // Locking reads: a reservation waits for this save, or this save sees it.
        const previous = yield* transaction.queryRows<DomainZoneRow>(
          `SELECT domain, integration_id, zone_id, zone_name, is_default,
                  enabled, NULL AS owner_id
             FROM ${databaseTable("domain_zone")}
            WHERE integration_id = ?
            FOR UPDATE`,
          [input.id]
        )
        const requested = new Map(
          input.domains.map((domain) => [domain.domain, domain])
        )
        // Domains are unique across connections: two can't hand out the
        // same names.
        if (requested.size > 0) {
          const taken = yield* transaction.queryRows<
            RowDataPacket & { domain: string }
          >(
            `SELECT domain FROM ${databaseTable("domain_zone")}
              WHERE integration_id <> ?
                AND domain IN (${[...requested.keys()].map(() => "?").join(", ")})
              FOR SHARE`,
            [input.id, ...requested.keys()]
          )
          const [conflict] = taken
          if (conflict) {
            return yield* DomainConfigurationError.make({
              message: `${conflict.domain} is already a vanity domain on another Cloudflare connection`,
            })
          }
        }
        const assigned = yield* transaction.queryRows<
          RowDataPacket & { domain: string }
        >(
          // A domain a rename is moving onto counts as used too.
          `SELECT zone.domain
             FROM ${databaseTable("instance_domain")} assignment
             JOIN ${databaseTable("domain_zone")} zone
               ON zone.domain = assignment.domain
               OR zone.domain = assignment.next_domain
            WHERE zone.integration_id = ?
            FOR SHARE`,
          [input.id]
        )
        // The web records it keeps stay reachable, to repoint or delete.
        const webRecords = yield* transaction.queryRows<
          RowDataPacket & { hostname: string; zone_id: string }
        >(
          `SELECT hostname, zone_id FROM ${databaseTable("web_hostname")}
            WHERE integration_id = ?
            FOR SHARE`,
          [input.id]
        )
        const stranded = webRecords.find(
          (row) => !reachableZoneIds.has(row.zone_id)
        )
        if (stranded) {
          return yield* DomainConfigurationError.make({
            message: `This token can't manage ${stranded.hostname}, which Kiln keeps a DNS record for. Use a token that can, or remove its web route first.`,
          })
        }
        const usage = new Map<string, number>()
        for (const row of assigned) {
          usage.set(row.domain, (usage.get(row.domain) ?? 0) + 1)
        }
        const requestedZones = new Set(
          input.domains.map((domain) => domain.zoneId)
        )
        const kept: Array<Omit<ManagedDomain, "connectionId" | "ownerId">> = []
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
          if (!reachableZoneIds.has(row.zone_id)) {
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
        // One default per owner, across their connections.
        if (input.domains.some((domain) => domain.isDefault)) {
          yield* transaction.execute(
            `UPDATE ${databaseTable("domain_zone")} zone
               JOIN ${databaseTable("domain_integration")} connection
                 ON connection.id = zone.integration_id
                SET zone.is_default = 0
              WHERE connection.owner_id <=> ? AND zone.integration_id <> ?`,
            [input.ownerId, input.id]
          )
        }
        yield* transaction.execute(
          `DELETE FROM ${databaseTable("domain_zone")}
            WHERE integration_id = ?`,
          [input.id]
        )
        for (const domain of [...input.domains, ...kept]) {
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("domain_zone")}
               (domain, integration_id, zone_id, zone_name, is_default,
                enabled, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              domain.domain,
              input.id,
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
  }
)

/** Remembers the zones a connection's token reaches now. */
export const updateDomainConnectionZonesEffect = Effect.fn(
  "domains.connection.updateZones"
)(function* (id: string, zones: ReadonlyArray<DomainZone>) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "domains.connection.updateZones",
    `UPDATE ${databaseTable("domain_integration")}
        SET zones = ?, last_verified_at = ?, last_error = NULL, updated_at = ?
      WHERE id = ?`,
    [JSON.stringify(zones), now, now, id]
  )
})

/**
 * Forgets a connection and its vanity domains. Refused while game server
 * domains are on them; the caller deletes its web hostnames' records first.
 */
/**
 * Refuses removing a connection whose domains still name game servers, so
 * nothing is torn down before a removal that can't finish.
 */
export const requireConnectionUnusedEffect = Effect.fn(
  "domains.connection.requireUnused"
)(function* (id: string) {
  const database = yield* Database
  const [used] = yield* database.queryRows<RowDataPacket & { total: number }>(
    "domains.connection.requireUnused",
    `SELECT COUNT(*) AS total FROM ${databaseTable("instance_domain")}
      WHERE ${connectionDomainsMatch}`,
    [id, id, id]
  )
  yield* connectionInUseFailure(Number(used?.total ?? 0))
  const [hostnames] = yield* database.queryRows<
    RowDataPacket & { total: number }
  >(
    "domains.connection.requireUnused",
    `SELECT COUNT(*) AS total FROM ${databaseTable("web_hostname")}
      WHERE integration_id = ?`,
    [id]
  )
  yield* connectionHostnamesFailure(Number(hostnames?.total ?? 0))
})

// Game server domains a connection manages, or on its vanity domains, or
// being renamed onto them.
const connectionDomainsMatch = `integration_id = ? OR domain IN (
  SELECT domain FROM ${databaseTable("domain_zone")} WHERE integration_id = ?)
  OR next_domain IN (
  SELECT domain FROM ${databaseTable("domain_zone")} WHERE integration_id = ?)`

// Web routes and app addresses whose DNS it keeps hold their names until
// they're removed, which disconnecting would let go of while they serve.
function connectionHostnamesFailure(total: number) {
  return total > 0
    ? DomainConfigurationError.make({
        message:
          total === 1
            ? "A web route or app address uses this connection. Remove it first"
            : `${total} web routes and app addresses use this connection. Remove them first`,
      })
    : Effect.void
}

function connectionInUseFailure(total: number) {
  return total > 0
    ? DomainConfigurationError.make({
        message: `Delete the ${total} game server ${total === 1 ? "domain" : "domains"} on this connection's domains first`,
      })
    : Effect.void
}

export const deleteDomainConnectionEffect = Effect.fn(
  "domains.connection.delete"
)(function* (id: string) {
  const database = yield* Database
  yield* database.transaction("domains.connection.delete", (transaction) =>
    Effect.gen(function* () {
      yield* transaction.queryRows(
        `SELECT domain FROM ${databaseTable("domain_zone")}
          WHERE integration_id = ?
          FOR UPDATE`,
        [id]
      )
      const [used] = yield* transaction.queryRows<
        RowDataPacket & { total: number }
      >(
        `SELECT COUNT(*) AS total FROM ${databaseTable("instance_domain")}
          WHERE ${connectionDomainsMatch}
          FOR SHARE`,
        [id, id, id]
      )
      yield* connectionInUseFailure(Number(used?.total ?? 0))
      // Checked again under lock: a hostname added since holds its name, and
      // may have a record only this token can delete.
      const [hostnames] = yield* transaction.queryRows<
        RowDataPacket & { total: number }
      >(
        `SELECT COUNT(*) AS total FROM ${databaseTable("web_hostname")}
          WHERE integration_id = ?
          FOR UPDATE`,
        [id]
      )
      yield* connectionHostnamesFailure(Number(hostnames?.total ?? 0))
      yield* transaction.execute(
        `DELETE FROM ${databaseTable("domain_zone")} WHERE integration_id = ?`,
        [id]
      )
      yield* transaction.execute(
        `DELETE FROM ${databaseTable("domain_integration")} WHERE id = ?`,
        [id]
      )
    })
  )
})

/** A vanity domain by name, with its owner. */
export const loadManagedDomainEffect = Effect.fn("domains.domain.load")(
  function* (domain: string) {
    const database = yield* Database
    const rows = yield* database.queryRows<DomainZoneRow>(
      "domains.domain.load",
      `${domainZoneSelect} WHERE zone.domain = ? LIMIT 1`,
      [domain]
    )
    const row = rows[0]
    return row ? managedDomain(row) : null
  }
)

/**
 * The vanity domains a resource owned by `ownerId` may use: its owner's
 * and the platform's, each owner's default first.
 */
export const listUsableVanityDomainsEffect = Effect.fn(
  "domains.domains.usable"
)(function* (ownerId: string | null) {
  const database = yield* Database
  const rows = yield* database.queryRows<DomainZoneRow>(
    "domains.domains.usable",
    `${domainZoneSelect}
      WHERE connection.owner_id IS NULL${ownerId ? " OR connection.owner_id = ?" : ""}
      ORDER BY connection.owner_id IS NULL, zone.is_default DESC,
               zone.enabled DESC, zone.domain`,
    ownerId ? [ownerId] : []
  )
  return rows.map(managedDomain)
})

/** Whether anyone has connected Cloudflare. */
export const anyDomainConnectionEffect = Effect.fn("domains.connections.any")(
  function* () {
    const database = yield* Database
    const rows = yield* database.queryRows<RowDataPacket>(
      "domains.connections.any",
      `SELECT 1 FROM ${databaseTable("domain_integration")} LIMIT 1`
    )
    return rows.length > 0
  }
)

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

/** Forgets a domain, letting go of its names. */
export const deleteInstanceDomainAssignmentEffect = Effect.fn(
  "domains.assignment.delete"
)(function* (assignment: InstanceDomainAssignment) {
  const database = yield* Database
  yield* database.transaction("domains.assignment.delete", () =>
    Effect.gen(function* () {
      yield* database.execute(
        "domains.assignment.delete",
        `DELETE FROM ${databaseTable("instance_domain")} WHERE id = ?`,
        [assignment.id]
      )
      yield* releaseUnusedHostnamesEffect(
        assignmentOwner(assignment),
        assignmentHostnames(assignment)
      )
      yield* handOverWebHostnamesEffect(assignmentHostnames(assignment))
    })
  )
})

export const deleteRelayInstanceDomainAssignmentsEffect = Effect.fn(
  "domains.assignments.deleteRelay"
)(function* (relayId: string) {
  const database = yield* Database
  yield* database.transaction("domains.assignments.deleteRelay", () =>
    Effect.gen(function* () {
      yield* database.execute(
        "domains.assignments.deleteRelay",
        `DELETE FROM ${databaseTable("instance_domain")} WHERE relay_id = ?`,
        [relayId]
      )
      yield* releaseUnusedHostnamesEffect({ relayId })
    })
  )
  yield* database.execute(
    "domains.optOuts.deleteRelay",
    `DELETE FROM ${databaseTable("instance_domain_opt_out")} WHERE relay_id = ?`,
    [relayId]
  )
})

/**
 * Marks every domain on a removed Relay for deletion, before their records
 * are deleted, so any delete that fails is finished by the DNS worker. Its
 * opt-outs go with it.
 */
export const markRelayInstanceDomainsRemovingEffect = Effect.fn(
  "domains.assignments.markRelayRemoving"
)(function* (relayId: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "domains.assignments.markRelayRemoving",
    `UPDATE ${databaseTable("instance_domain")}
        SET status = 'removing', is_primary = 0, attempts = 0,
            next_attempt_at = NULL, updated_at = ?
      WHERE relay_id = ?`,
    [now, relayId]
  )
  yield* database.execute(
    "domains.optOuts.deleteRelay",
    `DELETE FROM ${databaseTable("instance_domain_opt_out")} WHERE relay_id = ?`,
    [relayId]
  )
})

/**
 * Gives a game server's domains, and their names, to another server, as a
 * move to a new server does. Domains being removed stay with their removal.
 * Reports how many moved.
 */
export const reassignInstanceDomainsEffect = Effect.fn(
  "domains.assignments.reassign"
)(function* (
  from: { readonly instanceId: string; readonly relayId: string },
  to: { readonly instanceId: string; readonly relayId: string }
) {
  const database = yield* Database
  return yield* database.transaction("domains.assignments.reassign", () =>
    Effect.gen(function* () {
      const moving = yield* database.queryRows<InstanceDomainRow>(
        "domains.assignments.reassign",
        `SELECT assignment.*, NULL AS zone_id
           FROM ${databaseTable("instance_domain")} assignment
          WHERE relay_id = ? AND instance_id = ? AND status <> 'removing'
          FOR UPDATE`,
        [from.relayId, from.instanceId]
      )
      if (moving.length === 0) return 0
      yield* database.execute(
        "domains.assignments.reassign",
        `UPDATE ${databaseTable("instance_domain")}
            SET relay_id = ?, instance_id = ?, attempts = 0,
                next_attempt_at = NULL
          WHERE relay_id = ? AND instance_id = ? AND status <> 'removing'`,
        [to.relayId, to.instanceId, from.relayId, from.instanceId]
      )
      const names = moving.flatMap((row) =>
        assignmentHostnames(domainAssignment(row))
      )
      // A web route on one of these names holds it too; a name has one
      // owner, so it moves along.
      yield* database.execute(
        "domains.assignments.reassign",
        `UPDATE ${databaseTable("web_hostname")}
            SET relay_id = ?, resource_id = ?, attempts = 0,
                next_attempt_at = NULL
          WHERE relay_id = ? AND resource_type = 'instance'
            AND resource_id = ? AND status <> 'removing'
            AND hostname IN (${names.map(() => "?").join(", ")})`,
        [to.relayId, to.instanceId, from.relayId, from.instanceId, ...names]
      )
      yield* moveHostnameClaimsEffect(
        {
          relayId: from.relayId,
          resourceId: from.instanceId,
          resourceType: "instance",
        },
        {
          relayId: to.relayId,
          resourceId: to.instanceId,
          resourceType: "instance",
        },
        names
      )
      return moving.length
    })
  )
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

interface DomainReservation {
  /** The connection whose token manages the domain's zone. */
  connectionId: string
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
 * Holds a name for a new domain before its records exist, claiming it in the
 * same transaction, so a name another game server or app holds fails rather
 * than being taken over.
 */
export const insertInstanceDomainAssignmentEffect = Effect.fn(
  "domains.assignment.insert"
)(function* (input: DomainReservation) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.transaction("domains.assignment.insert", () =>
    Effect.gen(function* () {
      yield* claimHostnamesEffect(
        {
          relayId: input.relayId,
          resourceId: input.instanceId,
          resourceType: "instance",
        },
        [`${input.vanityLabel}.${input.domain}`]
      )
      // Only into an enabled domain still in the zone its records will go
      // in: a save that removes or moves it either waits for this row or
      // this insert finds nothing.
      const result = yield* database.execute(
        "domains.assignment.insert",
        `INSERT INTO ${databaseTable("instance_domain")}
           (id, relay_id, instance_id, is_primary, integration_id,
            vanity_label, domain, public_host, public_port, supports_srv,
            srv_service, srv_protocol, status, last_error, created_at,
            updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?
           FROM ${databaseTable("domain_zone")}
          WHERE domain = ? AND zone_id = ? AND integration_id = ?
            AND enabled = 1`,
        [
          input.id,
          input.relayId,
          input.instanceId,
          input.primary,
          input.connectionId,
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
          input.connectionId,
        ]
      )
      if (result.affectedRows === 0) {
        return yield* DomainConfigurationError.make({
          message: `${input.domain} isn't taking new game server domains`,
        })
      }
    })
  )
})

/**
 * Gives a domain whose records were released a new name, claiming it and
 * letting go of the old ones in the same transaction, which also finishes
 * any rename it was in. Locks its domain's row before the assignment's, the
 * order a save takes them in, and only while the domain is still in the
 * zone, and on the connection, its records will go in. The connection moves
 * with it, so later syncs and the delete use the token that made them.
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
          WHERE domain = ? AND zone_id = ? AND integration_id = ?
          FOR SHARE`,
        [input.domain, input.zoneId, input.connectionId]
      )
      if (zones.length === 0) {
        return yield* DomainConfigurationError.make({
          message: `${input.domain} is no longer a configured vanity domain`,
        })
      }
      const current = yield* lockAssignmentEffect(input.id)
      if (current.status === "removing") {
        return yield* DomainConfigurationError.make({
          message: "The domain is being deleted",
        })
      }
      yield* claimHostnamesEffect(assignmentOwner(current), [
        `${input.vanityLabel}.${input.domain}`,
      ])
      yield* transaction.execute(
        `UPDATE ${databaseTable("instance_domain")}
            SET vanity_label = ?,
                domain = ?,
                next_vanity_label = NULL,
                next_domain = NULL,
                integration_id = ?,
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
          input.connectionId,
          input.publicHost,
          input.publicPort,
          input.supportsSrv,
          input.srvService,
          input.srvProtocol,
          now,
          input.id,
        ]
      )
      const previous = assignmentHostnames(current).filter(
        (hostname) => hostname !== `${input.vanityLabel}.${input.domain}`
      )
      yield* releaseUnusedHostnamesEffect(assignmentOwner(current), previous)
      yield* handOverWebHostnamesEffect(previous)
    })
  )
})

/**
 * Starts renaming a domain: claims the new name and records it beside the
 * current one, which stays held until Cloudflare has the new name, so a
 * rename cut short by a failure or a restart can always be finished. One
 * rename at a time: an unfinished one must finish first, so no name its
 * records may be under is let go early. Only onto a domain still
 * configured; removing it waits for this, then sees the rename.
 */
export const beginInstanceDomainRenameEffect = Effect.fn(
  "domains.assignment.beginRename"
)(function* (input: { domain: string; id: string; vanityLabel: string }) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.transaction("domains.assignment.beginRename", () =>
    Effect.gen(function* () {
      const zones = yield* database.queryRows<RowDataPacket>(
        "domains.assignment.beginRename",
        `SELECT 1 FROM ${databaseTable("domain_zone")}
          WHERE domain = ?
          FOR SHARE`,
        [input.domain]
      )
      if (zones.length === 0) {
        return yield* DomainConfigurationError.make({
          message: `${input.domain} is no longer a configured vanity domain`,
        })
      }
      const current = yield* lockAssignmentEffect(input.id)
      if (
        current.next &&
        (current.next.domain !== input.domain ||
          current.next.vanityLabel !== input.vanityLabel)
      ) {
        return yield* DomainConfigurationError.make({
          message: `Finish renaming to ${current.next.vanityLabel}.${current.next.domain} first`,
        })
      }
      yield* claimHostnamesEffect(assignmentOwner(current), [
        `${input.vanityLabel}.${input.domain}`,
      ])
      yield* database.execute(
        "domains.assignment.beginRename",
        `UPDATE ${databaseTable("instance_domain")}
            SET next_vanity_label = ?, next_domain = ?, attempts = 0,
                next_attempt_at = NULL, updated_at = ?
          WHERE id = ?`,
        [input.vanityLabel, input.domain, now, input.id]
      )
    })
  )
})

/**
 * Takes a renamed domain's new name as its own once Cloudflare's records
 * have it, letting go of the old one.
 */
export const finishInstanceDomainRenameEffect = Effect.fn(
  "domains.assignment.finishRename"
)(function* (id: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.transaction("domains.assignment.finishRename", () =>
    Effect.gen(function* () {
      const current = yield* lockAssignmentEffect(id)
      if (!current.next) return
      yield* database.execute(
        "domains.assignment.finishRename",
        `UPDATE ${databaseTable("instance_domain")}
            SET vanity_label = next_vanity_label, domain = next_domain,
                next_vanity_label = NULL, next_domain = NULL,
                last_error = NULL, attempts = 0, next_attempt_at = NULL,
                updated_at = ?
          WHERE id = ?`,
        [now, id]
      )
      const previous = [`${current.vanityLabel}.${current.domain}`]
      yield* releaseUnusedHostnamesEffect(assignmentOwner(current), previous)
      yield* handOverWebHostnamesEffect(previous)
    })
  )
})

const lockAssignmentEffect = Effect.fnUntraced(function* (id: string) {
  const database = yield* Database
  const [row] = yield* database.queryRows<InstanceDomainRow>(
    "domains.assignment.lock",
    `SELECT assignment.*, NULL AS zone_id
       FROM ${databaseTable("instance_domain")} assignment
      WHERE id = ?
      FOR UPDATE`,
    [id]
  )
  if (!row) {
    return yield* DomainConfigurationError.make({
      message: "The domain was removed",
    })
  }
  return domainAssignment(row)
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
        SET status = 'removing', is_primary = 0, attempts = 0,
            next_attempt_at = NULL, updated_at = ?
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
            attempts = 0,
            next_attempt_at = NULL,
            updated_at = ?
      WHERE id = ? AND status <> 'removing'`,
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
            attempts = 0,
            next_attempt_at = NULL,
            updated_at = ?
      WHERE id = ? AND status <> 'removing'`,
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

/** Clears the error of a domain found in step again. */
export const clearInstanceDomainErrorEffect = Effect.fn(
  "domains.assignment.clearError"
)(function* (id: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "domains.assignment.clearError",
    `UPDATE ${databaseTable("instance_domain")}
        SET last_error = NULL, attempts = 0, next_attempt_at = NULL,
            updated_at = ?
      WHERE id = ? AND status = 'active' AND next_domain IS NULL`,
    [now, id]
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
      WHERE id = ? AND status <> 'removing'`,
    [message.slice(0, 512), now, id]
  )
})

const instanceDomainSelect = `SELECT assignment.id, assignment.relay_id,
       assignment.instance_id, assignment.is_primary,
       assignment.integration_id, assignment.vanity_label, assignment.domain,
       assignment.next_vanity_label, assignment.next_domain,
       assignment.public_host, assignment.public_port, assignment.supports_srv,
       assignment.srv_service, assignment.srv_protocol,
       assignment.address_record_id, assignment.address_record_type,
       assignment.srv_record_id, assignment.status, assignment.last_error,
       zone.zone_id
  FROM ${databaseTable("instance_domain")} assignment
  LEFT JOIN ${databaseTable("domain_zone")} zone
    ON zone.domain = assignment.domain`

/** The game server a domain's names belong to. */
export function assignmentOwner(assignment: {
  readonly instanceId: string
  readonly relayId: string
}) {
  return {
    relayId: assignment.relayId,
    resourceId: assignment.instanceId,
    resourceType: "instance" as const,
  }
}

/** A domain's name, and the one a rename is moving it to. */
export function assignmentHostnames(
  assignment: Pick<InstanceDomainAssignment, "domain" | "next" | "vanityLabel">
): Array<string> {
  return [
    `${assignment.vanityLabel}.${assignment.domain}`,
    ...(assignment.next
      ? [`${assignment.next.vanityLabel}.${assignment.next.domain}`]
      : []),
  ]
}

/**
 * Game servers with domain work due: domains to make records for, finish
 * renaming, or delete, or ones that failed, once their retry is due.
 */
export const listDueInstanceDomainsEffect = Effect.fn(
  "domains.assignments.due"
)(function* (now: number) {
  const database = yield* Database
  const rows = yield* database.queryRows<
    RowDataPacket & { instance_id: string; relay_id: string }
  >(
    "domains.assignments.due",
    `SELECT DISTINCT relay_id, instance_id
       FROM ${databaseTable("instance_domain")}
      WHERE ${assignmentNeedsWork}
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      LIMIT 25`,
    [now]
  )
  return rows.map((row) => ({
    instanceId: row.instance_id,
    relayId: row.relay_id.trim(),
  }))
})

/** When the next domain still waiting on work is due, if any is. */
export const nextInstanceDomainAttemptEffect = Effect.fn(
  "domains.assignments.next"
)(function* () {
  const database = yield* Database
  const [row] = yield* database.queryRows<
    RowDataPacket & { next: number | null }
  >(
    "domains.assignments.next",
    `SELECT MIN(COALESCE(next_attempt_at, 0)) AS next
       FROM ${databaseTable("instance_domain")}
      WHERE ${assignmentNeedsWork}`
  )
  return row?.next === null || row?.next === undefined ? null : Number(row.next)
})

/** Makes every domain still waiting on work due now, as Sync does. */
export const retryInstanceDomainsNowEffect = Effect.fn(
  "domains.assignments.retryNow"
)(function* () {
  const database = yield* Database
  yield* database.execute(
    "domains.assignments.retryNow",
    `UPDATE ${databaseTable("instance_domain")}
        SET next_attempt_at = NULL
      WHERE ${assignmentNeedsWork}`
  )
})

/**
 * Puts off a game server's domains that still need work after an attempt,
 * each time twice as long, up to an hour.
 */
export const deferInstanceDomainsEffect = Effect.fn(
  "domains.assignments.defer"
)(function* (relayId: string, instanceId: string, now: number) {
  const database = yield* Database
  yield* database.execute(
    "domains.assignments.defer",
    `UPDATE ${databaseTable("instance_domain")}
          SET next_attempt_at = ? + LEAST(3600000, 30000 * POW(2, attempts)),
              attempts = LEAST(attempts + 1, 60)
        WHERE relay_id = ? AND instance_id = ? AND ${assignmentNeedsWork}`,
    [now, relayId, instanceId]
  )
})

// An active domain with an error is one whose records didn't follow its
// game server's endpoint.
const assignmentNeedsWork = `(status IN ('pending', 'error', 'removing')
  OR next_domain IS NOT NULL OR last_error IS NOT NULL)`

function publicConnection(
  row: DomainConnectionRow,
  zones: ReadonlyArray<DomainZoneRow>
): DomainConnection {
  return {
    blacklistPatterns: parseBlacklistPatterns(row.blacklist_patterns),
    domains: zones
      .filter((zone) => zone.integration_id === row.id)
      .map(managedDomain),
    id: row.id,
    lastError: row.last_error,
    lastVerifiedAt: timestamp(row.last_verified_at),
    name: row.name,
    ownerId: row.owner_id,
    provider: row.provider,
    zones: parseZones(row.zones),
  }
}

function managedDomain(zone: DomainZoneRow): ManagedDomain {
  return {
    connectionId: zone.integration_id,
    domain: zone.domain,
    enabled: Boolean(zone.enabled),
    isDefault: Boolean(zone.is_default),
    ownerId: zone.owner_id,
    zoneId: zone.zone_id,
    zoneName: zone.zone_name,
  }
}

function parseZones(value: unknown): Array<DomainZone> {
  return Schema.decodeUnknownOption(ZonesSchema)(decodeJson(value)).pipe(
    Option.map((zones) => zones.map((zone) => ({ ...zone }))),
    Option.getOrElse((): Array<DomainZone> => [])
  )
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
    next:
      row.next_domain && row.next_vanity_label
        ? { domain: row.next_domain, vanityLabel: row.next_vanity_label }
        : null,
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
