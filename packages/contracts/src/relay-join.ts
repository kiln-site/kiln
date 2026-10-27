import { Schema } from "effect"

// Joining: a new Relay pairs with a Hearth from one link, copied out of
// Hearth's Add Relay dialog into the Relay's install command.
//
// The link is `<hearth origin>/#kj1.<code>`: where Hearth is, and a short
// secret code. It travels from Hearth to the Relay through the person, and
// the code never crosses the network: the join's ID is derived from it, the
// Relay proves it holds it with an HMAC over its announcement, and Hearth
// answers with one over the Relay's nonce, which also carries what the
// Relay needs to know, such as which Hearth client may pair. A network
// between them can delay joining, but not take it over; someone also
// confirms the Relay in Hearth before it's added.

const LINK_PREFIX = "#kj1."
// A join lasts this long from when Hearth makes it.
export const RELAY_JOIN_LIFETIME_MS = 30 * 60_000

// 20 base32 letters: 100 bits, plenty for a code that lasts half an hour
// and needs a person's confirmation.
const CODE = /^[a-z2-7]{20}$/u
const JOIN_ID = /^[A-Za-z\d_-]{22}$/u
const FINGERPRINT = /^[A-Za-z\d_-]{43}$/u

export interface RelayJoinLink {
  readonly hearthOrigin: string
  readonly secret: string
}

export function encodeRelayJoinLink(link: RelayJoinLink): string {
  return `${link.hearthOrigin}/${LINK_PREFIX}${link.secret}`
}

/** The join a link describes, or null when it isn't a valid one. */
export function decodeRelayJoinLink(value: string): RelayJoinLink | null {
  const trimmed = value.trim()
  if (trimmed.length > 2_048 || !URL.canParse(trimmed)) return null
  const url = new URL(trimmed)
  const secret = url.hash.slice(LINK_PREFIX.length)
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    (url.pathname !== "/" && url.pathname !== "") ||
    !url.hash.startsWith(LINK_PREFIX) ||
    !CODE.test(secret)
  ) {
    return null
  }
  return { hearthOrigin: url.origin, secret }
}

/** Where someone confirms a join's Relay in Hearth. */
export function relayJoinConfirmUrl(
  hearthOrigin: string,
  joinId: string
): string {
  return `${hearthOrigin}/infra/relays?join=${joinId}`
}

export const relayJoinIdPattern = JOIN_ID

// HMAC labels: a join's ID, and its invitation's pairing token, are each
// derived from its code, so none of them is the code itself.
export const RELAY_JOIN_ID_LABEL = "kiln.relay-join.id.v1"
export const RELAY_JOIN_INVITATION_LABEL = "kiln.relay-join.invitation.v1"

/** The Relay's installation, as a join or a pairing link reports it. */
export const RelayJoinInstallationSchema = Schema.Struct({
  // Whether KILN_INSTALLATION_ID or the Relay's platform state fixes it.
  fixed: Schema.Boolean,
  id: Schema.NullOr(Schema.String.check(Schema.isMaxLength(120))),
  // Whether the Relay can replace it (`relay.installation.replace`).
  replace: Schema.Boolean,
})

export const RelayJoinEnvelopeSchema = Schema.Struct({
  browserOrigin: Schema.String.check(Schema.isMaxLength(512)),
  caCertificatePem: Schema.NullOr(
    Schema.String.check(Schema.isMaxLength(16_384))
  ),
  controlEndpoint: Schema.String.check(Schema.isMaxLength(512)),
  installation: RelayJoinInstallationSchema,
  invitationId: Schema.String.check(Schema.isPattern(JOIN_ID)),
  relayBuild: Schema.String.check(Schema.isMaxLength(120)),
  relayFingerprint: Schema.String.check(Schema.isPattern(FINGERPRINT)),
  relayName: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(120)
  ),
  relayPublicKeyPem: Schema.String.check(
    Schema.isMinLength(80),
    Schema.isMaxLength(2_048)
  ),
})

export type RelayJoinEnvelope = typeof RelayJoinEnvelopeSchema.Type

// A Relay with this pairs through its announcements: Hearth's answer carries
// the pairing request it would otherwise send the Relay (`pairing`), and the
// Relay's next announcement carries its signed reply. Hearth then needn't
// reach the Relay at all, as for one behind a home router.
export const relayJoinPairingV1Feature = "join-pairing-v1"

// A Relay that already has its invitation asks Hearth, with this request
// header (milliseconds), to hold its announcement until there's something
// new to answer: someone confirmed it, Hearth saved it, or the join ended.
// Hearth caps the wait, and says it held the announcement with
// `relayJoinHeldHeader`, so the Relay asks again at once rather than after
// its usual pause. Hearths that predate it answer at once, as before.
export const relayJoinHoldHeader = "kiln-join-hold"
export const relayJoinHeldHeader = "kiln-join-held"
// On an answer once Hearth saved the Relay: the Relay dials Hearth then, and
// Hearth knows it. A hold that ran out first answers without it. The Relay
// sends it back once it knows, and until then Hearth answers it at once
// rather than hold news the Relay hasn't heard.
export const relayJoinSavedHeader = "kiln-join-saved"
// The longest Hearth holds an announcement, well inside any proxy's deadline
// between them. The Relay waits that much longer than usual for an answer.
export const RELAY_JOIN_HOLD_MAX_MS = 10_000

const PEM = Schema.String.check(
  Schema.isMinLength(80),
  Schema.isMaxLength(2_048)
)

// Hearth's signed pairing request (`RelayPairingRequestContract`).
export const RelayJoinPairingRequestSchema = Schema.Struct({
  bootstrapProof: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
  hearthName: Schema.String.check(Schema.isMaxLength(256)),
  hearthOrigin: Schema.String.check(Schema.isMaxLength(512)),
  invitationId: Schema.String.check(Schema.isMaxLength(128)),
  nonce: Schema.String.check(Schema.isMaxLength(128)),
  publicKeyPem: PEM,
  signature: Schema.String.check(Schema.isMaxLength(512)),
  token: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
  version: Schema.Literal(1),
})

// The Relay's signed reply (`RelayPairingResponseContract`).
export const RelayJoinPairingResponseSchema = Schema.Struct({
  actions: Schema.Array(Schema.String.check(Schema.isMaxLength(128))).check(
    Schema.isMaxLength(256)
  ),
  clientId: Schema.String.check(Schema.isPattern(FINGERPRINT)),
  expiresAt: Schema.Number,
  nonce: Schema.String.check(Schema.isMaxLength(128)),
  relayFingerprint: Schema.String.check(Schema.isPattern(FINGERPRINT)),
  relayName: Schema.String.check(Schema.isMaxLength(120)),
  relayPublicKeyPem: PEM,
  role: Schema.Literals(["custom", "full_access", "read_only"]),
  signature: Schema.String.check(Schema.isMaxLength(512)),
  version: Schema.Literal(1),
})

export const RelayJoinAnnouncementSchema = Schema.Struct({
  envelope: RelayJoinEnvelopeSchema,
  // What the Relay can do, such as `relayJoinPairingV1Feature`. Outside the
  // MAC, so Hearths that predate it check announcements as before; it only
  // ever offers something, which Hearth's own answer then asks for.
  features: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(64))).check(
      Schema.isMaxLength(32)
    )
  ),
  joinId: Schema.String.check(Schema.isPattern(JOIN_ID)),
  mac: Schema.String.check(Schema.isMaxLength(128)),
  nonce: Schema.String.check(Schema.isPattern(/^[A-Za-z\d_-]{22,86}$/u)),
  // The Relay's reply to the pairing request Hearth's answer carried. It's
  // signed with the Relay's key, which is what Hearth checks.
  pairing: Schema.optionalKey(RelayJoinPairingResponseSchema),
  version: Schema.Literal(1),
})

export type RelayJoinAnnouncement = typeof RelayJoinAnnouncementSchema.Type

export const relayJoinStatuses = [
  // Hearth has it and waits for someone to confirm it.
  "pending",
  "paired",
  "expired",
  // Another Relay announced itself for this join first.
  "claimed",
] as const

export type RelayJoinStatus = (typeof relayJoinStatuses)[number]

export const RelayJoinResponseSchema = Schema.Struct({
  // While it's pending: the Hearth client that may pair, by key
  // fingerprint, and when the join expires.
  clientId: Schema.NullOr(Schema.String.check(Schema.isPattern(FINGERPRINT))),
  expiresAt: Schema.NullOr(Schema.Number),
  mac: Schema.String.check(Schema.isMaxLength(128)),
  // For a Relay with `relayJoinPairingV1Feature`, once someone confirmed it:
  // Hearth's pairing request, and where the Relay should open its control
  // connection to Hearth (or null when it can't).
  pairing: Schema.optionalKey(
    Schema.Struct({
      dialUrl: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
      request: RelayJoinPairingRequestSchema,
    })
  ),
  status: Schema.Literals(relayJoinStatuses),
})

export type RelayJoinResponse = typeof RelayJoinResponseSchema.Type

/** What the Relay's announcement MAC covers: every field, in order. */
export function relayJoinAnnouncementTranscript(
  announcement: Omit<RelayJoinAnnouncement, "mac">
): string {
  const { envelope } = announcement
  return JSON.stringify([
    "kiln.relay-join.announce.v1",
    announcement.joinId,
    announcement.nonce,
    envelope.browserOrigin,
    envelope.caCertificatePem,
    envelope.controlEndpoint,
    envelope.installation.id,
    envelope.installation.fixed,
    envelope.installation.replace,
    envelope.invitationId,
    envelope.relayBuild,
    envelope.relayFingerprint,
    envelope.relayName,
    envelope.relayPublicKeyPem,
  ])
}

/** What Hearth's answer MAC covers: the Relay's nonce and everything else. */
export function relayJoinResponseTranscript(
  input: Omit<RelayJoinResponse, "mac"> & {
    readonly joinId: string
    readonly nonce: string
  }
): string {
  return JSON.stringify([
    "kiln.relay-join.response.v1",
    input.joinId,
    input.nonce,
    input.status,
    input.clientId,
    input.expiresAt,
    ...(input.pairing
      ? [
          "pairing",
          input.pairing.dialUrl,
          input.pairing.request.bootstrapProof,
          input.pairing.request.hearthName,
          input.pairing.request.hearthOrigin,
          input.pairing.request.invitationId,
          input.pairing.request.nonce,
          input.pairing.request.publicKeyPem,
          input.pairing.request.signature,
          input.pairing.request.token,
        ]
      : []),
  ])
}
