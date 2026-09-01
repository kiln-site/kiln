import { createHash, randomUUID, sign } from "node:crypto"

import * as Sentry from "@sentry/tanstackstart-react"
import {
  relayProxyBrowserMetadataSchema,
  relayProxyDiagnosticsSchema,
  relayProxySettingsSchema,
} from "@workspace/contracts"
import type {
  RelayProxyBrowserMetadata,
  RelayProxyMode,
} from "@workspace/contracts"
import { Clock, Effect, Result } from "effect"

import { requireRelayPermissionsEffect } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { kilnPublicUrl } from "@/lib/environment"
import {
  decryptRelayIssuanceCredentialsEffect,
  loadEnabledRelayForIssuanceEffect,
} from "@/lib/relay-registry"
import type { PersistedRelay, RelayCredentials } from "@/lib/relay-registry"
import { CredentialError } from "@/effect/errors"
import { recoverPromise } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import type { AccessPermission } from "@/lib/permissions"

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

interface IssuedBrowserCapability {
  browserOrigin: string
  capability: string
  expiresAt: number
  proxyMode: RelayProxyMode
  relayId: string
}

interface PreparedBrowserCapability {
  capability: IssuedBrowserCapability
  relay: PersistedRelay
  relayCaCertificatePem: string | null
}

export function issueConsoleCapabilityForRequest(input: {
  authenticate: () => Promise<AuthenticatedUser>
  instanceId: string
  publicKeyJwk: BrowserPublicKey
  relayId: string
  write: boolean
}): Promise<IssuedBrowserCapability> {
  return runAppEffect(
    "console.capability.issue",
    prepareBrowserCapabilityEffect({
      actions: input.write
        ? ["instance.console.read", "instance.console.write"]
        : ["instance.console.read"],
      instanceId: input.instanceId,
      path: null,
      publicKeyJwk: input.publicKeyJwk,
      relayId: input.relayId,
      resolveBrowserMetadata: true,
      user: authenticatedUserEffect(input.authenticate),
    }).pipe(Effect.map((prepared) => prepared.capability))
  )
}

export function prepareConsoleCapabilityForUser(input: {
  instanceId: string
  publicKeyJwk: BrowserPublicKey
  relayId: string
  user: AuthenticatedUser
}): Promise<PreparedBrowserCapability> {
  return runAppEffect(
    "console.capability.prepareProxy",
    prepareBrowserCapabilityEffect({
      actions: ["instance.console.read"],
      instanceId: input.instanceId,
      path: null,
      publicKeyJwk: input.publicKeyJwk,
      relayId: input.relayId,
      resolveBrowserMetadata: false,
      user: Effect.succeed(input.user),
    })
  )
}

export function issueResourceCapabilityForRequest(input: {
  authenticate: () => Promise<AuthenticatedUser>
  instanceId: string
  publicKeyJwk: BrowserPublicKey
  relayId: string
}): Promise<IssuedBrowserCapability> {
  return runAppEffect(
    "resource.capability.issue",
    prepareBrowserCapabilityEffect({
      actions: ["instance.read"],
      instanceId: input.instanceId,
      path: null,
      publicKeyJwk: input.publicKeyJwk,
      relayId: input.relayId,
      resolveBrowserMetadata: true,
      user: authenticatedUserEffect(input.authenticate),
    }).pipe(Effect.map((prepared) => prepared.capability))
  )
}

export function issueFileCapabilityForRequest(input: {
  action: "instance.files.download" | "instance.files.upload"
  authenticate: () => Promise<AuthenticatedUser>
  instanceId: string
  path: string
  publicKeyJwk: BrowserPublicKey
  relayId: string
}): Promise<IssuedBrowserCapability> {
  return runAppEffect(
    "file.capability.issue",
    prepareBrowserCapabilityEffect({
      actions: [input.action],
      instanceId: input.instanceId,
      path: input.path,
      publicKeyJwk: input.publicKeyJwk,
      relayId: input.relayId,
      resolveBrowserMetadata: true,
      user: authenticatedUserEffect(input.authenticate),
    }).pipe(Effect.map((prepared) => prepared.capability))
  )
}

const prepareBrowserCapabilityEffect = Effect.fn("relay.capability.prepare")(
  function* (input: {
    actions: ReadonlyArray<BrowserAction>
    instanceId: string
    path: string | null
    publicKeyJwk: BrowserPublicKey
    relayId: string
    resolveBrowserMetadata: boolean
    user: Effect.Effect<AuthenticatedUser, unknown>
  }) {
    const [userResult, materialResult] = yield* Effect.all(
      [
        Effect.result(input.user),
        Effect.result(loadEnabledRelayForIssuanceEffect(input.relayId)),
      ] as const,
      { concurrency: 2 }
    )

    // Authentication always wins when both concurrent lookups fail so an
    // unauthenticated request cannot use response differences to enumerate Relays.
    if (Result.isFailure(userResult)) {
      return yield* Effect.fail(userResult.failure)
    }
    const user = userResult.success
    if (Result.isFailure(materialResult)) {
      return yield* Effect.fail(materialResult.failure)
    }
    const material = materialResult.success

    yield* requireRelayPermissionsEffect({
      instanceId: input.instanceId,
      permissions: input.actions.map(permissionForBrowserAction),
      relayId: material.relay.id,
      user,
    })

    // Keep private-key work and Relay control traffic behind fresh authorization.
    const [credentials, proxy] = yield* Effect.all(
      [
        decryptRelayIssuanceCredentialsEffect(material),
        input.resolveBrowserMetadata
          ? resolveRelayBrowserMetadataEffect(material.relay)
          : Effect.succeed(null),
      ] as const,
      { concurrency: 2 }
    )
    const capability = yield* createBrowserCapabilityEffect({
      actions: input.actions,
      credentials,
      instanceId: input.instanceId,
      path: input.path,
      proxy,
      publicKeyJwk: input.publicKeyJwk,
      relay: material.relay,
      subject: user.id,
    })
    return {
      capability,
      relay: material.relay,
      relayCaCertificatePem: credentials.caCertificatePem,
    }
  }
)

const resolveRelayBrowserMetadataEffect = Effect.fn(
  "relay.capability.resolveBrowserMetadata"
)(function* (relay: PersistedRelay) {
  return yield* Effect.promise(() =>
    Sentry.startSpan(
      {
        name: "Resolve Relay browser metadata",
        op: "rpc.relay.browser-metadata",
        attributes: { "relay.id": relay.id },
      },
      (span) =>
        recoverPromise(
          async () => {
            const { relayConnectionBrowserMetadata, relayRpc } =
              await import("@/lib/relay-connection")
            const synchronized = relayConnectionBrowserMetadata(relay.id)
            if (synchronized) {
              span.setAttribute(
                "kiln.console.metadata_shape",
                "connection_snapshot"
              )
              return synchronized
            }
            const value = await relayRpc(
              relay,
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
            span.setAttribute(
              "kiln.console.metadata_shape",
              "legacy_diagnostics"
            )
            return {
              browserOrigin: diagnostics.browserOrigin,
              mode: settings.mode,
            } satisfies RelayProxyBrowserMetadata
          },
          () => {
            span.setAttribute(
              "kiln.console.metadata_shape",
              "registry_fallback"
            )
            return null
          }
        )
    )
  )
})

const createBrowserCapabilityEffect = Effect.fn("relay.capability.sign")(
  function* (input: {
    actions: ReadonlyArray<BrowserAction>
    credentials: RelayCredentials
    instanceId: string
    path: string | null
    proxy: RelayProxyBrowserMetadata | null
    publicKeyJwk: BrowserPublicKey
    relay: PersistedRelay
    subject: string
  }) {
    const now = yield* Clock.currentTimeMillis
    return yield* Effect.try({
      try: () => {
        const payload = {
          actions: input.actions,
          audience: input.relay.id,
          capabilityId: randomUUID(),
          expiresAt: now + 60_000,
          instanceId: input.instanceId,
          issuedAt: now,
          issuer: input.credentials.clientId,
          keyThumbprint: browserKeyThumbprint(input.publicKeyJwk),
          origin: kilnPublicUrl().origin,
          path: input.path,
          subject: input.subject,
          version: 1,
        }
        const encoded = Buffer.from(JSON.stringify(payload)).toString(
          "base64url"
        )
        const signature = sign(
          null,
          Buffer.from(encoded),
          input.credentials.clientPrivateKeyPem
        ).toString("base64url")
        return {
          browserOrigin:
            input.proxy?.browserOrigin ?? input.relay.browserOrigin,
          capability: `${encoded}.${signature}`,
          expiresAt: payload.expiresAt,
          proxyMode: input.proxy?.mode ?? "none",
          relayId: input.relay.id,
        } satisfies IssuedBrowserCapability
      },
      catch: (cause) =>
        CredentialError.make({ operation: "sign_relay_capability", cause }),
    })
  }
)

function authenticatedUserEffect(
  authenticate: () => Promise<AuthenticatedUser>
): Effect.Effect<AuthenticatedUser, unknown> {
  return Effect.tryPromise({ try: authenticate, catch: (cause) => cause })
}

function permissionForBrowserAction(action: BrowserAction): AccessPermission {
  switch (action) {
    case "instance.files.download":
      return "instance.files.read"
    case "instance.files.upload":
      return "instance.files.write"
    default:
      return action
  }
}

function browserKeyThumbprint(jwk: BrowserPublicKey): string {
  return createHash("sha256")
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest("base64url")
}
