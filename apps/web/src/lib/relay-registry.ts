import {
  createHash,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { TLSSocket } from "node:tls"
import type { RowDataPacket } from "mysql2/promise"
import { Effect, Result } from "effect"
import { z } from "zod"

import {
  relayPairingRequestTranscript,
  relayPairingResponseTranscript,
  relayBootstrapDiscoveryTranscript,
  relayBootstrapEnrollmentTranscript,
  relaySnapshotSchema,
} from "@workspace/contracts"
import type {
  RelayPairingRequestContract,
  RelayPairingResponseContract,
} from "@workspace/contracts"

import { Database } from "@/effect/database"
import {
  mapPairingHttpResponse,
  mapPairingTransportError,
} from "@/lib/relay-pairing-errors"
import { relayPairingOrigin } from "@/lib/relay-pairing-origin"
import { relayNameForNewPairing } from "@/lib/relay-names"
import { CredentialError, ResourceNotFoundError } from "@/effect/errors"
import { runAppEffect } from "@/effect/runtime"
import { databasePool } from "@/lib/database"
import { databaseTable } from "@/lib/database-config"
import { betterAuthSecrets, kilnPublicUrl } from "@/lib/environment"
import { syncInstanceRegistry } from "@/lib/instance-registry"
import { publishRealtimeChange } from "@/lib/realtime-source.server"

import { decryptWithKeyring, encryptWithKeyring } from "../../keyring.mjs"

const RELAY_PRIVATE_KEY_PURPOSE = "kiln-relay-client-private-key"

export interface PersistedRelay {
  actions: ReadonlyArray<string>
  browserOrigin: string
  clientId: string
  createdAt: string
  createdBy: string | null
  enabled: boolean
  hostname: string
  id: string
  lastConnectedAt: string | null
  lastError: string | null
  managedEmberCount: number | null
  managedTls: boolean
  name: string
  nodeArch: string | null
  nodePlatform: string | null
  nodeVersion: string | null
  paired: true
  port: number
  role: "custom" | "full_access" | "read_only"
  useTls: boolean
}

export interface RelayPairingActor {
  canManageAnyRelay: boolean
  userId: string
}

export interface RelayCredentials {
  caCertificatePem: string | null
  clientId: string
  clientPrivateKeyPem: string
  clientPublicKeyPem: string
  relayPublicKeyPem: string
}

export interface RelayClientAdministration {
  actions: ReadonlyArray<string>
  createdAt: number
  id: string
  lastAddress: string | null
  lastSeenAt: number | null
  name: string
  origins: ReadonlyArray<string>
  role: "custom" | "full_access" | "read_only"
  sourceCidrs: ReadonlyArray<string>
}

export interface RelayAdministration {
  audits: ReadonlyArray<{
    clientId: string | null
    event: string
    id: string
    occurredAt: number
    requestId: string | null
  }>
  clients: ReadonlyArray<RelayClientAdministration>
  invitations: ReadonlyArray<{
    actions: ReadonlyArray<string>
    createdAt: number
    expiresAt: number
    id: string
    role: "custom" | "full_access" | "read_only"
  }>
  service: z.infer<typeof relaySnapshotSchema>["relay"]
}

interface RelayRow extends RowDataPacket {
  browser_origin: string
  client_actions: string
  client_id: string
  client_private_key_ciphertext: string
  client_public_key: string
  client_role: "custom" | "full_access" | "read_only"
  created_at: Date
  created_by: string | null
  enabled: number
  hostname: string
  id: string
  last_connected_at: Date | null
  last_error: string | null
  managed_ember_count: number | null
  name: string
  node_arch: string | null
  node_platform: string | null
  node_version: string | null
  port: number
  relay_ca_certificate: string | null
  relay_public_key: string
  use_tls: number
}

const pairingEnvelopeSchema = z.object({
  browserOrigin: z.url().max(512),
  caCertificatePem: z.string().max(16_384).nullable(),
  controlEndpoint: z.url().max(512),
  expiresAt: z.number().int().positive(),
  invitationId: z.uuid(),
  relayFingerprint: z.string().regex(/^[A-Za-z\d_-]{43}$/u),
  relayName: z.string().trim().min(1).max(120),
  relayPublicKeyPem: z.string().min(80).max(2_048),
  token: z.string().min(32).max(512),
  version: z.literal(1),
})

const pairingResponseSchema = z.object({
  actions: z.array(z.string().min(1).max(120)).max(128),
  clientId: z.string().regex(/^[A-Za-z\d_-]{43}$/u),
  expiresAt: z.number().int().positive(),
  nonce: z.string().min(16).max(128),
  relayFingerprint: z.string().regex(/^[A-Za-z\d_-]{43}$/u),
  relayName: z.string().trim().min(1).max(120),
  relayPublicKeyPem: z.string().min(80).max(2_048),
  role: z.enum(["custom", "full_access", "read_only"]),
  signature: z.string().min(32).max(512),
  version: z.literal(1),
})

const bootstrapDiscoverySchema = z.object({
  envelope: pairingEnvelopeSchema.omit({ token: true }),
  proof: z.string().min(32).max(512),
  serverNonce: z.string().min(16).max(128),
  tlsFingerprint: z.string().min(1).max(256),
})

const relayRoleSchema = z.enum(["custom", "full_access", "read_only"])
const relayClientAdministrationSchema = z.object({
  actions: z.array(z.string()),
  createdAt: z.number().int().nonnegative(),
  id: z.string().min(1),
  lastAddress: z.string().nullable(),
  lastSeenAt: z.number().int().nonnegative().nullable(),
  name: z.string().min(1).max(120),
  origins: z.array(z.url()),
  role: relayRoleSchema,
  sourceCidrs: z.array(z.string()),
})
const relayInvitationAdministrationSchema = z.object({
  actions: z.array(z.string()),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  id: z.uuid(),
  role: relayRoleSchema,
})
const relayAuditAdministrationSchema = z.object({
  clientId: z.string().nullable(),
  event: z.string().min(1).max(120),
  id: z.string().min(1),
  occurredAt: z.number().int().nonnegative(),
  requestId: z.string().nullable(),
})
const pairingInvitationBundleSchema = z.object({
  envelope: pairingEnvelopeSchema,
  token: z.string().min(32),
  uri: z.string().startsWith("kiln-relay://pair/v1"),
})

export async function listPersistedRelays(): Promise<Array<PersistedRelay>> {
  return runAppEffect("relays.list", listPersistedRelaysEffect())
}

async function findPersistedRelayRow(id: string): Promise<RelayRow | null> {
  const [rows] = await databasePool.query<Array<RelayRow>>(
    `SELECT id, name, hostname, port, use_tls, browser_origin,
            client_id, client_role, client_actions, enabled,
            last_connected_at, last_error, managed_ember_count,
            node_arch, node_platform, node_version,
            relay_public_key, relay_ca_certificate,
            client_public_key, client_private_key_ciphertext, created_by, created_at
       FROM ${databaseTable("relay")}
      WHERE id = ?
      LIMIT 1`,
    [id]
  )
  return rows[0] ?? null
}

export const listPersistedRelaysEffect = Effect.fn("relays.list")(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<RelayRow>(
    "relays_list",
    `SELECT id, name, hostname, port, use_tls, browser_origin,
            client_id, client_role, client_actions, enabled,
            last_connected_at, last_error, managed_ember_count,
            node_arch, node_platform, node_version,
            relay_public_key, relay_ca_certificate,
            client_public_key, client_private_key_ciphertext, created_by, created_at
       FROM ${databaseTable("relay")}
      ORDER BY name ASC, created_at ASC`
  )
  return rows.map(toPersistedRelay)
})

export async function pairPersistedRelay(
  pairingUri: string,
  actor: RelayPairingActor
) {
  const envelope = decodePairingUri(pairingUri)
  return pairWithEnvelope(
    envelope,
    {
      bootstrapProof: null,
      token: envelope.token,
    },
    undefined,
    actor.userId,
    actor.canManageAnyRelay ? null : actor.userId
  )
}

export async function previewPairingUri(pairingUri: string) {
  const envelope = decodePairingUri(pairingUri)
  const existing = await findPersistedRelayRow(envelope.relayFingerprint)
  return {
    browserOrigin: envelope.browserOrigin,
    controlEndpoint: envelope.controlEndpoint,
    existingRelayName: existing?.name ?? null,
    expiresAt: envelope.expiresAt,
    managedTls: envelope.caCertificatePem !== null,
    mode: existing ? ("repair" as const) : ("add" as const),
    relayFingerprint: envelope.relayFingerprint,
    relayName: envelope.relayName,
  }
}

export async function getRelayAdministration(
  relayId: string
): Promise<RelayAdministration> {
  const [relay, { relayRpc }] = await Promise.all([
    requiredPersistedRelay(relayId),
    import("@/lib/relay-connection"),
  ])
  const [audits, clients, invitations, snapshot] = await Promise.all([
    relayRpc(relay, "relay.audit.list", { limit: 50 }, 5_000).then((value) =>
      z.array(relayAuditAdministrationSchema).parse(value)
    ),
    relayRpc(relay, "relay.clients.list", {}, 5_000).then((value) =>
      z.array(relayClientAdministrationSchema).parse(value)
    ),
    relayRpc(relay, "relay.pairing.list", {}, 5_000).then((value) =>
      z.array(relayInvitationAdministrationSchema).parse(value)
    ),
    relayRpc(relay, "relay.snapshot", {}, 5_000).then((value) =>
      relaySnapshotSchema.parse(value)
    ),
  ])
  return { audits, clients, invitations, service: snapshot.relay }
}

export async function createRelayPairingInvitation(
  input: {
    relayId: string
    role: "full_access" | "read_only"
  },
  subject: string
) {
  const [relay, { relayRpc }] = await Promise.all([
    requiredPersistedRelay(input.relayId),
    import("@/lib/relay-connection"),
  ])
  return pairingInvitationBundleSchema.parse(
    await relayRpc(
      relay,
      "relay.pairing.create",
      { role: input.role },
      5_000,
      subject
    )
  )
}

export async function revokeRelayPairingInvitation(
  input: {
    invitationId: string
    relayId: string
  },
  subject: string
): Promise<boolean> {
  const [relay, { relayRpc }] = await Promise.all([
    requiredPersistedRelay(input.relayId),
    import("@/lib/relay-connection"),
  ])
  const result = z
    .object({ revoked: z.boolean() })
    .parse(
      await relayRpc(
        relay,
        "relay.pairing.revoke",
        { invitationId: input.invitationId },
        5_000,
        subject
      )
    )
  return result.revoked
}

export async function updateRelayClientPolicy(
  input: {
    actions?: ReadonlyArray<string>
    clientId: string
    name: string
    relayId: string
    role: "custom" | "full_access" | "read_only"
    sourceCidrs: ReadonlyArray<string>
  },
  subject: string
) {
  const [relay, { relayRpc }] = await Promise.all([
    requiredPersistedRelay(input.relayId),
    import("@/lib/relay-connection"),
  ])
  const response = z
    .object({
      actions: z.array(z.string()),
      clientId: z.string(),
      role: relayRoleSchema,
      updated: z.boolean(),
    })
    .parse(
      await relayRpc(
        relay,
        "relay.clients.update",
        {
          actions: input.actions,
          clientId: input.clientId,
          name: input.name,
          role: input.role,
          sourceCidrs: input.sourceCidrs,
        },
        5_000,
        subject
      )
    )
  if (response.updated && input.clientId === relay.clientId) {
    await databasePool.execute(
      `UPDATE ${databaseTable("relay")}
          SET client_role = ?, client_actions = ?
        WHERE id = ?`,
      [response.role, JSON.stringify(response.actions), relay.id]
    )
  }
  return response
}

export async function revokeRelayClient(
  input: {
    clientId: string
    relayId: string
  },
  subject: string
): Promise<boolean> {
  const [relay, { relayRpc }] = await Promise.all([
    requiredPersistedRelay(input.relayId),
    import("@/lib/relay-connection"),
  ])
  const response = z
    .object({ revoked: z.boolean() })
    .parse(
      await relayRpc(
        relay,
        "relay.clients.revoke",
        { clientId: input.clientId },
        5_000,
        subject
      )
    )
  return response.revoked
}

export async function renamePersistedRelay(
  input: {
    name: string
    relayId: string
  },
  subject?: string
): Promise<PersistedRelay> {
  const [relay, { relayRpc }] = await Promise.all([
    requiredPersistedRelay(input.relayId),
    import("@/lib/relay-connection"),
  ])
  const renamed = z
    .object({ id: z.string(), name: z.string().min(1).max(120) })
    .parse(
      await relayRpc(
        relay,
        "relay.rename",
        { name: input.name },
        5_000,
        subject
      )
    )
  await databasePool.execute(
    `UPDATE ${databaseTable("relay")} SET name = ? WHERE id = ?`,
    [renamed.name, relay.id]
  )
  const updated = await requiredPersistedRelay(relay.id)
  publishRelayCollectionChange(relay.id)
  return updated
}

export async function initializeRelayFromEnvironment(): Promise<PersistedRelay | null> {
  if ((await listPersistedRelays()).length > 0) return null
  const token = process.env.KILN_RELAY_BOOTSTRAP_TOKEN?.trim()
  const hostname = process.env.KILN_RELAY_HOST?.trim()
  if (!token || !hostname) return null
  if (Buffer.byteLength(token) < 32) {
    throw new Error("KILN_RELAY_BOOTSTRAP_TOKEN must contain at least 32 bytes")
  }
  const port = Number(process.env.KILN_RELAY_PORT?.trim() || 4100)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("KILN_RELAY_PORT must be a valid TCP port")
  }
  const clientNonce = randomBytes(32).toString("base64url")
  const publicUrl = process.env.KILN_RELAY_PUBLIC_URL?.trim()
    ? new URL(process.env.KILN_RELAY_PUBLIC_URL.trim())
    : new URL(`https://${formatHost(hostname)}:${port}`)
  if (
    publicUrl.protocol !== "https:" ||
    publicUrl.pathname !== "/" ||
    publicUrl.search ||
    publicUrl.hash ||
    publicUrl.username ||
    publicUrl.password
  ) {
    throw new Error(
      "KILN_RELAY_PUBLIC_URL must be an HTTPS origin without credentials, a path, query, or fragment"
    )
  }
  const discovered = await getBootstrapDiscovery(
    new URL(`/v1/bootstrap?nonce=${encodeURIComponent(clientNonce)}`, publicUrl)
  )
  const bootstrap = bootstrapDiscoverySchema.parse(discovered.payload)
  if (
    bootstrap.tlsFingerprint !== "edge-terminated" &&
    bootstrap.tlsFingerprint !== discovered.tlsFingerprint
  ) {
    throw new Error(
      "Relay bootstrap response did not match its TLS certificate"
    )
  }
  const transcript = relayBootstrapDiscoveryTranscript({
    clientNonce,
    controlEndpoint: bootstrap.envelope.controlEndpoint,
    expiresAt: bootstrap.envelope.expiresAt,
    invitationId: bootstrap.envelope.invitationId,
    relayFingerprint: bootstrap.envelope.relayFingerprint,
    relayPublicKeyPem: bootstrap.envelope.relayPublicKeyPem,
    serverNonce: bootstrap.serverNonce,
    tlsFingerprint: bootstrap.tlsFingerprint,
  })
  const expectedProof = createHmac("sha256", token).update(transcript).digest()
  const actualProof = Buffer.from(bootstrap.proof, "base64url")
  if (
    expectedProof.length !== actualProof.length ||
    !timingSafeEqual(expectedProof, actualProof)
  ) {
    throw new Error("Relay bootstrap proof is invalid")
  }
  const envelope = pairingEnvelopeSchema.parse({
    ...bootstrap.envelope,
    token,
  })
  return pairWithEnvelope(
    envelope,
    { bootstrapProof: "pending", token: null },
    publicUrl
  )
}

export async function maintainPersistedRelayConnections(): Promise<void> {
  const relays = (await listPersistedRelays()).filter((relay) => relay.enabled)
  const { relayRpc } = await import("@/lib/relay-connection")
  await Promise.allSettled(
    relays.map(async (relay) => {
      const snapshot = relaySnapshotSchema.parse(
        await relayRpc(relay, "relay.snapshot", {}, 5_000)
      )
      await syncInstanceRegistry(relay.id, snapshot.instances)
    })
  )
}

async function pairWithEnvelope(
  envelope: z.infer<typeof pairingEnvelopeSchema>,
  credential: { bootstrapProof: string | null; token: string | null },
  enrollmentOrigin?: URL,
  subject?: string,
  creatorUserId: string | null = null
) {
  if (envelope.expiresAt <= Date.now()) {
    throw new Error("This Relay pairing invitation has expired")
  }
  const relayKeyFingerprint = publicKeyFingerprint(envelope.relayPublicKeyPem)
  if (relayKeyFingerprint !== envelope.relayFingerprint) {
    throw new Error("Relay pairing identity fingerprint does not match")
  }
  const controlEndpoint = new URL(envelope.controlEndpoint)
  const browserOrigin = new URL(envelope.browserOrigin)
  if (
    (controlEndpoint.protocol !== "wss:" &&
      controlEndpoint.protocol !== "ws:") ||
    controlEndpoint.pathname !== "/v1/socket" ||
    controlEndpoint.hostname !== browserOrigin.hostname ||
    effectivePort(controlEndpoint) !== effectivePort(browserOrigin)
  ) {
    throw new Error("Relay pairing endpoints do not describe one listener")
  }
  if (
    controlEndpoint.protocol === "wss:" &&
    browserOrigin.protocol !== "https:"
  ) {
    throw new Error("Secure Relay control requires a secure browser origin")
  }
  if (
    controlEndpoint.protocol === "ws:" &&
    browserOrigin.protocol !== "http:"
  ) {
    throw new Error("Development Relay endpoints must use matching protocols")
  }

  const existing = await findPersistedRelayRow(envelope.relayFingerprint)
  if (existing && existing.relay_public_key !== envelope.relayPublicKeyPem) {
    throw new Error(
      "The saved Relay identity does not match this pairing invitation"
    )
  }
  if (creatorUserId && existing && existing.created_by !== creatorUserId) {
    throw new Error("You can only manage Relays you created")
  }
  // A Relay keeps this fingerprint when its SQLite state is rebuilt. Reuse
  // Hearth's client identity so Relay can enroll it again without replacing
  // Hearth's Relay row and cascading away instance activity or pins.
  const keys = existing
    ? {
        privateKey: decryptPrivateKey(existing.client_private_key_ciphertext)
          .plaintext,
        publicKey: existing.client_public_key,
      }
    : generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      })
  if (existing && publicKeyFingerprint(keys.publicKey) !== existing.client_id) {
    throw new Error("The saved Hearth client identity is invalid")
  }
  const nonce = randomBytes(32).toString("base64url")
  const requestBase = {
    hearthName: `Hearth on ${kilnPublicUrl().hostname}`,
    hearthOrigin: kilnPublicUrl().origin,
    invitationId: envelope.invitationId,
    nonce,
    publicKeyPem: keys.publicKey,
    version: 1 as const,
  }
  const bootstrapProof = credential.bootstrapProof
    ? createHmac("sha256", envelope.token)
        .update(relayBootstrapEnrollmentTranscript(requestBase))
        .digest("base64url")
    : null
  const unsignedRequest: Omit<RelayPairingRequestContract, "signature"> = {
    ...requestBase,
    bootstrapProof,
    token: credential.token,
  }
  const request: RelayPairingRequestContract = {
    ...unsignedRequest,
    signature: sign(
      null,
      Buffer.from(
        relayPairingRequestTranscript({ ...unsignedRequest, signature: "" })
      ),
      keys.privateKey
    ).toString("base64url"),
  }
  const response = pairingResponseSchema.parse(
    await postPairingRequest(
      new URL(
        "/v1/pair",
        relayPairingOrigin({
          browserOrigin,
          caCertificatePem: envelope.caCertificatePem,
          enrollmentOrigin,
        })
      ),
      envelope.caCertificatePem,
      request
    )
  )
  verifyPairingResponse(envelope, nonce, response)
  if (response.clientId !== publicKeyFingerprint(keys.publicKey)) {
    throw new Error("Relay paired an unexpected Hearth client identity")
  }
  if (existing && response.clientId !== existing.client_id) {
    throw new Error("Relay repair returned a different Hearth client identity")
  }

  const initialName = existing
    ? response.relayName
    : relayNameForNewPairing(
        response.relayName,
        (await listPersistedRelays()).map((relay) => relay.name)
      )
  const encryptedPrivateKey = encryptPrivateKey(keys.privateKey)
  await runAppEffect(
    "relay.pairing.persist",
    persistPairedRelayEffect({
      browserOrigin: browserOrigin.origin,
      clientActions: JSON.stringify(response.actions),
      clientId: response.clientId,
      clientPrivateKeyCiphertext: encryptedPrivateKey,
      clientPublicKey: keys.publicKey,
      clientRole: response.role,
      createdBy: subject ?? null,
      creatorUserId,
      expectedExisting: existing !== null,
      hostname: controlEndpoint.hostname,
      id: envelope.relayFingerprint,
      name: initialName,
      ownerGrantId: randomUUID(),
      port: effectivePort(controlEndpoint),
      relayCaCertificate: envelope.caCertificatePem,
      relayPublicKey: envelope.relayPublicKeyPem,
      useTls: controlEndpoint.protocol === "wss:",
    })
  )
  if (existing) {
    const { closeRelayConnection } = await import("@/lib/relay-connection")
    closeRelayConnection(envelope.relayFingerprint)
  }
  return Effect.runPromise(
    registryOperation(async () => {
      if (!existing && initialName !== response.relayName) {
        await renamePersistedRelay(
          {
            name: initialName,
            relayId: envelope.relayFingerprint,
          },
          subject
        )
      }
      const checked = await inspectPersistedRelay(envelope.relayFingerprint)
      publishRelayCollectionChange(
        checked.id,
        creatorUserId ? [creatorUserId] : []
      )
      return checked
    }).pipe(
      Effect.catch((cause) =>
        (existing
          ? Effect.void
          : registryOperation(() =>
              deletePersistedRelay(envelope.relayFingerprint)
            ).pipe(Effect.asVoid)
        ).pipe(Effect.flatMap(() => Effect.fail(cause)))
      )
    )
  )
}

interface PairedRelayOwnershipRow extends RowDataPacket {
  created_by: string | null
}

export function persistPairedRelayEffect(input: {
  browserOrigin: string
  clientActions: string
  clientId: string
  clientPrivateKeyCiphertext: string
  clientPublicKey: string
  clientRole: "custom" | "full_access" | "read_only"
  createdBy: string | null
  creatorUserId: string | null
  expectedExisting: boolean
  hostname: string
  id: string
  name: string
  ownerGrantId: string
  port: number
  relayCaCertificate: string | null
  relayPublicKey: string
  useTls: boolean
}) {
  return Effect.gen(function* () {
    if (input.creatorUserId && input.createdBy !== input.creatorUserId) {
      return yield* Effect.fail(new Error("Invalid Relay creator ownership"))
    }
    const database = yield* Database
    return yield* database.transaction("relay.pairing.persist", (transaction) =>
      Effect.gen(function* () {
        const persistedRows =
          yield* transaction.queryRows<PairedRelayOwnershipRow>(
            `SELECT created_by
                 FROM ${databaseTable("relay")}
                WHERE id = ? LIMIT 1 FOR UPDATE`,
            [input.id]
          )
        const persisted = persistedRows.at(0)
        if ((persisted !== undefined) !== input.expectedExisting) {
          return yield* Effect.fail(
            new Error("Relay pairing state changed. Try again.")
          )
        }
        if (
          input.creatorUserId &&
          persisted &&
          persisted.created_by !== input.creatorUserId
        ) {
          return yield* Effect.fail(
            new Error("You can only manage Relays you created")
          )
        }

        if (persisted) {
          yield* transaction.execute(
            `UPDATE ${databaseTable("relay")}
                  SET name = ?, hostname = ?, port = ?, use_tls = ?,
                      browser_origin = ?, relay_public_key = ?,
                      relay_ca_certificate = ?, client_id = ?,
                      client_public_key = ?, client_private_key_ciphertext = ?,
                      client_role = ?, client_actions = ?, enabled = TRUE,
                      last_error = NULL
                WHERE id = ?`,
            [
              input.name,
              input.hostname,
              input.port,
              input.useTls,
              input.browserOrigin,
              input.relayPublicKey,
              input.relayCaCertificate,
              input.clientId,
              input.clientPublicKey,
              input.clientPrivateKeyCiphertext,
              input.clientRole,
              input.clientActions,
              input.id,
            ]
          )
        } else {
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("relay")} (
                id, name, hostname, port, use_tls, browser_origin,
                relay_public_key, relay_ca_certificate,
                client_id, client_public_key, client_private_key_ciphertext,
                client_role, client_actions, enabled, created_by
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?)`,
            [
              input.id,
              input.name,
              input.hostname,
              input.port,
              input.useTls,
              input.browserOrigin,
              input.relayPublicKey,
              input.relayCaCertificate,
              input.clientId,
              input.clientPublicKey,
              input.clientPrivateKeyCiphertext,
              input.clientRole,
              input.clientActions,
              input.createdBy,
            ]
          )
        }

        if (input.creatorUserId) {
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("access_grant")}
                (id, user_id, relay_id, resource_type, resource_id, role, granted_by)
               VALUES (?, ?, ?, 'relay', ?, 'owner', ?)
               ON DUPLICATE KEY UPDATE role = 'owner', granted_by = VALUES(granted_by)`,
            [
              input.ownerGrantId,
              input.creatorUserId,
              input.id,
              input.id,
              input.creatorUserId,
            ]
          )
        }
      })
    )
  })
}

export async function updatePersistedRelay(input: {
  hostname: string
  id: string
  port: number
  useTls: boolean
}): Promise<PersistedRelay> {
  const [result] = await databasePool.execute<
    import("mysql2/promise").ResultSetHeader
  >(
    `UPDATE ${databaseTable("relay")}
        SET hostname = ?, port = ?, use_tls = ?
      WHERE id = ?`,
    [input.hostname, input.port, input.useTls, input.id]
  )
  if (result.affectedRows !== 1) throw new Error("Relay not found")
  const relay = await inspectPersistedRelay(input.id)
  publishRelayCollectionChange(relay.id)
  return relay
}

export async function setPersistedRelayEnabled(
  id: string,
  enabled: boolean
): Promise<PersistedRelay> {
  const relay = await runAppEffect(
    "relays.setEnabled",
    setPersistedRelayEnabledEffect(id, enabled)
  )
  publishRelayCollectionChange(id)
  return relay
}

export const setPersistedRelayEnabledEffect = Effect.fn("relays.setEnabled")(
  function* (id: string, enabled: boolean) {
    const database = yield* Database
    const result = yield* database.execute(
      "relay_set_enabled",
      `UPDATE ${databaseTable("relay")} SET enabled = ? WHERE id = ?`,
      [enabled, id]
    )
    if (result.affectedRows !== 1) {
      return yield* Effect.fail(
        ResourceNotFoundError.make({
          resource: "relay",
          message: "Relay not found",
        })
      )
    }
    const relay = (yield* listPersistedRelaysEffect()).find(
      (item) => item.id === id
    )
    if (!relay) {
      return yield* Effect.fail(
        ResourceNotFoundError.make({
          resource: "relay",
          message: "Relay was updated but could not be read back",
        })
      )
    }
    return relay
  }
)

export const deletePersistedRelayEffect = Effect.fn("relay.deletePersisted")(
  function* (id: string) {
    const database = yield* Database
    yield* database.transaction("relay.deletePersisted", (transaction) =>
      Effect.gen(function* () {
        yield* transaction.execute(
          `UPDATE ${databaseTable("invitation")}
              SET revoked_at = CURRENT_TIMESTAMP(3)
            WHERE relay_id = ?
              AND accepted_at IS NULL
              AND revoked_at IS NULL`,
          [id]
        )
        yield* transaction.execute(
          `DELETE FROM ${databaseTable("access_grant")} WHERE relay_id = ?`,
          [id]
        )
        yield* transaction.execute(
          `UPDATE ${databaseTable("tailscale_network")} network
             JOIN ${databaseTable("tailscale_network_deployment")} target
               ON target.network_id = network.id
              AND target.relay_id = ?
              SET network.cleanup_attempts = 0,
                  network.cleanup_next_attempt_at = CURRENT_TIMESTAMP(3),
                  network.cleanup_last_error = NULL
            WHERE network.deletion_requested_at IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                  FROM ${databaseTable("tailscale_network_deployment")} remaining
                 WHERE remaining.network_id = network.id
                   AND remaining.relay_id <> ?
              )`,
          [id, id]
        )
        yield* transaction.execute(
          `DELETE FROM ${databaseTable("tailscale_network_deployment")}
            WHERE relay_id = ?`,
          [id]
        )
        const result = yield* transaction.execute(
          `DELETE FROM ${databaseTable("relay")} WHERE id = ?`,
          [id]
        )
        if (result.affectedRows !== 1) {
          return yield* Effect.fail(new Error("Relay not found"))
        }
      })
    )
  }
)

export async function deletePersistedRelay(id: string): Promise<void> {
  await runAppEffect("relay.deletePersisted", deletePersistedRelayEffect(id))
  const { closeRelayConnection } = await import("@/lib/relay-connection")
  closeRelayConnection(id)
  publishRelayCollectionChange(id)
}

export async function checkPersistedRelay(id: string): Promise<PersistedRelay> {
  const checked = await inspectPersistedRelay(id)
  if (checked.enabled) publishRelayHealthChange(id)
  return checked
}

async function inspectPersistedRelay(id: string): Promise<PersistedRelay> {
  const relay = (await listPersistedRelays()).find((item) => item.id === id)
  if (!relay) throw new Error("Relay not found")
  if (!relay.enabled) return relay

  let error: string | null = null
  await Effect.runPromise(
    registryOperation(async () => {
      const { relayRpc } = await import("@/lib/relay-connection")
      const snapshot = relaySnapshotSchema.parse(
        await relayRpc(relay, "relay.snapshot", {}, 5_000)
      )
      await databasePool.execute(
        `UPDATE ${databaseTable("relay")}
          SET last_connected_at = ?, last_error = NULL,
              managed_ember_count = ?, node_arch = ?,
              node_platform = ?, node_version = ?
        WHERE id = ?`,
        [
          new Date(),
          snapshot.instances.filter((instance) => instance.managedByRelay)
            .length,
          snapshot.node.arch,
          snapshot.node.platform,
          snapshot.node.version,
          id,
        ]
      )
    }).pipe(
      Effect.catch((cause) => {
        error = cause instanceof Error ? cause.message : "Could not reach Relay"
        return registryOperation(() =>
          databasePool.execute(
            `UPDATE ${databaseTable("relay")} SET last_error = ? WHERE id = ?`,
            [(error ?? "Could not reach Relay").slice(0, 512), id]
          )
        ).pipe(Effect.asVoid)
      })
    )
  )
  const checked = (await listPersistedRelays()).find((item) => item.id === id)
  if (!checked) throw new Error("Relay not found")
  return checked
}

function publishRelayCollectionChange(
  relayId: string,
  userIds: Array<string> = []
): void {
  publishRealtimeChange({
    relayId,
    type: "relay.metadata",
    ...(userIds.length > 0 ? { userIds: [...new Set(userIds)] } : {}),
  })
}

function publishRelayHealthChange(relayId: string): void {
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [relayId] },
    scope: { relayId },
    topics: ["relay-health"],
    type: "hearth.invalidate",
  })
}

export async function resolveDefaultRelay(): Promise<PersistedRelay | null> {
  return runAppEffect("relays.resolveDefault", resolveDefaultRelayEffect())
}

export const resolveDefaultRelayEffect = Effect.fn("relays.resolveDefault")(
  function* () {
    return (
      (yield* listPersistedRelaysEffect()).find((item) => item.enabled) ?? null
    )
  }
)

export function loadRelayCredentials(id: string): Promise<RelayCredentials> {
  return runAppEffect("relays.credentials", loadRelayCredentialsEffect(id))
}

export const loadRelayCredentialsEffect = Effect.fn("relays.credentials")(
  function* (id: string) {
    const database = yield* Database
    const rows = yield* database.queryRows<RelayRow>(
      "relay_credentials",
      `SELECT id, name, hostname, port, use_tls, browser_origin,
              client_id, client_role, client_actions, enabled,
              last_connected_at, last_error, managed_ember_count,
              node_arch, node_platform, node_version,
              relay_public_key, relay_ca_certificate,
              client_public_key, client_private_key_ciphertext
         FROM ${databaseTable("relay")} WHERE id = ? LIMIT 1`,
      [id]
    )
    const row = rows[0]
    if (!row) {
      return yield* Effect.fail(
        ResourceNotFoundError.make({
          resource: "relay",
          message: "Relay credentials not found",
        })
      )
    }
    const decrypted = yield* Effect.try({
      try: () => decryptPrivateKey(row.client_private_key_ciphertext),
      catch: (cause) =>
        CredentialError.make({ operation: "decrypt_relay_private_key", cause }),
    })
    if (decrypted.needsRotation) {
      const rotated = yield* Effect.try({
        try: () => encryptPrivateKey(decrypted.plaintext),
        catch: (cause) =>
          CredentialError.make({
            operation: "rotate_relay_private_key",
            cause,
          }),
      })
      yield* database.execute(
        "rotate_relay_private_key",
        `UPDATE ${databaseTable("relay")}
            SET client_private_key_ciphertext = ?
          WHERE id = ? AND client_private_key_ciphertext = ?`,
        [rotated, id, row.client_private_key_ciphertext]
      )
    }
    return {
      caCertificatePem: row.relay_ca_certificate,
      clientId: row.client_id,
      clientPrivateKeyPem: decrypted.plaintext,
      clientPublicKeyPem: row.client_public_key,
      relayPublicKeyPem: row.relay_public_key,
    } satisfies RelayCredentials
  }
)

function decodePairingUri(value: string) {
  const url = new URL(value.trim())
  if (
    url.protocol !== "kiln-relay:" ||
    url.hostname !== "pair" ||
    url.pathname !== "/v1"
  ) {
    throw new Error("Enter a valid Kiln Relay pairing URI")
  }
  const payload = url.searchParams.get("payload")
  if (!payload || payload.length > 32_768) {
    throw new Error("Relay pairing URI payload is missing or too large")
  }
  return pairingEnvelopeSchema.parse(
    JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown
  )
}

async function postPairingRequest(
  url: URL,
  caCertificatePem: string | null,
  body: RelayPairingRequestContract
): Promise<unknown> {
  const encoded = Buffer.from(JSON.stringify(body))
  const request = url.protocol === "https:" ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const fail = (cause: unknown) => {
      reject(mapPairingTransportError(cause) ?? cause)
    }
    const outgoing = request(
      url,
      {
        ca: caCertificatePem ?? undefined,
        headers: {
          Accept: "application/json",
          "Content-Length": encoded.length,
          "Content-Type": "application/json",
        },
        method: "POST",
        rejectUnauthorized: url.protocol === "https:",
        signal: AbortSignal.timeout(10_000),
      },
      (response) => {
        const chunks: Array<Buffer> = []
        let size = 0
        response.on("data", (chunk: Buffer) => {
          size += chunk.length
          if (size > 256 * 1024)
            response.destroy(new Error("Pairing response is too large"))
          else chunks.push(chunk)
        })
        response.once("error", fail)
        response.once("end", () => {
          const text = Buffer.concat(chunks).toString("utf8")
          const statusCode = response.statusCode ?? 0
          const edgeError = mapPairingHttpResponse(statusCode, text)
          if (edgeError) {
            reject(edgeError)
            return
          }
          Result.try(() => {
            const payload = JSON.parse(text) as unknown
            if (statusCode !== 201) {
              const message = z.object({ error: z.string() }).safeParse(payload)
              throw new Error(
                message.success
                  ? message.data.error
                  : `Relay pairing failed with HTTP ${statusCode}`
              )
            }
            return payload
          }).pipe(Result.match({ onFailure: reject, onSuccess: resolve }))
        })
      }
    )
    outgoing.once("error", fail)
    outgoing.end(encoded)
  })
}

async function getBootstrapDiscovery(url: URL): Promise<{
  payload: unknown
  tlsFingerprint: string
}> {
  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest(
      url,
      {
        method: "GET",
        rejectUnauthorized: false,
        signal: AbortSignal.timeout(10_000),
      },
      (response) => {
        if (!(response.socket instanceof TLSSocket)) {
          response.destroy(new Error("Relay bootstrap did not use TLS"))
          return
        }
        const fingerprint = response.socket.getPeerCertificate().fingerprint256
        if (!fingerprint) {
          response.destroy(new Error("Relay TLS certificate is unavailable"))
          return
        }
        const chunks: Array<Buffer> = []
        let size = 0
        response.on("data", (chunk: Buffer) => {
          size += chunk.length
          if (size > 256 * 1024) {
            response.destroy(new Error("Relay bootstrap response is too large"))
          } else {
            chunks.push(chunk)
          }
        })
        response.once("error", reject)
        response.once("end", () => {
          Result.try(() => {
            if (response.statusCode !== 200) {
              throw new Error(
                `Relay automatic pairing returned HTTP ${response.statusCode}`
              )
            }
            return {
              payload: JSON.parse(
                Buffer.concat(chunks).toString("utf8")
              ) as unknown,
              tlsFingerprint: fingerprint,
            }
          }).pipe(Result.match({ onFailure: reject, onSuccess: resolve }))
        })
      }
    )
    outgoing.once("error", reject)
    outgoing.end()
  })
}

function registryOperation<A>(
  run: () => Promise<A>
): Effect.Effect<A, unknown> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => cause,
  })
}

function verifyPairingResponse(
  envelope: z.infer<typeof pairingEnvelopeSchema>,
  nonce: string,
  response: RelayPairingResponseContract
): void {
  if (
    response.nonce !== nonce ||
    response.expiresAt <= Date.now() ||
    response.relayFingerprint !== envelope.relayFingerprint ||
    response.relayPublicKeyPem !== envelope.relayPublicKeyPem
  ) {
    throw new Error("Relay pairing response did not match the invitation")
  }
  if (
    !verify(
      null,
      Buffer.from(relayPairingResponseTranscript(response)),
      envelope.relayPublicKeyPem,
      Buffer.from(response.signature, "base64url")
    )
  ) {
    throw new Error("Relay pairing response signature is invalid")
  }
}

function toPersistedRelay(row: RelayRow): PersistedRelay {
  return {
    actions: z
      .array(z.string())
      .parse(
        typeof row.client_actions === "string"
          ? JSON.parse(row.client_actions)
          : row.client_actions
      ),
    browserOrigin: row.browser_origin,
    clientId: row.client_id,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    enabled: Boolean(row.enabled),
    hostname: row.hostname,
    id: row.id,
    lastConnectedAt: row.last_connected_at?.toISOString() ?? null,
    lastError: row.last_error,
    managedEmberCount:
      row.managed_ember_count === null ? null : Number(row.managed_ember_count),
    managedTls: row.relay_ca_certificate !== null,
    name: row.name,
    nodeArch: row.node_arch,
    nodePlatform: row.node_platform,
    nodeVersion: row.node_version,
    paired: true,
    port: Number(row.port),
    role: row.client_role,
    useTls: Boolean(row.use_tls),
  }
}

async function requiredPersistedRelay(id: string): Promise<PersistedRelay> {
  const relay = (await listPersistedRelays()).find((item) => item.id === id)
  if (!relay) throw new Error("Relay not found")
  if (!relay.enabled) throw new Error("Relay is paused")
  return relay
}

function publicKeyFingerprint(publicKeyPem: string): string {
  return createHash("sha256")
    .update(
      createPublicKey(publicKeyPem).export({ format: "der", type: "spki" })
    )
    .digest("base64url")
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port)
  return url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80
}

function formatHost(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname
}

function encryptPrivateKey(privateKey: string): string {
  return encryptWithKeyring(
    privateKey,
    betterAuthSecrets(),
    RELAY_PRIVATE_KEY_PURPOSE
  )
}

function decryptPrivateKey(value: string) {
  return decryptWithKeyring(
    value,
    betterAuthSecrets(),
    RELAY_PRIVATE_KEY_PURPOSE
  )
}
