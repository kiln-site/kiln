import { Schema } from "effect"

// Joining: a new Relay pairs with a Hearth from one link, copied out of
// Hearth's Add Relay dialog into the Relay's install command.
//
// The link is `<hearth origin>/#kiln-relay-join=v1.<join>.<secret>.<client>.
// <expires>`. It travels from Hearth to the Relay through the operator, so
// the Relay trusts what it says: which Hearth client may pair (`client`, the
// fingerprint of a key Hearth made for this join) and until when. The
// secret never leaves the two machines: the Relay proves it holds it with an
// HMAC over its announcement, and Hearth answers with one over the Relay's
// nonce, so a network between them can delay joining but not take it over.

export const RELAY_JOIN_FRAGMENT = "kiln-relay-join"
// A join lasts this long from when Hearth makes it.
export const RELAY_JOIN_LIFETIME_MS = 30 * 60_000

const FINGERPRINT = /^[A-Za-z\d_-]{43}$/u
const SECRET = /^[A-Za-z\d_-]{43}$/u
const UUID =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u

export interface RelayJoinLink {
  readonly clientId: string
  readonly expiresAt: number
  readonly hearthOrigin: string
  readonly joinId: string
  readonly secret: string
}

export function encodeRelayJoinLink(link: RelayJoinLink): string {
  return `${link.hearthOrigin}/#${RELAY_JOIN_FRAGMENT}=v1.${link.joinId}.${link.secret}.${link.clientId}.${link.expiresAt}`
}

/** The join a link describes, or null when it isn't a valid one. */
export function decodeRelayJoinLink(value: string): RelayJoinLink | null {
  if (value.length > 2_048 || !URL.canParse(value.trim())) return null
  const url = new URL(value.trim())
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    return null
  }
  const prefix = `#${RELAY_JOIN_FRAGMENT}=v1.`
  if (!url.hash.startsWith(prefix)) return null
  const [joinId, secret, clientId, expires, ...rest] = url.hash
    .slice(prefix.length)
    .split(".")
  const expiresAt = Number(expires)
  if (
    rest.length > 0 ||
    !joinId ||
    !UUID.test(joinId) ||
    !secret ||
    !SECRET.test(secret) ||
    !clientId ||
    !FINGERPRINT.test(clientId) ||
    !/^\d{1,16}$/u.test(expires ?? "") ||
    !Number.isSafeInteger(expiresAt)
  ) {
    return null
  }
  return { clientId, expiresAt, hearthOrigin: url.origin, joinId, secret }
}

/** The link with its secret left out, for logs and output. */
export function redactRelayJoinLink(link: RelayJoinLink): string {
  return `${link.hearthOrigin}/#${RELAY_JOIN_FRAGMENT}=v1.${link.joinId}.…`
}

// The pairing token of the invitation a join creates, derived from the
// join's secret so the two are never the same value.
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
  expiresAt: Schema.Number,
  installation: RelayJoinInstallationSchema,
  invitationId: Schema.String.check(Schema.isPattern(UUID)),
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
  joinId: Schema.String.check(Schema.isPattern(UUID)),
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
  mac: Schema.String.check(Schema.isMaxLength(128)),
  status: Schema.Literals(relayJoinStatuses),
})

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
    envelope.expiresAt,
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

/** What Hearth's answer MAC covers: the Relay's nonce and the status. */
export function relayJoinResponseTranscript(input: {
  readonly joinId: string
  readonly nonce: string
  readonly status: RelayJoinStatus
}): string {
  return JSON.stringify([
    "kiln.relay-join.response.v1",
    input.joinId,
    input.nonce,
    input.status,
  ])
}
