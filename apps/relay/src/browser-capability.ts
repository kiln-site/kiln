/**
 * The capabilities Hearth signs for a browser: decoding, checking them
 * against the client that issued them, and the authority they grant. Shared
 * by the browser socket and the Relay's direct file transfers.
 */
import { createHash, verify } from "node:crypto"
import { Schema } from "effect"

import {
  RelayBrowserCapabilitySchema,
  relayConsoleReadActions,
} from "@workspace/contracts"
import type {
  RelayBrowserCapability,
  RelayBrowserCapabilityV2,
  RelayBrowserResourceKind,
} from "@workspace/contracts"

import {
  authorityFromCapability,
  type BrowserSessionAuthority,
} from "./browser-session-registry.js"
import {
  BROWSER_ISSUED_AT_SKEW_MS,
  BROWSER_READ_LEASE_MAX_MS,
  BROWSER_WRITE_LEASE_MAX_MS,
} from "./browser-security.js"
import type { RelayClientGrant } from "./effect/state.js"
import { actionsForRole } from "./permissions.js"

/** The P-256 key a browser proves its requests with. */
export const BrowserPublicKeySchema = Schema.Struct({
  crv: Schema.Literal("P-256"),
  kty: Schema.Literal("EC"),
  x: Schema.String,
  y: Schema.String,
})

export type DecodedBrowserCapability = ReturnType<typeof decodeCapability>

export function decodeCapability(value: string): {
  encoded: string
  payload: RelayBrowserCapability
  signature: string
} {
  if (value.length > 16_384) throw new Error("Capability is too large")
  const [encoded, signature, extra] = value.split(".")
  if (!encoded || !signature || extra) throw new Error("Invalid capability")
  return {
    encoded,
    payload: Schema.decodeUnknownSync(RelayBrowserCapabilitySchema)(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown
    ),
    signature,
  }
}

export function validateCapability(
  capability: ReturnType<typeof decodeCapability>,
  client: RelayClientGrant,
  origin: string,
  relayId: string,
  requiredAction: string | null
): void {
  const now = Date.now()
  const payload = capability.payload
  if (payload.version === 2) validateCapabilityV2(payload, now)
  // From the client's role, as the control socket does, so a client paired
  // before an action existed still has every action its role grants.
  const clientActions: ReadonlyArray<string> = actionsForRole(
    client.role,
    client.actions
  )
  if (
    payload.audience !== relayId ||
    payload.expiresAt <= now ||
    payload.issuedAt > now + 5_000 ||
    payload.origin !== origin ||
    !client.origins.includes(origin) ||
    payload.actions.length === 0 ||
    (requiredAction !== null && !clientActions.includes(requiredAction)) ||
    (requiredAction !== null && !payload.actions.includes(requiredAction)) ||
    payload.actions.some((action) => !clientActions.includes(action)) ||
    !verify(
      null,
      Buffer.from(capability.encoded),
      client.publicKey,
      Buffer.from(capability.signature, "base64url")
    )
  ) {
    throw new Error("Browser capability is invalid")
  }
}

function validateCapabilityV2(
  capability: RelayBrowserCapabilityV2,
  now: number
): void {
  const allowed = new Set(
    browserCapabilityActions[capability.resourceKind ?? "instance"][
      capability.operation
    ]
  )
  const writes = capability.actions.some(
    (action) =>
      action === "instance.console.write" ||
      action === "instance.files.upload" ||
      action === "app.files.upload" ||
      action === "relay.files.upload" ||
      action === "database.dump.import"
  )
  const maximumLease = writes
    ? BROWSER_WRITE_LEASE_MAX_MS
    : BROWSER_READ_LEASE_MAX_MS
  if (
    !Number.isSafeInteger(capability.issuedAt) ||
    !Number.isSafeInteger(capability.expiresAt) ||
    !Number.isSafeInteger(capability.authorizationRevision) ||
    !Number.isSafeInteger(capability.issuerGeneration) ||
    capability.authorizationRevision < 0 ||
    capability.issuerGeneration < 0 ||
    capability.expiresAt <= capability.issuedAt ||
    capability.expiresAt - capability.issuedAt > maximumLease ||
    capability.issuedAt > now + BROWSER_ISSUED_AT_SKEW_MS ||
    capability.actions.length > allowed.size ||
    capability.actions.some((action) => !allowed.has(action)) ||
    new Set(capability.actions).size !== capability.actions.length ||
    capability.loginSessionId.length === 0 ||
    capability.loginSessionId.length > 240 ||
    capability.subject.length === 0 ||
    capability.subject.length > 240 ||
    capability.capabilityId.length === 0 ||
    capability.capabilityId.length > 240 ||
    (capability.operation === "file") !== (capability.path !== null) ||
    (capability.path?.length ?? 0) > 2_048
  ) {
    throw new Error("Browser capability v2 is invalid")
  }
}

// The actions a v2 capability may carry, by resource kind and operation.
const browserCapabilityActions: Record<
  RelayBrowserResourceKind,
  Record<RelayBrowserCapabilityV2["operation"], ReadonlyArray<string>>
> = {
  app: {
    console: [relayConsoleReadActions.app],
    file: ["app.files.download", "app.files.upload"],
    resources: ["app.read"],
  },
  // A database's files are its dumps (`database:<databaseId>`).
  database: {
    console: [relayConsoleReadActions.database],
    file: ["database.dump.export", "database.dump.import"],
    resources: ["database.read"],
  },
  instance: {
    console: [relayConsoleReadActions.instance, "instance.console.write"],
    file: ["instance.files.download", "instance.files.upload"],
    resources: ["instance.read"],
  },
  relay: {
    console: [relayConsoleReadActions.relay],
    file: ["relay.files.download", "relay.files.upload"],
    resources: [],
  },
  platform: {
    console: [relayConsoleReadActions.platform],
    file: [],
    resources: [],
  },
}

// Capabilities name the kind of resource they are for; v1 capabilities and
// v2 ones without a kind are for servers.
export function capabilityResourceKind(
  capability: RelayBrowserCapability
): RelayBrowserResourceKind {
  return capability.version === 2
    ? (capability.resourceKind ?? "instance")
    : "instance"
}

// The server whose access revisions apply to the capability, if it is for
// one. Other kinds are revised for the person across the Relay.
export function serverScopeId(
  capability: RelayBrowserCapability
): string | null {
  return capabilityResourceKind(capability) === "instance"
    ? capability.instanceId
    : null
}

export function browserAuthority(
  capability: RelayBrowserCapability
): BrowserSessionAuthority {
  if (capability.version === 2) return authorityFromCapability(capability)
  return {
    actions: new Set(capability.actions),
    expiresAt: capability.expiresAt,
    instanceId: capability.instanceId,
    resourceKind: "instance",
    issuer: capability.issuer,
    issuerGeneration: 0,
    keyThumbprint: capability.keyThumbprint,
    loginSessionId: null,
    operation: capability.actions.includes("instance.read")
      ? "resources"
      : "console",
    origin: capability.origin,
    revision: 0,
    subject: capability.subject,
    version: 1,
  }
}

export function browserKeyThumbprint(jwk: {
  readonly crv: "P-256"
  readonly kty: "EC"
  readonly x: string
  readonly y: string
}): string {
  return createHash("sha256")
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest("base64url")
}
