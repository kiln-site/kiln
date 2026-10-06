import { randomUUID } from "node:crypto"

import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import { databaseTableName } from "@/lib/database-config"

// Row seeding for real-MySQL tests (see ./database.ts). Kiln times are epoch
// milliseconds without column defaults, so helpers fill them in.

type Value = string | number | boolean | null | Date
type Row = Record<string, Value>

const seededAt = Date.UTC(2026, 0, 1)

// Inserts rows into a Kiln table, named without the prefix. JSON columns take
// their value as a string.
export const insertRows = Effect.fnUntraced(function* (
  table: string,
  rows: Row | ReadonlyArray<Row>
) {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO ${sql(databaseTableName(table))} ${sql.insert(
    Array.isArray(rows) ? rows : [rows]
  )}`
})

// Every row of a Kiln table, for asserting what a call left behind.
export const selectRows = Effect.fnUntraced(function* <T extends object = Row>(
  table: string
) {
  const sql = yield* SqlClient.SqlClient
  return yield* sql<T>`SELECT * FROM ${sql(databaseTableName(table))}`
})

export const insertUser = (id: string, row: Row = {}) =>
  insertRows("user", {
    id,
    name: id,
    email: `${id}@example.test`,
    emailVerified: true,
    createdAt: new Date(seededAt),
    updatedAt: new Date(seededAt),
    ...row,
  })

export const insertRelay = (id: string, row: Row = {}) =>
  insertRows("relay", {
    id,
    name: id,
    hostname: `${id.toLowerCase()}.relay.test`,
    browser_origin: `https://${id.toLowerCase()}.relay.test`,
    relay_public_key: "relay-public-key",
    client_id: `client-${id}`.slice(0, 43),
    client_public_key: "client-public-key",
    client_private_key_ciphertext: "client-private-key",
    client_role: "full_access",
    client_actions: "[]",
    created_at: seededAt,
    updated_at: seededAt,
    ...row,
  })

export const insertInstance = (
  relayId: string,
  instanceId: string,
  row: Row = {}
) =>
  insertRows("instance", {
    relay_id: relayId,
    instance_id: instanceId,
    created_at: seededAt,
    updated_at: seededAt,
    ...row,
  })

export const insertGrant = (grant: {
  readonly userId: string
  readonly relayId: string
  readonly resourceType: "relay" | "instance" | "database"
  readonly resourceId: string
  readonly role?: "owner" | "admin" | "operator" | "viewer" | null
  readonly state?: "pending" | "active" | "revoked"
  readonly id?: string
}) =>
  insertRows("access_grant", {
    id: grant.id ?? randomUUID(),
    user_id: grant.userId,
    relay_id: grant.relayId,
    resource_type: grant.resourceType,
    resource_id: grant.resourceId,
    role: grant.role ?? null,
    state: grant.state ?? "active",
    created_at: seededAt,
    updated_at: seededAt,
  })

export const insertBackup = (id: string, row: Row = {}) =>
  insertRows("backup", {
    id,
    relay_id: "relay-one",
    target_kind: "instance",
    target_id: "instance-one",
    artifact_kind: "archive",
    reason: "manual",
    status: "available",
    name: id,
    warnings: "[]",
    created_at: seededAt,
    updated_at: seededAt,
    ...row,
  })

// Credential columns hold placeholders; tests that decrypt them pass real
// ciphertexts in `row`.
export const insertBackupStorage = (id: string, row: Row = {}) =>
  insertRows("backup_storage", {
    id,
    owner_user_id: null,
    name: id,
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    bucket: "kiln-backups",
    object_prefix: "team",
    access_key_id_ciphertext: "access-key-id",
    secret_access_key_ciphertext: "secret-access-key",
    created_at: seededAt,
    updated_at: seededAt,
    ...row,
  })
