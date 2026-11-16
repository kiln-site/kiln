import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect, Option, Schema } from "effect"
import { z } from "zod"

import {
  relayInstanceNameSchema,
  relayTailscaleDomainSchema,
  tunnelIdSchema,
} from "@workspace/contracts"

import { Database, type DatabaseTransaction } from "@/effect/database"
import { CredentialError, ResourceNotFoundError } from "@/effect/errors"
import { databaseTable } from "@/lib/database-config"
import { betterAuthSecrets } from "@/lib/environment"

import { decryptWithKeyring, encryptWithKeyring } from "../../keyring.mjs"

const TAILSCALE_OAUTH_SECRET_PURPOSE = "kiln-tailscale-oauth-client-secret"
const stringArraySchema = z.array(z.string().min(1)).max(128)
const decodeJsonString = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Unknown)
)

export interface TailscaleIntegration {
  clientId: string
  lastError: string | null
  lastSyncedAt: string | null
  scopes: Array<string>
  tags: Array<string>
}

export interface TailscaleOAuthCredential {
  clientId: string
  clientSecret: string
  scopes: Array<string>
  tags: Array<string>
}

export interface TunnelDefinition {
  /** The Brick its gateways run, by source; none for Kiln's own `tailscale`. */
  brickSource: string | null
  cleanup: TunnelCleanup | null
  /** Its TLDs, in order: the first is the one generated names are under. */
  domains: Array<string>
  id: string
  integration: TailscaleIntegration | null
  name: string
  ownerId: string | null
}

export interface TunnelCleanup {
  attempts: number
  lastError: string | null
  nextAttemptAt: string | null
  pendingRelays: number
  requestedAt: string
}

interface TunnelRow extends RowDataPacket {
  brick_source: string | null
  cleanup_attempts: number
  cleanup_last_error: string | null
  cleanup_next_attempt_at: number | null
  cleanup_pending_relays: number | string
  deletion_requested_at: number | null
  id: string
  name: string
  oauth_client_id: string | null
  oauth_client_secret_ciphertext: string | null
  oauth_last_error: string | null
  oauth_last_synced_at: number | null
  oauth_scopes: unknown
  oauth_tags: unknown
  owner_id: string | null
}

/**
 * The Relays each network is on, by network: what Hearth recorded when it
 * last saved it.
 */
export const tunnelRelaysEffect = Effect.fn("tunnels.relays")(function* (
  networkIds: ReadonlyArray<string>
) {
  const relays = new Map<string, Array<string>>()
  if (networkIds.length === 0) return relays
  const database = yield* Database
  const rows = yield* database.queryRows<
    RowDataPacket & { tunnel_id: string; relay_id: string }
  >(
    "tunnel_relays",
    `SELECT tunnel_id, relay_id
       FROM ${databaseTable("tunnel_gateway")}
      WHERE tunnel_id IN (${networkIds.map(() => "?").join(", ")})`,
    [...networkIds]
  )
  for (const row of rows) {
    relays.set(row.tunnel_id, [
      ...(relays.get(row.tunnel_id) ?? []),
      row.relay_id,
    ])
  }
  return relays
})

export const loadTunnelDefinitionsEffect = Effect.fn("tunnels.load")(
  function* () {
    const database = yield* Database
    const rows = yield* database.queryRows<TunnelRow>(
      "tunnels.load",
      `SELECT tunnel.id, tunnel.name, tunnel.owner_id, tunnel.brick_source,
            tunnel.oauth_client_id, oauth_client_secret_ciphertext,
            oauth_scopes, oauth_tags, oauth_last_synced_at, oauth_last_error,
            deletion_requested_at, cleanup_attempts,
            cleanup_next_attempt_at, cleanup_last_error,
            (SELECT COUNT(*)
               FROM ${databaseTable("tunnel_gateway")} gateway
              WHERE gateway.tunnel_id = tunnel.id) AS cleanup_pending_relays
       FROM ${databaseTable("tunnel")} tunnel
      ORDER BY tunnel.name, tunnel.id`
    )
    const domains = yield* database.queryRows<
      RowDataPacket & { domain: string; tunnel_id: string }
    >(
      "tunnels.domains",
      `SELECT tunnel_id, domain FROM ${databaseTable("domain")}
        WHERE provider = 'tunnel'
        ORDER BY tunnel_id, position, domain`
    )
    const domainsOf = (id: string) =>
      domains
        .filter((row) => row.tunnel_id === id)
        .map((row) => relayTailscaleDomainSchema.parse(row.domain))
    return rows.map((row): TunnelDefinition => ({
      brickSource: row.brick_source,
      cleanup: cleanupState(row),
      domains: domainsOf(row.id),
      id: tunnelIdSchema.parse(row.id),
      integration: publicIntegration(row),
      name: relayInstanceNameSchema.parse(row.name),
      ownerId: row.owner_id,
    }))
  }
)

export const createTunnelDefinitionEffect = Effect.fn("tunnels.create")(
  function* (
    definition: Omit<TunnelDefinition, "cleanup" | "integration" | "ownerId">,
    credential: Omit<TailscaleOAuthCredential, "clientSecret">,
    clientSecret: string,
    ownerId: string
  ) {
    const database = yield* Database
    const ciphertext = yield* encryptTailscaleClientSecretEffect(clientSecret)
    const now = yield* Clock.currentTimeMillis
    yield* database.transaction("tunnels.create", (transaction) =>
      Effect.gen(function* () {
        yield* transaction.execute(
          `INSERT INTO ${databaseTable("tunnel")}
           (id, name, brick_source, owner_id, oauth_client_id,
            oauth_client_secret_ciphertext, oauth_scopes, oauth_tags,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            definition.id,
            definition.name,
            definition.brickSource,
            ownerId,
            credential.clientId,
            ciphertext,
            JSON.stringify(credential.scopes),
            JSON.stringify(credential.tags),
            now,
            now,
          ]
        )
        yield* replaceTunnelDomains(transaction, definition)
      })
    )
  }
)

export const saveTunnelDefinitionEffect = Effect.fn("tunnels.save")(function* (
  definition: TunnelDefinition,
  ownerId: string
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.transaction("tunnels.save", (transaction) =>
    Effect.gen(function* () {
      const existing = yield* transaction.queryRows<RowDataPacket>(
        `SELECT id
         FROM ${databaseTable("tunnel")}
        WHERE id = ?
        LIMIT 1
          FOR UPDATE`,
        [definition.id]
      )
      if (existing.length > 0) {
        yield* transaction.execute(
          `UPDATE ${databaseTable("tunnel")}
              SET name = ?, updated_at = ?
            WHERE id = ?`,
          [definition.name, now, definition.id]
        )
        yield* replaceTunnelDomains(transaction, definition)
        return
      }
      yield* transaction.execute(
        `INSERT INTO ${databaseTable("tunnel")}
         (id, name, brick_source, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
        [
          definition.id,
          definition.name,
          definition.brickSource,
          ownerId,
          now,
          now,
        ]
      )
      yield* replaceTunnelDomains(transaction, definition)
    })
  )
})

export const saveTunnelIntegrationEffect = Effect.fn(
  "tunnels.integration.save"
)(function* (
  id: string,
  credential: Omit<TailscaleOAuthCredential, "clientSecret">,
  clientSecret: string
) {
  const database = yield* Database
  const ciphertext = yield* encryptTailscaleClientSecretEffect(clientSecret)
  const now = yield* Clock.currentTimeMillis
  const result = yield* database.execute(
    "tunnels.integration.save",
    `UPDATE ${databaseTable("tunnel")}
        SET oauth_client_id = ?,
            oauth_client_secret_ciphertext = ?,
            oauth_scopes = ?,
            oauth_tags = ?,
            oauth_last_synced_at = NULL,
            oauth_last_error = NULL,
            updated_at = ?
      WHERE id = ?`,
    [
      credential.clientId,
      ciphertext,
      JSON.stringify(credential.scopes),
      JSON.stringify(credential.tags),
      now,
      id,
    ]
  )
  if (result.affectedRows === 0) {
    return yield* ResourceNotFoundError.make({
      resource: "tunnel",
      message: "Tunnel not found",
    })
  }
})

export const loadTunnelCredentialEffect = Effect.fn("tunnels.integration.load")(
  function* (id: string) {
    const database = yield* Database
    const rows = yield* database.queryRows<TunnelRow>(
      "tunnels.integration.load",
      `SELECT id, oauth_client_id,
            oauth_client_secret_ciphertext, oauth_scopes, oauth_tags,
            oauth_last_synced_at, oauth_last_error
       FROM ${databaseTable("tunnel")}
      WHERE id = ?
      LIMIT 1`,
      [id]
    )
    const row = rows[0]
    if (!row?.oauth_client_id || !row.oauth_client_secret_ciphertext) {
      return yield* ResourceNotFoundError.make({
        resource: "tailscale_oauth_credential",
        message: "Connect Kiln to Tailscale first",
      })
    }
    const ciphertext = row.oauth_client_secret_ciphertext
    const decrypted = yield* Effect.try({
      try: () =>
        decryptWithKeyring(
          ciphertext,
          betterAuthSecrets(),
          TAILSCALE_OAUTH_SECRET_PURPOSE
        ),
      catch: (cause) =>
        CredentialError.make({
          operation: "decrypt_tailscale_oauth_secret",
          cause,
        }),
    })
    if (decrypted.needsRotation) {
      const rotated = yield* Effect.try({
        try: () =>
          encryptWithKeyring(
            decrypted.plaintext,
            betterAuthSecrets(),
            TAILSCALE_OAUTH_SECRET_PURPOSE
          ),
        catch: (cause) =>
          CredentialError.make({
            operation: "rotate_tailscale_oauth_secret",
            cause,
          }),
      })
      const now = yield* Clock.currentTimeMillis
      yield* database.execute(
        "tunnels.integration.rotate",
        `UPDATE ${databaseTable("tunnel")}
          SET oauth_client_secret_ciphertext = ?, updated_at = ?
        WHERE id = ? AND oauth_client_secret_ciphertext = ?`,
        [rotated, now, id, ciphertext]
      )
    }
    return {
      clientId: row.oauth_client_id,
      clientSecret: decrypted.plaintext,
      scopes: parseStringArray(row.oauth_scopes),
      tags: parseStringArray(row.oauth_tags),
    } satisfies TailscaleOAuthCredential
  }
)

export const recordTunnelSyncEffect = Effect.fn(
  "tunnels.integration.recordSync"
)(function* (id: string, error: string | null) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  if (error) {
    yield* database.execute(
      "tunnels.integration.recordSyncError",
      `UPDATE ${databaseTable("tunnel")}
          SET oauth_last_error = ?, updated_at = ?
        WHERE id = ?`,
      [error.slice(0, 512), now, id]
    )
    return
  }
  yield* database.execute(
    "tunnels.integration.recordSyncSuccess",
    `UPDATE ${databaseTable("tunnel")}
        SET oauth_last_synced_at = ?,
            oauth_last_error = NULL,
            updated_at = ?
      WHERE id = ?`,
    [now, now, id]
  )
})

export const removeTunnelDefinitionEffect = Effect.fn("tunnels.remove")(
  function* (id: string) {
    const database = yield* Database
    // Its gateways' rows, TLDs and names go with it.
    yield* database.execute(
      "tunnels.remove",
      `DELETE FROM ${databaseTable("tunnel")} WHERE id = ?`,
      [id]
    )
  }
)

// A tunnel's TLDs, in its order. A TLD another tunnel has fails the
// transaction, as each is unique.
function replaceTunnelDomains(
  transaction: DatabaseTransaction,
  definition: Pick<TunnelDefinition, "domains" | "id">
) {
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    yield* transaction.execute(
      `DELETE FROM ${databaseTable("domain")}
        WHERE provider = 'tunnel' AND tunnel_id = ?`,
      [definition.id]
    )
    for (const [position, domain] of definition.domains.entries()) {
      yield* transaction.execute(
        `INSERT INTO ${databaseTable("domain")}
           (domain, provider, tunnel_id, position, is_default, enabled,
            created_at, updated_at)
         VALUES (?, 'tunnel', ?, ?, ?, 1, ?, ?)`,
        [domain, definition.id, position, position === 0, now, now]
      )
    }
  })
}

function publicIntegration(row: TunnelRow): TailscaleIntegration | null {
  if (!row.oauth_client_id || !row.oauth_client_secret_ciphertext) return null
  return {
    clientId: row.oauth_client_id,
    lastError: row.oauth_last_error,
    lastSyncedAt: timestamp(row.oauth_last_synced_at),
    scopes: parseStringArray(row.oauth_scopes),
    tags: parseStringArray(row.oauth_tags),
  }
}

function cleanupState(row: TunnelRow): TunnelCleanup | null {
  const requestedAt = timestamp(row.deletion_requested_at)
  if (!requestedAt) return null
  return {
    attempts: row.cleanup_attempts,
    lastError: row.cleanup_last_error,
    nextAttemptAt: timestamp(row.cleanup_next_attempt_at),
    pendingRelays: Number(row.cleanup_pending_relays),
    requestedAt,
  }
}

function encryptTailscaleClientSecretEffect(clientSecret: string) {
  return Effect.try({
    try: () =>
      encryptWithKeyring(
        clientSecret,
        betterAuthSecrets(),
        TAILSCALE_OAUTH_SECRET_PURPOSE
      ),
    catch: (cause) =>
      CredentialError.make({
        operation: "encrypt_tailscale_oauth_secret",
        cause,
      }),
  })
}

function parseStringArray(value: unknown): Array<string> {
  const decoded = decodeJson(value)
  const parsed = stringArraySchema.safeParse(decoded)
  if (!parsed.success) return []
  return parsed.data
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
