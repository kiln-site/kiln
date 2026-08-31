import { createHash, randomUUID, sign } from "node:crypto"

import * as Sentry from "@sentry/tanstackstart-react"
import {
  relayProxyBrowserMetadataSchema,
  relayProxyDiagnosticsSchema,
  relayProxySettingsSchema,
} from "@workspace/contracts"

import { requireRelayPermission } from "@/lib/access-control"
import { recoverPromise } from "@/effect/promise"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { kilnPublicUrl } from "@/lib/environment"
import { listPersistedRelays, loadRelayCredentials } from "@/lib/relay-registry"

type BrowserPublicKey = {
  crv: "P-256"
  kty: "EC"
  x: string
  y: string
}

type BrowserAction =
  | "instance.console.read"
  | "instance.console.write"
  | "instance.files.download"
  | "instance.files.upload"
  | "instance.read"

export async function issueConsoleCapabilityForUser(input: {
  instanceId: string
  publicKeyJwk: BrowserPublicKey
  relayId: string
  user: AuthenticatedUser
  write: boolean
}) {
  const relay = await requireRelay(input.relayId)
  await requireRelayPermission({
    instanceId: input.instanceId,
    permission: "instance.console.read",
    relayId: relay.id,
    user: input.user,
  })
  if (input.write) {
    await requireRelayPermission({
      instanceId: input.instanceId,
      permission: "instance.console.write",
      relayId: relay.id,
      user: input.user,
    })
  }
  return createBrowserCapability({
    actions: input.write
      ? ["instance.console.read", "instance.console.write"]
      : ["instance.console.read"],
    instanceId: input.instanceId,
    path: null,
    publicKeyJwk: input.publicKeyJwk,
    relay,
    subject: input.user.id,
  })
}

export async function issueResourceCapabilityForUser(input: {
  instanceId: string
  publicKeyJwk: BrowserPublicKey
  relayId: string
  user: AuthenticatedUser
}) {
  const relay = await requireRelay(input.relayId)
  await requireRelayPermission({
    instanceId: input.instanceId,
    permission: "instance.read",
    relayId: relay.id,
    user: input.user,
  })
  return createBrowserCapability({
    actions: ["instance.read"],
    instanceId: input.instanceId,
    path: null,
    publicKeyJwk: input.publicKeyJwk,
    relay,
    subject: input.user.id,
  })
}

export async function issueFileCapabilityForUser(input: {
  action: "instance.files.download" | "instance.files.upload"
  instanceId: string
  path: string
  publicKeyJwk: BrowserPublicKey
  relayId: string
  user: AuthenticatedUser
}) {
  const relay = await requireRelay(input.relayId)
  await requireRelayPermission({
    instanceId: input.instanceId,
    permission:
      input.action === "instance.files.upload"
        ? "instance.files.write"
        : "instance.files.read",
    relayId: relay.id,
    user: input.user,
  })
  return createBrowserCapability({
    actions: [input.action],
    instanceId: input.instanceId,
    path: input.path,
    publicKeyJwk: input.publicKeyJwk,
    relay,
    subject: input.user.id,
  })
}

async function requireRelay(relayId: string) {
  const relay = (await listPersistedRelays()).find(
    (item) => item.enabled && item.id === relayId
  )
  if (!relay) throw new Error("Relay is not available")
  return relay
}

async function createBrowserCapability(input: {
  actions: ReadonlyArray<BrowserAction>
  instanceId: string
  path: string | null
  publicKeyJwk: BrowserPublicKey
  relay: Awaited<ReturnType<typeof listPersistedRelays>>[number]
  subject: string
}) {
  const [{ relayRpc }, credentials] = await Promise.all([
    import("@/lib/relay-connection"),
    loadRelayCredentials(input.relay.id),
  ])
  const proxy = await Sentry.startSpan(
    {
      name: "Resolve Relay browser metadata",
      op: "rpc.relay.browser-metadata",
      attributes: { "relay.id": input.relay.id },
    },
    (span) =>
      recoverPromise(
        async () => {
          const value = await relayRpc(
            input.relay,
            "relay.proxy.read",
            { includeDiagnostics: false },
            5_000
          )
          if (!value || typeof value !== "object") {
            span.setAttribute(
              "kiln.console.metadata_shape",
              "registry_fallback"
            )
            return null
          }
          const response = Object.fromEntries(Object.entries(value))
          const metadata = relayProxyBrowserMetadataSchema.safeParse(response)
          if (metadata.success) {
            span.setAttribute("kiln.console.metadata_shape", "lightweight")
            return metadata.data
          }
          // Relays predating the lightweight metadata hint ignore its payload
          // and return full diagnostics. Keep rolling upgrades compatible
          // without adding a second RPC.
          const diagnostics = relayProxyDiagnosticsSchema.parse(
            response.diagnostics
          )
          const settings = relayProxySettingsSchema.parse(response.settings)
          span.setAttribute("kiln.console.metadata_shape", "legacy_diagnostics")
          return {
            browserOrigin: diagnostics.browserOrigin,
            mode: settings.mode,
          }
        },
        () => {
          span.setAttribute("kiln.console.metadata_shape", "registry_fallback")
          return null
        }
      )
  )
  const proxyMode = proxy?.mode ?? "none"
  const now = Date.now()
  const payload = {
    actions: input.actions,
    audience: input.relay.id,
    capabilityId: randomUUID(),
    expiresAt: now + 60_000,
    instanceId: input.instanceId,
    issuedAt: now,
    issuer: credentials.clientId,
    keyThumbprint: browserKeyThumbprint(input.publicKeyJwk),
    origin: kilnPublicUrl().origin,
    path: input.path,
    subject: input.subject,
    version: 1,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signature = sign(
    null,
    Buffer.from(encoded),
    credentials.clientPrivateKeyPem
  ).toString("base64url")
  return {
    browserOrigin: proxy?.browserOrigin ?? input.relay.browserOrigin,
    capability: `${encoded}.${signature}`,
    expiresAt: payload.expiresAt,
    proxyMode,
    relayId: input.relay.id,
  }
}

function browserKeyThumbprint(jwk: BrowserPublicKey): string {
  return createHash("sha256")
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest("base64url")
}
