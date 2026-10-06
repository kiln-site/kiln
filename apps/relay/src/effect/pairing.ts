import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto"
import { Effect, Option, Schema } from "effect"
import * as Sentry from "@sentry/node"

import {
  relayPairingRequestTranscript,
  relayPairingResponseTranscript,
  relayBootstrapEnrollmentTranscript,
} from "@workspace/contracts"

import { actionsForRole } from "../permissions.js"
import type { RelayAction } from "../permissions.js"
import { RelayPairingError } from "./errors.js"
import { fingerprint } from "./identity.js"
import type { RelayConfig } from "../config.js"
import type { RelayIdentity } from "./identity.js"
import type { RelayTlsMaterial } from "./tls.js"
import type {
  RelayClientGrant,
  RelayClientRole,
  RelayInvitation,
  RelayStateStore,
} from "./state.js"

const PAIRING_LIFETIME_MS = 15 * 60_000

export interface PairingInvitationBundle {
  readonly envelope: PairingEnvelope
  readonly token: string
  readonly uri: string
}

export interface PairingEnvelope {
  readonly browserOrigin: string
  readonly caCertificatePem: string | null
  readonly controlEndpoint: string
  readonly expiresAt: number
  readonly invitationId: string
  readonly relayFingerprint: string
  readonly relayName: string
  readonly relayPublicKeyPem: string
  readonly token: string
  readonly version: 1
}

export interface PairingRequest {
  readonly bootstrapProof: string | null
  readonly hearthName: string
  readonly hearthOrigin: string
  readonly invitationId: string
  readonly nonce: string
  readonly publicKeyPem: string
  readonly signature: string
  readonly token: string | null
  readonly version: 1
}

export interface PairingResponse {
  readonly actions: ReadonlyArray<string>
  readonly clientId: string
  readonly expiresAt: number
  readonly nonce: string
  readonly relayFingerprint: string
  readonly relayName: string
  readonly relayPublicKeyPem: string
  readonly role: RelayClientRole
  readonly signature: string
  readonly version: 1
}

export interface InitialPairingResult {
  readonly invitation: PairingInvitationBundle | null
  readonly kind: "automatic" | "manual" | "none"
}

const PairingRequestSchema = Schema.Struct({
  bootstrapProof: Schema.NullOr(Schema.String),
  hearthName: Schema.String,
  hearthOrigin: Schema.String,
  invitationId: Schema.String,
  nonce: Schema.String,
  publicKeyPem: Schema.String,
  signature: Schema.String,
  token: Schema.NullOr(Schema.String),
  version: Schema.Literal(1),
})

const InitialInvitationMetadataSchema = Schema.fromJsonString(
  Schema.Struct({
    invitationId: Schema.String,
  })
)

export const decodePairingRequest =
  Schema.decodeUnknownEffect(PairingRequestSchema)

export const initializePairing = Effect.fn("RelayPairing.initialize")(
  function* (input: {
    readonly config: RelayConfig
    readonly identity: RelayIdentity
    readonly state: RelayStateStore["Service"]
    readonly tls: RelayTlsMaterial | null
  }) {
    const initialized = yield* input.state.getMetadata(
      "networking_initial_invitation"
    )
    if (initialized) {
      const restored = yield* restoreAutomaticInvitation(input, initialized)
      if (restored) return restored
      const clients = yield* input.state.listClients()
      if (input.config.bootstrapToken && clients.length === 0) {
        const replacedInvitationId = initialInvitationId(initialized)
        if (replacedInvitationId) {
          yield* input.state.revokeInvitation(replacedInvitationId, Date.now())
        }
        const invitation = yield* createPairingInvitation({
          ...input,
          role: "full_access",
          token: input.config.bootstrapToken,
        })
        yield* input.state.setMetadata(
          "networking_initial_invitation",
          JSON.stringify({
            createdAt: Date.now(),
            invitationId: invitation.envelope.invitationId,
            kind: "automatic",
          })
        )
        return { invitation, kind: "automatic" } satisfies InitialPairingResult
      }
      // Manual bootstrap URIs are intentionally printed only on first creation.
      // An operator can explicitly issue a replacement with `kiln-relay pair`.
      return { invitation: null, kind: "none" } satisfies InitialPairingResult
    }

    const invitation = yield* createPairingInvitation({
      ...input,
      role: "full_access",
      token: input.config.bootstrapToken ?? undefined,
    })
    const kind = input.config.bootstrapToken ? "automatic" : "manual"
    yield* input.state.setMetadata(
      "networking_initial_invitation",
      JSON.stringify({
        createdAt: Date.now(),
        invitationId: invitation.envelope.invitationId,
        kind,
      })
    )
    return {
      invitation,
      kind,
    } satisfies InitialPairingResult
  }
)

export const createPairingInvitation = Effect.fn(
  "RelayPairing.createInvitation"
)(function* (input: {
  readonly config: RelayConfig
  readonly identity: RelayIdentity
  readonly actions?: ReadonlyArray<RelayAction>
  readonly role: RelayClientRole
  readonly state: RelayStateStore["Service"]
  readonly tls: RelayTlsMaterial | null
  readonly token?: string
}) {
  const now = Date.now()
  const token = input.token ?? randomBytes(32).toString("base64url")
  const invitationId = randomUUID()
  const expiresAt = now + PAIRING_LIFETIME_MS
  yield* input.state.createInvitation({
    actions: actionsForRole(input.role, input.actions),
    createdAt: now,
    expiresAt,
    id: invitationId,
    role: input.role,
    tokenHash: hashToken(token),
  })
  const envelope = pairingEnvelope({
    ...input,
    expiresAt,
    invitationId,
    token,
  })
  return {
    envelope,
    token,
    uri: encodePairingUri(envelope),
  } satisfies PairingInvitationBundle
})

export const pairHearth = Effect.fn("RelayPairing.pairHearth")(
  function* (input: {
    readonly identity: RelayIdentity
    readonly request: PairingRequest
    readonly state: RelayStateStore["Service"]
    readonly bootstrapToken?: string | null
  }) {
    validatePairingRequest(input.request)
    const publicKey = yield* Effect.try({
      try: () => {
        const key = createPublicKey(input.request.publicKeyPem)
        if (key.asymmetricKeyType !== "ed25519") {
          throw new Error("Hearth pairing keys must use Ed25519")
        }
        return key
      },
      catch: (cause) =>
        RelayPairingError.make({ code: "invalid_client_key", cause }),
    })
    const transcript = relayPairingRequestTranscript(input.request)
    const signatureValid = yield* Effect.try({
      try: () =>
        verify(
          null,
          Buffer.from(transcript),
          publicKey,
          Buffer.from(input.request.signature, "base64url")
        ),
      catch: (cause) =>
        RelayPairingError.make({ code: "invalid_client_signature", cause }),
    })
    if (!signatureValid)
      return yield* pairingFailure("invalid_client_signature")

    const clientId = fingerprint(input.request.publicKeyPem)
    const pairedAt = Date.now()
    const invitation = yield* input.state.findActiveInvitation(
      input.request.invitationId,
      pairedAt
    )
    if (!invitation) {
      const [historicalInvitation, existingClient] = yield* Effect.all([
        input.state.findInvitationById(input.request.invitationId),
        input.state.findClientByPublicKey(input.request.publicKeyPem),
      ])
      const origin = normalizeOrigin(input.request.hearthOrigin)
      if (
        !historicalInvitation ||
        !existingClient ||
        existingClient.invitationId !== historicalInvitation.id ||
        !existingClient.origins.includes(origin) ||
        !matchesPairingCredential(
          historicalInvitation,
          input.request,
          input.bootstrapToken ?? null
        )
      ) {
        return yield* pairingFailure("invalid_or_expired_invitation")
      }
      return yield* signPairingResponse({
        client: existingClient,
        identity: input.identity,
        nonce: input.request.nonce,
        now: pairedAt,
      })
    }
    if (
      !matchesPairingCredential(
        invitation,
        input.request,
        input.bootstrapToken ?? null
      )
    ) {
      return yield* pairingFailure("invalid_or_expired_invitation")
    }
    const response = yield* signPairingResponse({
      client: {
        actions: invitation.actions,
        id: clientId,
        role: invitation.role,
      },
      identity: input.identity,
      nonce: input.request.nonce,
      now: pairedAt,
    })
    yield* input.state.pairClient({
      actions: invitation.actions,
      id: clientId,
      invitationId: invitation.id,
      name: input.request.hearthName.trim(),
      origins: [normalizeOrigin(input.request.hearthOrigin)],
      pairedAt,
      publicKey: input.request.publicKeyPem,
      role: invitation.role,
      sourceCidrs: [],
    })
    yield* input.state
      .appendAudit({
        clientId,
        details: { invitationId: invitation.id, role: invitation.role },
        event: "relay.client.paired",
        id: randomUUID(),
        occurredAt: pairedAt,
        requestId: null,
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            Sentry.captureException(cause, {
              tags: { "kiln.operation": "relay.pairing.audit" },
            })
          })
        )
      )
    return response
  }
)

const signPairingResponse = Effect.fn("RelayPairing.signResponse")(
  function* (input: {
    readonly client: Pick<RelayClientGrant, "actions" | "id" | "role">
    readonly identity: RelayIdentity
    readonly nonce: string
    readonly now: number
  }) {
    const responseWithoutSignature = {
      actions: input.client.actions,
      clientId: input.client.id,
      expiresAt: input.now + 60_000,
      nonce: input.nonce,
      relayFingerprint: input.identity.fingerprint,
      relayName: input.identity.name,
      relayPublicKeyPem: input.identity.publicKeyPem,
      role: input.client.role,
      version: 1 as const,
    }
    const signature = yield* Effect.try({
      try: () =>
        sign(
          null,
          Buffer.from(relayPairingResponseTranscript(responseWithoutSignature)),
          input.identity.privateKeyPem
        ).toString("base64url"),
      catch: (cause) =>
        RelayPairingError.make({ code: "sign_pairing_response", cause }),
    })
    return { ...responseWithoutSignature, signature } satisfies PairingResponse
  }
)

export function encodePairingUri(envelope: PairingEnvelope): string {
  const payload = Buffer.from(JSON.stringify(envelope)).toString("base64url")
  return `kiln-relay://pair/v1?payload=${payload}`
}

export function decodePairingUri(value: string): PairingEnvelope {
  const url = new URL(value)
  if (url.protocol !== "kiln-relay:" || url.hostname !== "pair") {
    throw new Error("Not a Kiln Relay pairing URI")
  }
  const payload = url.searchParams.get("payload")
  if (!payload) throw new Error("Pairing URI payload is missing")
  const decoded = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8")
  ) as PairingEnvelope | undefined
  if (!decoded || decoded.version !== 1) {
    throw new Error("Unsupported Relay pairing URI version")
  }
  return decoded
}

export function renderPairingInvitation(
  invitation: PairingInvitationBundle
): string {
  const link = process.stdout.isTTY
    ? `\u001B]8;;${invitation.uri}\u0007Open Relay pairing\u001B]8;;\u0007`
    : invitation.uri
  return [
    "One-time Relay pairing invitation (expires in 15 minutes):",
    link,
    "Anyone with this URI can pair a Hearth until it expires or is used.",
  ].join("\n")
}

function pairingEnvelope(input: {
  readonly config: RelayConfig
  readonly expiresAt: number
  readonly identity: RelayIdentity
  readonly invitationId: string
  readonly tls: RelayTlsMaterial | null
  readonly token: string
}): PairingEnvelope {
  const browserOrigin = new URL(input.config.browserOrigin)
  const controlEndpoint = new URL(browserOrigin)
  controlEndpoint.protocol =
    browserOrigin.protocol === "https:" ? "wss:" : "ws:"
  controlEndpoint.pathname = "/v1/socket"
  return {
    browserOrigin: browserOrigin.origin,
    caCertificatePem: input.tls?.caCertificatePem ?? null,
    controlEndpoint: controlEndpoint.toString(),
    expiresAt: input.expiresAt,
    invitationId: input.invitationId,
    relayFingerprint: input.identity.fingerprint,
    relayName: input.identity.name,
    relayPublicKeyPem: input.identity.publicKeyPem,
    token: input.token,
    version: 1,
  }
}

function validatePairingRequest(request: PairingRequest): void {
  if (Boolean(request.token) === Boolean(request.bootstrapProof)) {
    throw RelayPairingError.make({ code: "invalid_pairing_credential" })
  }
  if (!request.hearthName.trim() || request.hearthName.length > 120) {
    throw RelayPairingError.make({ code: "invalid_hearth_name" })
  }
  normalizeOrigin(request.hearthOrigin)
  const nonce = Buffer.from(request.nonce, "base64url")
  if (nonce.length < 16 || nonce.length > 64) {
    throw RelayPairingError.make({ code: "invalid_pairing_nonce" })
  }
  if (request.publicKeyPem.length > 2_048 || request.signature.length > 512) {
    throw RelayPairingError.make({ code: "pairing_request_too_large" })
  }
}

function normalizeOrigin(value: string): string {
  const origin = new URL(value)
  if (
    (origin.protocol !== "https:" && origin.protocol !== "http:") ||
    origin.origin !== value
  ) {
    throw RelayPairingError.make({ code: "invalid_hearth_origin" })
  }
  return origin.origin
}

function matchesPairingCredential(
  invitation: RelayInvitation,
  request: PairingRequest,
  bootstrapToken: string | null
): boolean {
  if (request.token) return matchesToken(invitation, request.token)
  if (!bootstrapToken || !request.bootstrapProof) return false
  if (!matchesToken(invitation, bootstrapToken)) return false
  const expected = Buffer.from(
    createHmac("sha256", bootstrapToken)
      .update(relayBootstrapEnrollmentTranscript(request))
      .digest("hex"),
    "hex"
  )
  const actual = Buffer.from(request.bootstrapProof, "base64url")
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function matchesToken(invitation: RelayInvitation, token: string): boolean {
  const expected = Buffer.from(invitation.tokenHash, "hex")
  const actual = Buffer.from(hashToken(token), "hex")
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

const restoreAutomaticInvitation = Effect.fn(
  "RelayPairing.restoreAutomaticInvitation"
)(function* (
  input: {
    readonly config: RelayConfig
    readonly identity: RelayIdentity
    readonly state: RelayStateStore["Service"]
    readonly tls: RelayTlsMaterial | null
  },
  metadata: string
) {
  if (!input.config.bootstrapToken) return null
  const parsed = yield* Effect.try({
    try: () => JSON.parse(metadata) as unknown,
    catch: () => null,
  })
  if (!parsed || typeof parsed !== "object") return null
  const value = Object.fromEntries(Object.entries(parsed))
  if (value.kind !== "automatic" || typeof value.invitationId !== "string") {
    return null
  }
  const invitation = yield* input.state.findActiveInvitation(
    value.invitationId,
    Date.now()
  )
  if (!invitation) return null
  if (!matchesToken(invitation, input.config.bootstrapToken)) return null
  const envelope = pairingEnvelope({
    config: input.config,
    expiresAt: invitation.expiresAt,
    identity: input.identity,
    invitationId: invitation.id,
    tls: input.tls,
    token: input.config.bootstrapToken,
  })
  return {
    invitation: {
      envelope,
      token: input.config.bootstrapToken,
      uri: encodePairingUri(envelope),
    },
    kind: "automatic",
  } satisfies InitialPairingResult
})

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

function initialInvitationId(metadata: string): string | null {
  return Schema.decodeUnknownOption(InitialInvitationMetadataSchema)(
    metadata
  ).pipe(
    Option.map((value) => value.invitationId),
    Option.getOrNull
  )
}

function pairingFailure(code: string) {
  return Effect.fail(RelayPairingError.make({ code }))
}
