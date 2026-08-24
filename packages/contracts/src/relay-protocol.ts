import { Schema } from "effect"

export const relayControlProtocol = "kiln-relay.v1" as const
// Release compatibility level for response-shape changes. Keep this separate
// from the WebSocket subprotocol so Hearth can be upgraded before Relay.
export const relayControlProtocolVersion = 3 as const
export const relayBrowserProtocol = "kiln-relay-browser.v1" as const
export const relayBrowserConsoleProtocol = "kiln-relay-browser.v2" as const
export const relayBrowserConsoleProtocols = [
  relayBrowserConsoleProtocol,
  relayBrowserProtocol,
] as const
export const relayBrowserMaxFrameBytes = 256 * 1024
// Shared safety cap for relay<->hearth control frames. File listings and
// search results are paged well below this boundary.
export const relayControlMaxFrameBytes = 1024 * 1024
export const relayPairingProtocol = "kiln-relay-pair.v1" as const
export const relayAuthenticationWindowMs = 10_000

export const relayControlOperations = [
  "relay.snapshot",
  "relay.system.inspect",
  "relay.update.apply",
  "relay.update.status",
  "relay.rename",
  "relay.audit.list",
  "relay.networking.read",
  "relay.networking.write",
  "relay.tailscale.install",
  "relay.tailscale.read",
  "relay.tailscale.write",
  "relay.tailscale.stack.apply",
  "relay.tailscale.stack.dns",
  "relay.tailscale.stack.list",
  "relay.tailscale.stack.remove",
  "relay.proxy.read",
  "relay.proxy.write",
  "relay.pairing.create",
  "relay.pairing.list",
  "relay.pairing.revoke",
  "relay.clients.list",
  "relay.clients.update",
  "relay.clients.revoke",
  "brick.catalog",
  "brick.recipe",
  "database.list",
  "database.create",
  "database.delete",
  "database.action",
  "database.credentials.rotate",
  "database.network.write",
  "database.dump.export",
  "database.dump.import",
  "backup.task.enqueue",
  "backup.task.cancel",
  "backup.task.get",
  "backup.task.list",
  "schedule.apply",
  "schedule.run",
  "schedule.remove",
  "schedule.overview",
  "instance.create",
  "instance.provision.prepare",
  "instance.provision.claim",
  "instance.provision.cancel",
  "instance.startup.write",
  "instance.rename",
  "instance.delete",
  "instance.action",
  "instance.resources.read",
  "instance.files.list",
  "instance.files.directory.list",
  "instance.files.search",
  "instance.files.stat",
  "instance.files.read",
  "instance.files.write",
  "instance.files.upload-url",
  "instance.files.mutate",
  "instance.files.mutate.result",
  "instance.console.history",
  "instance.console.write",
  "instance.console.complete",
  "instance.logs.share",
  "instance.logs.latest",
  "instance.network.ports.reserve",
  "instance.network.ports.release",
  "instance.network.ports.write",
  "instance.network.routes.read",
  "instance.network.routes.write",
  "hearth.tailscale.instance.detach",
  "sftp.authorization.resolve",
] as const

export type RelayControlOperation = (typeof relayControlOperations)[number]

export function relayControlDeadlineMs(
  operation: RelayControlOperation
): number {
  if (operation === "relay.update.apply") return 15 * 60_000
  if (operation === "relay.tailscale.install") return 240_000
  if (operation === "relay.tailscale.stack.apply") return 240_000
  if (operation === "relay.tailscale.stack.remove") return 120_000
  if (operation === "hearth.tailscale.instance.detach") return 60_000
  if (operation === "instance.delete") return 360_000
  if (operation === "database.create") return 360_000
  if (operation === "database.delete") return 180_000
  if (operation === "database.credentials.rotate") return 180_000
  if (operation === "database.dump.export") return 120_000
  if (operation === "database.dump.import") return 120_000
  if (operation === "instance.action") return 180_000
  if (
    operation === "schedule.apply" ||
    operation === "schedule.run" ||
    operation === "schedule.remove"
  ) {
    return 30_000
  }
  if (operation === "instance.logs.share") return 60_000
  if (
    operation === "instance.create" ||
    operation === "instance.startup.write" ||
    operation === "instance.files.upload-url"
  ) {
    return 360_000
  }
  return operation === "instance.network.ports.write" ||
    operation === "instance.network.routes.write"
    ? 240_000
    : 30_000
}

export const RelayControlOperationSchema = Schema.Literals(
  relayControlOperations
)

export const RelayAuthChallengeSchema = Schema.Struct({
  expiresAt: Schema.Number,
  nonce: Schema.String,
  relayId: Schema.String,
  sessionId: Schema.String,
  signature: Schema.String,
  type: Schema.Literal("auth.challenge"),
  v: Schema.Literal(1),
})

export const RelayAuthResponseSchema = Schema.Struct({
  clientId: Schema.String,
  signature: Schema.String,
  type: Schema.Literal("auth.response"),
  v: Schema.Literal(1),
})

export const RelayAuthReadySchema = Schema.Struct({
  actions: Schema.Array(Schema.String),
  clientId: Schema.String,
  protocol: Schema.Literal(relayControlProtocol),
  relayBuild: Schema.String,
  role: Schema.Literals(["full_access", "read_only", "custom"]),
  type: Schema.Literal("auth.ready"),
  v: Schema.Literal(1),
})

export const RelayControlRequestSchema = Schema.Struct({
  // Retain the absolute deadline while v1 peers are still in the fleet. New
  // peers use timeoutMs so request enforcement does not depend on host clocks.
  deadline: Schema.Number,
  id: Schema.String,
  operation: RelayControlOperationSchema,
  payload: Schema.Unknown,
  subject: Schema.optionalKey(Schema.String),
  timeoutMs: Schema.optionalKey(Schema.Number),
  type: Schema.Literal("request"),
  v: Schema.Literal(1),
})

export const RelayControlCancelSchema = Schema.Struct({
  id: Schema.String,
  replyTo: Schema.String,
  type: Schema.Literal("cancel"),
  v: Schema.Literal(1),
})

export const RelayControlResponseSchema = Schema.Struct({
  id: Schema.String,
  payload: Schema.Unknown,
  replyTo: Schema.String,
  type: Schema.Literal("response"),
  v: Schema.Literal(1),
})

export const RelayControlErrorSchema = Schema.Struct({
  code: Schema.String,
  id: Schema.String,
  message: Schema.String,
  replyTo: Schema.NullOr(Schema.String),
  retryable: Schema.Boolean,
  type: Schema.Literal("error"),
  v: Schema.Literal(1),
})

export const RelayControlEventSchema = Schema.Struct({
  event: Schema.String,
  id: Schema.String,
  payload: Schema.Unknown,
  seq: Schema.Number,
  type: Schema.Literal("event"),
  v: Schema.Literal(1),
})

export const RelayControlClientMessageSchema = Schema.Union([
  RelayAuthResponseSchema,
  RelayControlRequestSchema,
  RelayControlCancelSchema,
  RelayControlResponseSchema,
  RelayControlErrorSchema,
])

export const RelayControlServerMessageSchema = Schema.Union([
  RelayAuthChallengeSchema,
  RelayAuthReadySchema,
  RelayControlCancelSchema,
  RelayControlResponseSchema,
  RelayControlErrorSchema,
  RelayControlEventSchema,
  RelayControlRequestSchema,
])

export type RelayAuthChallenge = typeof RelayAuthChallengeSchema.Type
export type RelayAuthResponse = typeof RelayAuthResponseSchema.Type
export type RelayAuthReady = typeof RelayAuthReadySchema.Type
export type RelayControlRequest = typeof RelayControlRequestSchema.Type
export type RelayControlCancel = typeof RelayControlCancelSchema.Type
export type RelayControlResponse = typeof RelayControlResponseSchema.Type
export type RelayControlError = typeof RelayControlErrorSchema.Type
export type RelayControlEvent = typeof RelayControlEventSchema.Type
export type RelayControlClientMessage =
  typeof RelayControlClientMessageSchema.Type
export type RelayControlServerMessage =
  typeof RelayControlServerMessageSchema.Type

export function relayControlRequestTimeoutMs(
  request: RelayControlRequest,
  receivedAt: number
): number | null {
  const requested = request.timeoutMs ?? request.deadline - receivedAt
  if (!Number.isFinite(requested) || requested <= 0) return null
  return Math.min(requested, relayControlDeadlineMs(request.operation))
}

export function relayAuthChallengeTranscript(
  challenge: Omit<RelayAuthChallenge, "signature">
): string {
  return JSON.stringify([
    relayControlProtocol,
    "challenge",
    challenge.relayId,
    challenge.sessionId,
    challenge.nonce,
    challenge.expiresAt,
  ])
}

export function relayAuthResponseTranscript(
  challenge: Omit<RelayAuthChallenge, "signature">,
  clientId: string
): string {
  return JSON.stringify([
    relayControlProtocol,
    "response",
    challenge.relayId,
    clientId,
    challenge.sessionId,
    challenge.nonce,
    challenge.expiresAt,
  ])
}

export interface RelayPairingRequestContract {
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

export interface RelayPairingResponseContract {
  readonly actions: ReadonlyArray<string>
  readonly clientId: string
  readonly expiresAt: number
  readonly nonce: string
  readonly relayFingerprint: string
  readonly relayName: string
  readonly relayPublicKeyPem: string
  readonly role: "custom" | "full_access" | "read_only"
  readonly signature: string
  readonly version: 1
}

export function relayPairingRequestTranscript(
  request: RelayPairingRequestContract
): string {
  return JSON.stringify([
    relayPairingProtocol,
    "request",
    request.invitationId,
    request.token
      ? ["token", request.token]
      : ["bootstrap", request.bootstrapProof],
    request.hearthName,
    new URL(request.hearthOrigin).origin,
    request.nonce,
    request.publicKeyPem,
  ])
}

export function relayBootstrapDiscoveryTranscript(input: {
  readonly clientNonce: string
  readonly controlEndpoint: string
  readonly expiresAt: number
  readonly invitationId: string
  readonly relayFingerprint: string
  readonly relayPublicKeyPem: string
  readonly serverNonce: string
  readonly tlsFingerprint: string
}): string {
  return JSON.stringify([
    relayPairingProtocol,
    "bootstrap-discovery",
    input.clientNonce,
    input.serverNonce,
    input.tlsFingerprint,
    input.relayFingerprint,
    input.relayPublicKeyPem,
    input.controlEndpoint,
    input.invitationId,
    input.expiresAt,
  ])
}

export function relayBootstrapEnrollmentTranscript(
  request: Pick<
    RelayPairingRequestContract,
    | "hearthName"
    | "hearthOrigin"
    | "invitationId"
    | "nonce"
    | "publicKeyPem"
    | "version"
  >
): string {
  return JSON.stringify([
    relayPairingProtocol,
    "bootstrap-enrollment",
    request.invitationId,
    request.hearthName,
    new URL(request.hearthOrigin).origin,
    request.nonce,
    request.publicKeyPem,
  ])
}

export function relayPairingResponseTranscript(
  response: Omit<RelayPairingResponseContract, "signature">
): string {
  return JSON.stringify([
    relayPairingProtocol,
    "response",
    response.clientId,
    response.relayFingerprint,
    response.relayName,
    response.relayPublicKeyPem,
    response.role,
    response.actions,
    response.nonce,
    response.expiresAt,
  ])
}

export function relayBrowserProofTranscript(
  input: {
    readonly capabilityId: string
    readonly expiresAt: number
    readonly nonce: string
    readonly relayId: string
    readonly sessionId: string
  },
  protocol:
    | typeof relayBrowserProtocol
    | typeof relayBrowserConsoleProtocol = relayBrowserProtocol
): string {
  return JSON.stringify([
    protocol,
    "proof",
    input.relayId,
    input.sessionId,
    input.nonce,
    input.expiresAt,
    input.capabilityId,
  ])
}

export function relayBrowserRequestProofTranscript(input: {
  readonly capabilityId: string
  readonly expiresAt: number
  readonly instanceId: string
  readonly method: "GET" | "HEAD" | "POST" | "PUT"
  readonly nonce: string
  readonly path: string
  readonly relayId: string
  readonly requestedAt: number
}): string {
  return JSON.stringify([
    relayBrowserProtocol,
    "request-proof",
    input.relayId,
    input.capabilityId,
    input.expiresAt,
    input.method,
    input.instanceId,
    input.path,
    input.nonce,
    input.requestedAt,
  ])
}
