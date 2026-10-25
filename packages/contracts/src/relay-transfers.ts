/**
 * Transfers between Relays. Hearth asks the source Relay to pack files
 * under one of its file roots into an artifact, signs a grant naming that
 * artifact and the destination Relay, and asks the destination to pull it.
 * The destination fetches the artifact straight from the source with Range
 * requests, so an interrupted pull resumes, checks its SHA-256 against the
 * grant, and installs it. Hearth never carries the bytes.
 */
import { Schema } from "effect"

// The Relay packs, serves, and pulls transfers through `transfer.*`.
export const relayPeerTransfersV1Feature = "peer-transfers-v1"

/** The HTTP route a source Relay serves an artifact on. */
export function relayPeerTransferPath(transferId: string): string {
  return `/v1/peer/transfers/${encodeURIComponent(transferId)}`
}

const TransferId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{8,64}$/u)
)
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const ByteCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const RelativePath = Schema.String.check(Schema.isMaxLength(2_048))

/**
 * What Hearth signs, with the key it is paired to the source Relay under,
 * to let one destination Relay fetch one artifact until it expires.
 */
export const RelayPeerTransferGrantSchema = Schema.Struct({
  /** The source Relay's ID. */
  audience: Schema.String,
  expiresAt: Schema.Number,
  issuedAt: Schema.Number,
  /** Hearth's client ID on the source Relay. */
  issuer: Schema.String,
  /** The destination Relay's ID, the fingerprint of its identity key. */
  peer: Schema.String,
  sha256: Sha256,
  size: ByteCount,
  transferId: TransferId,
  version: Schema.Literal(1),
})
export type RelayPeerTransferGrant = typeof RelayPeerTransferGrantSchema.Type

/**
 * What the destination Relay signs with its identity key for each request,
 * so a grant is only good in the hands of the Relay it names.
 */
export function relayPeerTransferProofTranscript(input: {
  readonly audience: string
  readonly method: "GET" | "HEAD"
  readonly nonce: string
  readonly range: string
  readonly requestedAt: number
  readonly transferId: string
}): string {
  return JSON.stringify([
    "kiln-relay-peer-transfer.v1",
    "request-proof",
    input.audience,
    input.transferId,
    input.method,
    input.range,
    input.nonce,
    input.requestedAt,
  ])
}

/** `transfer.source.prepare`: pack files under a root into an artifact. */
export const RelayTransferSourcePrepareSchema = Schema.Struct({
  transferId: TransferId,
  /** A file root: a game server's ID, `app:<appId>`, or the Relay's own. */
  rootId: Schema.String.check(Schema.isMaxLength(128)),
  /** Paths under the root to pack; none packs the whole root. */
  paths: Schema.Array(RelativePath).check(Schema.isMaxLength(5_000)),
})
export type RelayTransferSourcePrepare =
  typeof RelayTransferSourcePrepareSchema.Type

export const RelayTransferSourceStateSchema = Schema.Literals([
  "packing",
  "ready",
  "failed",
])

/** A source Relay's artifact, as `transfer.source.*` report it. */
export const RelayTransferSourceSchema = Schema.Struct({
  transferId: TransferId,
  rootId: Schema.String,
  state: RelayTransferSourceStateSchema,
  /** Set once the artifact is ready. */
  size: Schema.NullOr(ByteCount),
  sha256: Schema.NullOr(Sha256),
  entries: Schema.NullOr(ByteCount),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  /** When the Relay deletes the artifact if nobody has. */
  expiresAt: Schema.Number,
})
export type RelayTransferSource = typeof RelayTransferSourceSchema.Type

/**
 * Where a destination may reach the source: its Relay listener, trusted
 * through the CA Hearth pinned for it, or its public browser origin,
 * trusted through the system's CAs. The destination tries them in order.
 */
export const RelayPeerEndpointSchema = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(2_048)),
  caCertificatePem: Schema.NullOr(
    Schema.String.check(Schema.isMaxLength(16_384))
  ),
})
export type RelayPeerEndpoint = typeof RelayPeerEndpointSchema.Type

/** `transfer.pull.start`: fetch an artifact and install it under a root. */
export const RelayTransferPullStartSchema = Schema.Struct({
  transferId: TransferId,
  /** The signed grant, `<payload>.<signature>` in base64url. */
  grant: Schema.String.check(Schema.isMaxLength(16_384)),
  endpoints: Schema.Array(RelayPeerEndpointSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(4)
  ),
  target: Schema.Struct({
    rootId: Schema.String.check(Schema.isMaxLength(128)),
    /**
     * The folder to install into, which must be missing or empty; empty
     * for the root itself.
     */
    path: RelativePath,
  }),
})
export type RelayTransferPullStart = typeof RelayTransferPullStartSchema.Type

export const RelayTransferPullStateSchema = Schema.Literals([
  "pulling",
  "verifying",
  "installing",
  "completed",
  "failed",
  "cancelled",
])
export type RelayTransferPullState = typeof RelayTransferPullStateSchema.Type

/** A destination Relay's pull, as `transfer.pull.*` report it. */
export const RelayTransferPullSchema = Schema.Struct({
  transferId: TransferId,
  state: RelayTransferPullStateSchema,
  receivedBytes: ByteCount,
  size: ByteCount,
  target: RelayTransferPullStartSchema.fields.target,
  /** The endpoint the pull reached the source through, once it has. */
  endpoint: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type RelayTransferPull = typeof RelayTransferPullSchema.Type

/**
 * `transfer.source.get`, `.discard`, `transfer.pull.get`, `.cancel`. The
 * root is the transfer's source or target root, which the Relay checks the
 * caller may read or write, and that the transfer is for.
 */
export const RelayTransferReferenceSchema = Schema.Struct({
  transferId: TransferId,
  rootId: Schema.String.check(Schema.isMaxLength(128)),
})
export type RelayTransferReference = typeof RelayTransferReferenceSchema.Type
