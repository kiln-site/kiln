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

export const RelayJoinAnnouncementSchema = Schema.Struct({
  envelope: RelayJoinEnvelopeSchema,
  joinId: Schema.String.check(Schema.isPattern(JOIN_ID)),
  mac: Schema.String.check(Schema.isMaxLength(128)),
  nonce: Schema.String.check(Schema.isPattern(/^[A-Za-z\d_-]{22,86}$/u)),
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
  ])
}
