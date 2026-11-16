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

export interface TailnetDefinition {
  cleanup: TailnetCleanup | null
  /** Its TLDs, in order: the first is the one generated names are under. */
  domains: Array<string>
  id: string
  integration: TailscaleIntegration | null
  name: string
}

export interface TailnetCleanup {
  attempts: number
  lastError: string | null
  nextAttemptAt: string | null
  pendingRelays: number
  requestedAt: string
}

interface TailnetRow extends RowDataPacket {
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
}

/**
 * The Relays each network is on, by network: what Hearth recorded when it
 * last saved it.
 */
export const tailnetRelaysEffect = Effect.fn(
  "tailnets.relays"
)(function* (networkIds: ReadonlyArray<string>) {
  const relays = new Map<string, Array<string>>()
  if (networkIds.length === 0) return relays
  const database = yield* Database
  const rows = yield* database.queryRows<
    RowDataPacket & { tailnet_id: string; relay_id: string }
  >(
    "tailnet_relays",
    `SELECT tailnet_id, relay_id
       FROM ${databaseTable("tunnel")}
      WHERE tailnet_id IN (${networkIds.map(() => "?").join(", ")})`,
    [...networkIds]
  )
  for (const row of rows) {
    relays.set(row.tailnet_id, [
      ...(relays.get(row.tailnet_id) ?? []),
      row.relay_id,
    ])
  }
  return relays
})

export const loadTailnetDefinitionsEffect = Effect.fn(
  "tailnets.load"
)(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<TailnetRow>(
    "tailnets.load",
    `SELECT tailnet.id, tailnet_group.name,
            tailnet.oauth_client_id, oauth_client_secret_ciphertext,
            oauth_scopes, oauth_tags, oauth_last_synced_at, oauth_last_error,
            deletion_requested_at, cleanup_attempts,
            cleanup_next_attempt_at, cleanup_last_error,
            (SELECT COUNT(*)
               FROM ${databaseTable("tunnel")} tunnel
              WHERE tunnel.tailnet_id = tailnet.id) AS cleanup_pending_relays
       FROM ${databaseTable("tailnet")} tailnet
       JOIN ${databaseTable("instance_group")} tailnet_group
         ON tailnet_group.id = tailnet.id
      ORDER BY tailnet_group.name, tailnet.id`
  )
  const domains = yield* database.queryRows<
    RowDataPacket & { domain: string; tailnet_id: string }
  >(
    "tailnets.domains",
    `SELECT tailnet_id, domain FROM ${databaseTable("tailnet_domain")}
      ORDER BY tailnet_id, position, domain`
  )
  const domainsOf = (id: string) =>
    domains
      .filter((row) => row.tailnet_id === id)
      .map((row) => relayTailscaleDomainSchema.parse(row.domain))
  return rows.map((row) => ({
    cleanup: cleanupState(row),
    domains: domainsOf(row.id),
    id: tunnelIdSchema.parse(row.id),
    integration: publicIntegration(row),
    name: relayInstanceNameSchema.parse(row.name),
  }))
})

export const createTailnetDefinitionEffect = Effect.fn(
  "tailnets.create"
)(function* (
  definition: Omit<TailnetDefinition, "cleanup" | "integration">,
  credential: Omit<TailscaleOAuthCredential, "clientSecret">,
  clientSecret: string,
  ownerId: string
) {
  const database = yield* Database
  const ciphertext = yield* encryptTailscaleClientSecretEffect(clientSecret)
  const now = yield* Clock.currentTimeMillis
  yield* database.transaction("tailnets.create", (transaction) =>
    Effect.gen(function* () {
      yield* insertTailnetGroup(transaction, definition, ownerId, now)
      yield* transaction.execute(
        `INSERT INTO ${databaseTable("tailnet")}
           (id, owner_id, oauth_client_id,
            oauth_client_secret_ciphertext, oauth_scopes, oauth_tags,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          definition.id,
          ownerId,
          credential.clientId,
          ciphertext,
          JSON.stringify(credential.scopes),
          JSON.stringify(credential.tags),
          now,
          now,
        ]
      )
      yield* replaceTailnetDomains(transaction, definition)
    })
  )
})

export const saveTailnetDefinitionEffect = Effect.fn(
  "tailnets.save"
)(function* (definition: TailnetDefinition, ownerId: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.transaction("tailnets.save", (transaction) =>
    Effect.gen(function* () {
      const existing = yield* transaction.queryRows<RowDataPacket>(
        `SELECT id
         FROM ${databaseTable("tailnet")}
        WHERE id = ?
        LIMIT 1
          FOR UPDATE`,
        [definition.id]
      )
      if (existing.length > 0) {
        yield* transaction.execute(
          `UPDATE ${databaseTable("tailnet")} SET updated_at = ? WHERE id = ?`,
          [now, definition.id]
        )
        yield* replaceTailnetDomains(transaction, definition)
        yield* transaction.execute(
          `UPDATE ${databaseTable("instance_group")}
            SET name = ?, updated_at = ?
          WHERE id = ?`,
          [definition.name, now, definition.id]
        )
        return
      }
      yield* insertTailnetGroup(transaction, definition, ownerId, now)
      yield* transaction.execute(
        `INSERT INTO ${databaseTable("tailnet")}
         (id, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
        [definition.id, ownerId, now, now]
      )
      yield* replaceTailnetDomains(transaction, definition)
    })
  )
})

export const saveTailnetIntegrationEffect = Effect.fn(
  "tailnets.integration.save"
)(function* (
  id: string,
  credential: Omit<TailscaleOAuthCredential, "clientSecret">,
  clientSecret: string
) {
  const database = yield* Database
  const ciphertext = yield* encryptTailscaleClientSecretEffect(clientSecret)
  const now = yield* Clock.currentTimeMillis
  const result = yield* database.execute(
    "tailnets.integration.save",
    `UPDATE ${databaseTable("tailnet")}
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
      resource: "tailnet",
      message: "Tailscale network not found",
    })
  }
})

export const loadTailnetCredentialEffect = Effect.fn(
  "tailnets.integration.load"
)(function* (id: string) {
  const database = yield* Database
  const rows = yield* database.queryRows<TailnetRow>(
    "tailnets.integration.load",
    `SELECT id, oauth_client_id,
            oauth_client_secret_ciphertext, oauth_scopes, oauth_tags,
            oauth_last_synced_at, oauth_last_error
       FROM ${databaseTable("tailnet")}
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
      "tailnets.integration.rotate",
      `UPDATE ${databaseTable("tailnet")}
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
})

export const recordTailnetSyncEffect = Effect.fn(
  "tailnets.integration.recordSync"
)(function* (id: string, error: string | null) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  if (error) {
    yield* database.execute(
      "tailnets.integration.recordSyncError",
      `UPDATE ${databaseTable("tailnet")}
          SET oauth_last_error = ?, updated_at = ?
        WHERE id = ?`,
      [error.slice(0, 512), now, id]
    )
    return
  }
  yield* database.execute(
    "tailnets.integration.recordSyncSuccess",
    `UPDATE ${databaseTable("tailnet")}
        SET oauth_last_synced_at = ?,
            oauth_last_error = NULL,
            updated_at = ?
      WHERE id = ?`,
    [now, now, id]
  )
})

export const removeTailnetDefinitionEffect = Effect.fn(
  "tailnets.remove"
)(function* (id: string) {
  const database = yield* Database
  // Its tunnels' rows go with it; their group membership goes with the
  // group, which is gone with its last tunnel.
  yield* database.transaction("tailnets.remove", (transaction) =>
    Effect.gen(function* () {
      yield* transaction.execute(
        `DELETE FROM ${databaseTable("tailnet")} WHERE id = ?`,
        [id]
      )
      yield* transaction.execute(
        `DELETE FROM ${databaseTable("instance_group_member")} WHERE group_id = ?`,
        [id]
      )
      yield* transaction.execute(
        `DELETE FROM ${databaseTable("instance_group")} WHERE id = ?`,
        [id]
      )
    })
  )
})

// A tailnet's TLDs, in its order. A TLD another tailnet has fails the
// transaction, as each is unique.
function replaceTailnetDomains(
  transaction: DatabaseTransaction,
  definition: Pick<TailnetDefinition, "domains" | "id">
) {
  return Effect.gen(function* () {
    yield* transaction.execute(
      `DELETE FROM ${databaseTable("tailnet_domain")} WHERE tailnet_id = ?`,
      [definition.id]
    )
    for (const [position, domain] of definition.domains.entries()) {
      yield* transaction.execute(
        `INSERT INTO ${databaseTable("tailnet_domain")}
           (tailnet_id, domain, position)
         VALUES (?, ?, ?)`,
        [definition.id, domain, position]
      )
    }
  })
}

// A tailnet is an instance group of its tunnels, which Kiln makes for it.
function insertTailnetGroup(
  transaction: DatabaseTransaction,
  definition: Pick<TailnetDefinition, "id" | "name">,
  createdBy: string,
  now: number
) {
  return transaction.execute(
    `INSERT INTO ${databaseTable("instance_group")}
       (id, name, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), updated_at = VALUES(updated_at)`,
    [definition.id, definition.name, createdBy, now, now]
  )
}

function publicIntegration(
  row: TailnetRow
): TailscaleIntegration | null {
  if (!row.oauth_client_id || !row.oauth_client_secret_ciphertext) return null
  return {
    clientId: row.oauth_client_id,
    lastError: row.oauth_last_error,
    lastSyncedAt: timestamp(row.oauth_last_synced_at),
    scopes: parseStringArray(row.oauth_scopes),
    tags: parseStringArray(row.oauth_tags),
  }
}

function cleanupState(
  row: TailnetRow
): TailnetCleanup | null {
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
