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
              LOCK IN SHARE MODE`,
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
             FROM ${databaseTable("instance_address")} assignment
             JOIN ${databaseTable("domain_zone")} zone
               ON zone.domain = assignment.vanity_domain
               OR zone.domain = assignment.next_vanity_domain
            WHERE zone.integration_id = ? AND assignment.game = 1
            LOCK IN SHARE MODE`,
          [input.id]
        )
        // The web records it keeps stay reachable, to repoint or delete.
        const webRecords = yield* transaction.queryRows<
          RowDataPacket & { hostname: string; zone_id: string }
        >(
          `SELECT hostname, zone_id FROM ${databaseTable("instance_address")}
            WHERE integration_id = ? AND ${webHostnameRows}
              AND zone_id IS NOT NULL
            LOCK IN SHARE MODE`,
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
    `SELECT COUNT(*) AS total FROM ${databaseTable("instance_address")}
      WHERE ${connectionDomainsMatch}`,
    [id, id, id]
  )
  yield* connectionInUseFailure(Number(used?.total ?? 0))
  const [hostnames] = yield* database.queryRows<
    RowDataPacket & { total: number }
  >(
    "domains.connection.requireUnused",
    `SELECT COUNT(*) AS total FROM ${databaseTable("instance_address")}
      WHERE integration_id = ? AND ${webHostnameRows}`,
    [id]
  )
  yield* connectionHostnamesFailure(Number(hostnames?.total ?? 0))
})

// Game server domains a connection manages, or on its vanity domains, or
// being renamed onto them.
const connectionDomainsMatch = `game = 1 AND (integration_id = ?
  OR vanity_domain IN (
  SELECT domain FROM ${databaseTable("domain_zone")} WHERE integration_id = ?)
  OR next_vanity_domain IN (
  SELECT domain FROM ${databaseTable("domain_zone")} WHERE integration_id = ?))`

// The rows of the address table that are web hostnames: every one that
// isn't only a game server's address (`effect/addresses.ts`).
const webHostnameRows = "(game = 0 OR routed = 1)"

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
        `SELECT COUNT(*) AS total FROM ${databaseTable("instance_address")}
          WHERE ${connectionDomainsMatch}
          LOCK IN SHARE MODE`,
        [id, id, id]
      )
      yield* connectionInUseFailure(Number(used?.total ?? 0))
      // Checked again under lock: a hostname added since holds its name, and
      // may have a record only this token can delete.
      const [hostnames] = yield* transaction.queryRows<
        RowDataPacket & { total: number }
      >(
        `SELECT COUNT(*) AS total FROM ${databaseTable("instance_address")}
          WHERE integration_id = ? AND ${webHostnameRows}
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
