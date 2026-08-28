import type { RowDataPacket } from "mysql2/promise"
import { Effect, Option, Schema } from "effect"
import { z } from "zod"

import {
  relayInstanceNameSchema,
  relayTailscaleDomainSchema,
  relayTailscaleStackIdSchema,
} from "@workspace/contracts"

import { Database } from "@/effect/database"
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

export interface TailscaleNetworkDefinition {
  cleanup: TailscaleNetworkCleanup | null
  domain: string
  id: string
  integration: TailscaleIntegration | null
  name: string
}

export interface TailscaleNetworkCleanup {
  attempts: number
  lastError: string | null
  nextAttemptAt: string | null
  pendingRelays: number
  requestedAt: string
}

interface TailscaleNetworkRow extends RowDataPacket {
  cleanup_attempts: number
  cleanup_last_error: string | null
  cleanup_next_attempt_at: Date | string | null
  cleanup_pending_relays: number | string
  deletion_requested_at: Date | string | null
  domain: string
  id: string
  name: string
  oauth_client_id: string | null
  oauth_client_secret_ciphertext: string | null
  oauth_last_error: string | null
  oauth_last_synced_at: Date | string | null
  oauth_scopes: unknown
  oauth_tags: unknown
}

export const loadTailscaleNetworkDefinitionsEffect = Effect.fn(
  "tailscaleNetworks.load"
)(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<TailscaleNetworkRow>(
    "tailscaleNetworks.load",
    `SELECT network.id, network.name, network.domain, network.oauth_client_id,
            oauth_client_secret_ciphertext, oauth_scopes, oauth_tags,
            oauth_last_synced_at, oauth_last_error,
            deletion_requested_at, cleanup_attempts,
            cleanup_next_attempt_at, cleanup_last_error,
            (SELECT COUNT(*)
               FROM ${databaseTable("tailscale_network_deployment")} deployment
              WHERE deployment.network_id = network.id) AS cleanup_pending_relays
       FROM ${databaseTable("tailscale_network")} network
      ORDER BY network.name, network.id`
  )
  return rows.map((row) => ({
    cleanup: cleanupState(row),
    domain: relayTailscaleDomainSchema.parse(row.domain),
    id: relayTailscaleStackIdSchema.parse(row.id),
    integration: publicIntegration(row),
    name: relayInstanceNameSchema.parse(row.name),
  }))
})

export const createTailscaleNetworkDefinitionEffect = Effect.fn(
  "tailscaleNetworks.create"
)(function* (
  definition: Omit<TailscaleNetworkDefinition, "cleanup" | "integration">,
  credential: Omit<TailscaleOAuthCredential, "clientSecret">,
  clientSecret: string
) {
  const database = yield* Database
  const ciphertext = yield* encryptTailscaleClientSecretEffect(clientSecret)
  yield* database.execute(
    "tailscaleNetworks.create",
    `INSERT INTO ${databaseTable("tailscale_network")}
       (id, name, domain, oauth_client_id, oauth_client_secret_ciphertext,
        oauth_scopes, oauth_tags)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      definition.id,
      definition.name,
      definition.domain,
      credential.clientId,
      ciphertext,
      JSON.stringify(credential.scopes),
      JSON.stringify(credential.tags),
    ]
  )
})

export const saveTailscaleNetworkDefinitionEffect = Effect.fn(
  "tailscaleNetworks.save"
)(function* (definition: TailscaleNetworkDefinition) {
  const database = yield* Database
  yield* database.transaction("tailscaleNetworks.save", (transaction) =>
    Effect.gen(function* () {
      const existing = yield* transaction.queryRows<RowDataPacket>(
        `SELECT id
         FROM ${databaseTable("tailscale_network")}
        WHERE id = ?
        LIMIT 1
          FOR UPDATE`,
        [definition.id]
      )
      if (existing.length > 0) {
        yield* transaction.execute(
          `UPDATE ${databaseTable("tailscale_network")}
            SET name = ?, domain = ?
          WHERE id = ?`,
          [definition.name, definition.domain, definition.id]
        )
        return
      }
      yield* transaction.execute(
        `INSERT INTO ${databaseTable("tailscale_network")} (id, name, domain)
       VALUES (?, ?, ?)`,
        [definition.id, definition.name, definition.domain]
      )
    })
  )
})

export const saveTailscaleNetworkIntegrationEffect = Effect.fn(
  "tailscaleNetworks.integration.save"
)(function* (
  id: string,
  credential: Omit<TailscaleOAuthCredential, "clientSecret">,
  clientSecret: string
) {
  const database = yield* Database
  const ciphertext = yield* encryptTailscaleClientSecretEffect(clientSecret)
  const result = yield* database.execute(
    "tailscaleNetworks.integration.save",
    `UPDATE ${databaseTable("tailscale_network")}
        SET oauth_client_id = ?,
            oauth_client_secret_ciphertext = ?,
            oauth_scopes = ?,
            oauth_tags = ?,
            oauth_last_synced_at = NULL,
            oauth_last_error = NULL
      WHERE id = ?`,
    [
      credential.clientId,
      ciphertext,
      JSON.stringify(credential.scopes),
      JSON.stringify(credential.tags),
      id,
    ]
  )
  if (result.affectedRows === 0) {
    return yield* ResourceNotFoundError.make({
      resource: "tailscale_network",
      message: "Tailscale network not found",
    })
  }
})

export const loadTailscaleNetworkCredentialEffect = Effect.fn(
  "tailscaleNetworks.integration.load"
)(function* (id: string) {
  const database = yield* Database
  const rows = yield* database.queryRows<TailscaleNetworkRow>(
    "tailscaleNetworks.integration.load",
    `SELECT id, name, domain, oauth_client_id,
            oauth_client_secret_ciphertext, oauth_scopes, oauth_tags,
            oauth_last_synced_at, oauth_last_error
       FROM ${databaseTable("tailscale_network")}
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
    yield* database.execute(
      "tailscaleNetworks.integration.rotate",
      `UPDATE ${databaseTable("tailscale_network")}
          SET oauth_client_secret_ciphertext = ?
        WHERE id = ? AND oauth_client_secret_ciphertext = ?`,
      [rotated, id, ciphertext]
    )
  }
  return {
    clientId: row.oauth_client_id,
    clientSecret: decrypted.plaintext,
    scopes: parseStringArray(row.oauth_scopes),
    tags: parseStringArray(row.oauth_tags),
  } satisfies TailscaleOAuthCredential
})

export const recordTailscaleNetworkSyncEffect = Effect.fn(
  "tailscaleNetworks.integration.recordSync"
)(function* (id: string, error: string | null) {
  const database = yield* Database
  if (error) {
    yield* database.execute(
      "tailscaleNetworks.integration.recordSyncError",
      `UPDATE ${databaseTable("tailscale_network")}
          SET oauth_last_error = ?
        WHERE id = ?`,
      [error.slice(0, 512), id]
    )
    return
  }
  yield* database.execute(
    "tailscaleNetworks.integration.recordSyncSuccess",
    `UPDATE ${databaseTable("tailscale_network")}
        SET oauth_last_synced_at = CURRENT_TIMESTAMP(3),
            oauth_last_error = NULL
      WHERE id = ?`,
    [id]
  )
})

export const removeTailscaleNetworkDefinitionEffect = Effect.fn(
  "tailscaleNetworks.remove"
)(function* (id: string) {
  const database = yield* Database
  yield* database.execute(
    "tailscaleNetworks.remove",
    `DELETE FROM ${databaseTable("tailscale_network")} WHERE id = ?`,
    [id]
  )
})

function publicIntegration(
  row: TailscaleNetworkRow
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
  row: TailscaleNetworkRow
): TailscaleNetworkCleanup | null {
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

function timestamp(value: Date | string | null): string | null {
  if (value === null) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.valueOf()) ? null : date.toISOString()
}
