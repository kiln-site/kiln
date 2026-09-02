import { createHash, randomUUID, sign } from "node:crypto"

import * as Sentry from "@sentry/tanstackstart-react"
import {
  relayBrowserCapabilityV2Feature,
  relayBrowserLeaseRenewalV1Feature,
  relayFileRequestReplayV1Feature,
  relayProxyBrowserMetadataSchema,
  relayProxyDiagnosticsSchema,
  relayProxySettingsSchema,
} from "@workspace/contracts"
import type {
  RelayBrowserOperationKind,
  RelayProxyBrowserMetadata,
  RelayProxyMode,
} from "@workspace/contracts"
import { Clock, Effect, Result } from "effect"

import {
  refreshRelayAuthorizationUserEffect,
  requireRelayPermissionsEffect,
} from "@/lib/access-control"
import type {
  AuthenticatedRealtimeIdentity,
  AuthenticatedUser,
} from "@/lib/auth-session"
import {
  browserCapabilityMinimumVersion,
  kilnPublicUrl,
} from "@/lib/environment"
import { readAuthorizationRevisionEffect } from "@/lib/authorization-revision"
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
  version: 1 | 2
}

export function issueBrowserCapabilitiesForRequest(input: {
  authenticate: () => Promise<AuthenticatedRealtimeIdentity>
  instanceId: string
  publicKeyJwk: BrowserPublicKey
  relayId: string
  requests: ReadonlyArray<
    | { kind: "console"; optInV2: boolean; write: boolean }
    | { kind: "resources"; optInV2: boolean }
  >
}): Promise<{
  capabilities: Array<
    IssuedBrowserCapability & { kind: "console" | "resources" }
  >
}> {
  return runAppEffect(
    "browser.capability.issueBatch",
    Effect.gen(function* () {
      const [identityResult, materialResult] = yield* Effect.all(
        [
          Effect.result(
            Effect.tryPromise({
              try: input.authenticate,
              catch: (cause) => cause,
            })
          ),
          Effect.result(loadEnabledRelayForIssuanceEffect(input.relayId)),
        ] as const,
        { concurrency: 2 }
      )
      if (Result.isFailure(identityResult)) {
        return yield* Effect.fail(identityResult.failure)
      }
      if (Result.isFailure(materialResult)) {
        return yield* Effect.fail(materialResult.failure)
      }
      const identity = identityResult.success
      const material = materialResult.success
      const permissions = input.requests.flatMap((request) =>
        request.kind === "console" && request.write
          ? (["instance.console.read", "instance.console.write"] as const)
          : request.kind === "console"
            ? (["instance.console.read"] as const)
            : (["instance.read"] as const)
      )
      const authorizationInput = {
        authorizationSession: {
          id: identity.sessionId,
          kind: "better_auth" as const,
        },
        instanceId: input.instanceId,
        permissions: [...new Set(permissions)],
        relayId: material.relay.id,
        identity,
      }
      yield* authorizeBrowserCapabilityEffect(authorizationInput)
      const [credentials, proxy] = yield* Effect.all(
        [
          decryptRelayIssuanceCredentialsEffect(material),
          resolveRelayBrowserMetadataEffect(material.relay),
        ] as const,
        { concurrency: 2 }
      )
      const features = yield* Effect.promise(async () => {
        const { relayConnectionFeatures } =
          await import("@/lib/relay-connection")
        return relayConnectionFeatures(material.relay.id)
      })
      // Metadata/control RPCs and private-key loading can take measurable time.
      // Re-authorize after that work so the revision embedded below is the last
      // externally observed state before the synchronous signing step.
      const authorization =
        yield* authorizeBrowserCapabilityEffect(authorizationInput)
      const capabilities = yield* Effect.all(
        input.requests.map((request) => {
          const version = negotiatedVersion(
            request.kind,
            request.optInV2,
            features
          )
          const actions: ReadonlyArray<BrowserAction> =
            request.kind === "resources"
              ? ["instance.read"]
              : request.write
                ? ["instance.console.read", "instance.console.write"]
                : ["instance.console.read"]
          return createBrowserCapabilityEffect({
            actions,
            authorizationRevision: version === 2 ? authorization.revision : 0,
            credentials,
            instanceId: input.instanceId,
            loginSessionId: identity.sessionId,
            operation: request.kind,
            path: null,
            proxy,
            publicKeyJwk: input.publicKeyJwk,
            relay: material.relay,
            subject: identity.user.id,
            version,
          }).pipe(
            Effect.map((capability) => ({ ...capability, kind: request.kind }))
          )
        }),
        { concurrency: "unbounded" }
      )
      return { capabilities }
    }).pipe(
      Effect.withSpan("hearth.browser.capability.batch", {
        attributes: { "capability.count": input.requests.length },
      })
    )
  )
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
  credentialId: string
  instanceId: string
  publicKeyJwk: BrowserPublicKey
  relayId: string
  user: AuthenticatedUser
}): Promise<PreparedBrowserCapability> {
  return runAppEffect(
    "console.capability.prepareProxy",
    prepareBrowserCapabilityEffect({
      actions: ["instance.console.read"],
      authorizationSession: {
        id: input.credentialId,
        kind: "cli_credential",
      },
      instanceId: input.instanceId,
      optInV2: true,
      path: null,
      publicKeyJwk: input.publicKeyJwk,
      relayId: input.relayId,
      resolveBrowserMetadata: false,
      identity: Effect.succeed({
        sessionId: `cli:${input.credentialId}`,
        user: input.user,
      }),
    })
  )
}

export function prepareConsoleCapabilityForIdentity(input: {
  identity: AuthenticatedRealtimeIdentity
  instanceId: string
  publicKeyJwk: BrowserPublicKey
  relayId: string
}): Promise<PreparedBrowserCapability> {
  return runAppEffect(
    "console.capability.prepareProxyV2",
    prepareBrowserCapabilityEffect({
      actions: ["instance.console.read"],
      identity: Effect.succeed(input.identity),
      instanceId: input.instanceId,
      // Prefer renewable v2 whenever Relay supports it. The configured floor
      // still controls whether a rolling-upgrade fallback to v1 is allowed.
      optInV2: true,
      path: null,
      publicKeyJwk: input.publicKeyJwk,
      relayId: input.relayId,
      resolveBrowserMetadata: false,
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
  authenticate: () => Promise<AuthenticatedRealtimeIdentity>
  instanceId: string
  path: string
  publicKeyJwk: BrowserPublicKey
  relayId: string
  optInV2: boolean
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
      identity: authenticatedIdentityEffect(input.authenticate),
      optInV2: input.optInV2,
    }).pipe(Effect.map((prepared) => prepared.capability))
  )
}

const prepareBrowserCapabilityEffect = Effect.fn("relay.capability.prepare")(
  function* (input: {
    actions: ReadonlyArray<BrowserAction>
    authorizationSession?:
      | { id: string; kind: "better_auth" }
      | { id: string; kind: "cli_credential" }
    instanceId: string
    path: string | null
    publicKeyJwk: BrowserPublicKey
    relayId: string
    resolveBrowserMetadata: boolean
    identity?: Effect.Effect<AuthenticatedRealtimeIdentity, unknown>
    optInV2?: boolean
    user?: Effect.Effect<AuthenticatedUser, unknown>
  }) {
    const identityEffect = input.identity
      ? input.identity
      : (input.user ?? Effect.fail(new Error("Authentication required"))).pipe(
          Effect.map((user) => ({ sessionId: "", user }))
        )
    const [userResult, materialResult] = yield* Effect.all(
      [
        Effect.result(identityEffect),
        Effect.result(loadEnabledRelayForIssuanceEffect(input.relayId)),
      ] as const,
      { concurrency: 2 }
    )

    // Authentication always wins when both concurrent lookups fail so an
    // unauthenticated request cannot use response differences to enumerate Relays.
    if (Result.isFailure(userResult)) {
      return yield* Effect.fail(userResult.failure)
    }
    const identity = userResult.success
    const user = identity.user
    if (Result.isFailure(materialResult)) {
      return yield* Effect.fail(materialResult.failure)
    }
    const material = materialResult.success

    const operation: RelayBrowserOperationKind = input.actions.some((action) =>
      action.startsWith("instance.files.")
    )
      ? "file"
      : input.actions.includes("instance.read")
        ? "resources"
        : "console"
    const features = yield* Effect.promise(async () => {
      const { relayConnectionFeatures } = await import("@/lib/relay-connection")
      return relayConnectionFeatures(material.relay.id)
    })
    const version = negotiatedVersion(
      operation,
      input.optInV2 ?? false,
      features
    )
    if (version === 2 && identity.sessionId.length === 0) {
      return yield* Effect.fail(
        new Error(`${operation} capability v2 requires a login session`)
      )
    }
    const authorizationInput = {
      authorizationSession:
        input.authorizationSession ??
        (identity.sessionId
          ? { id: identity.sessionId, kind: "better_auth" as const }
          : null),
      identity,
      instanceId: input.instanceId,
      permissions: input.actions.map(permissionForBrowserAction),
      relayId: material.relay.id,
    }
    yield* authorizeBrowserCapabilityEffect(authorizationInput)

    // Keep private-key work and Relay control traffic behind stable, freshly
    // checked authorization.
    const [credentials, proxy] = yield* Effect.all(
      [
        decryptRelayIssuanceCredentialsEffect(material),
        input.resolveBrowserMetadata
          ? resolveRelayBrowserMetadataEffect(material.relay)
          : Effect.succeed(null),
      ] as const,
      { concurrency: 2 }
    )
    // Re-check after all slow/external preparation. Capability construction is
    // synchronous from this point, keeping the authorization-to-sign window as
    // small as the runtime permits.
    const authorization =
      yield* authorizeBrowserCapabilityEffect(authorizationInput)
    const capability = yield* createBrowserCapabilityEffect({
      actions: input.actions,
      authorizationRevision: version === 2 ? authorization.revision : 0,
      credentials,
      instanceId: input.instanceId,
      loginSessionId: identity.sessionId,
      operation,
      path: input.path,
      proxy,
      publicKeyJwk: input.publicKeyJwk,
      relay: material.relay,
      subject: user.id,
      version,
    })
    return {
      capability,
      relay: material.relay,
      relayCaCertificatePem: credentials.caCertificatePem,
    }
  }
)

const MAX_AUTHORIZATION_STABILITY_ATTEMPTS = 3

const authorizeBrowserCapabilityEffect = Effect.fn(
  "relay.capability.authorizeStable"
)(function* (input: {
  authorizationSession:
    | { id: string; kind: "better_auth" }
    | { id: string; kind: "cli_credential" }
    | null
  identity: AuthenticatedRealtimeIdentity
  instanceId: string
  permissions: ReadonlyArray<AccessPermission>
  relayId: string
}) {
  for (
    let attempt = 0;
    attempt < MAX_AUTHORIZATION_STABILITY_ATTEMPTS;
    attempt += 1
  ) {
    const snapshot = yield* refreshRelayAuthorizationUserEffect({
      loginSession: input.authorizationSession,
      user: input.identity.user,
    })
    yield* requireRelayPermissionsEffect({
      instanceId: input.instanceId,
      permissions: input.permissions,
      relayId: input.relayId,
      user: snapshot.user,
    })
    const after = yield* readAuthorizationRevisionEffect(input.identity.user.id)
    if (snapshot.revision === after) {
      return { revision: after, user: snapshot.user }
    }
  }
  return yield* Effect.fail(
    new Error("Authorization changed while issuing the browser capability")
  )
})

const resolveRelayBrowserMetadataEffect = Effect.fn(
  "relay.capability.resolveBrowserMetadata"
)(function* (relay: PersistedRelay) {
  return yield* Effect.promise(() =>
    Sentry.startSpan(
      {
        name: "Resolve Relay browser metadata",
        op: "rpc.relay.browser-metadata",
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
    authorizationRevision?: number
    credentials: RelayCredentials
    instanceId: string
    loginSessionId?: string
    operation?: RelayBrowserOperationKind
    path: string | null
    proxy: RelayProxyBrowserMetadata | null
    publicKeyJwk: BrowserPublicKey
    relay: PersistedRelay
    subject: string
    version?: 1 | 2
  }) {
    const now = yield* Clock.currentTimeMillis
    return yield* Effect.try({
      try: () => {
        const version = input.version ?? 1
        const mutation = input.actions.some(
          (action) =>
            action === "instance.console.write" ||
            action === "instance.files.upload"
        )
        const payload = {
          actions: input.actions,
          audience: input.relay.id,
          capabilityId: randomUUID(),
          expiresAt: now + (version === 2 && mutation ? 30_000 : 60_000),
          instanceId: input.instanceId,
          issuedAt: now,
          issuer: input.credentials.clientId,
          keyThumbprint: browserKeyThumbprint(input.publicKeyJwk),
          origin: kilnPublicUrl().origin,
          path: input.path,
          subject: input.subject,
          ...(version === 2
            ? {
                authorizationRevision: input.authorizationRevision ?? 0,
                issuerGeneration: input.relay.issuerGeneration,
                loginSessionId: requiredV2Field(
                  input.loginSessionId,
                  "login session"
                ),
                operation: requiredV2Field(input.operation, "operation"),
              }
            : {}),
          version,
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
          version,
        } satisfies IssuedBrowserCapability
      },
      catch: (cause) =>
        CredentialError.make({ operation: "sign_relay_capability", cause }),
    }).pipe(
      Effect.withSpan("hearth.browser.capability.sign", {
        attributes: {
          "capability.operation": input.operation ?? "legacy",
          "capability.version": input.version ?? 1,
        },
      })
    )
  }
)

function negotiatedVersion(
  kind: RelayBrowserOperationKind,
  optInV2: boolean,
  features: ReadonlySet<string>
): 1 | 2 {
  const minimum = browserCapabilityMinimumVersion(kind)
  if (minimum === 2 && !optInV2) {
    throw new Error(`${kind} requires browser capability v2`)
  }
  const supported =
    features.has(relayBrowserCapabilityV2Feature) &&
    (kind === "file"
      ? features.has(relayFileRequestReplayV1Feature)
      : features.has(relayBrowserLeaseRenewalV1Feature))
  if (optInV2 && supported) return 2
  if (minimum === 2) {
    throw new Error(
      `Relay does not support the required ${kind} capability v2 features`
    )
  }
  return 1
}

function requiredV2Field<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`Capability v2 ${name} is required`)
  }
  return value
}

function authenticatedUserEffect(
  authenticate: () => Promise<AuthenticatedUser>
): Effect.Effect<AuthenticatedUser, unknown> {
  return Effect.tryPromise({ try: authenticate, catch: (cause) => cause })
}

function authenticatedIdentityEffect(
  authenticate: () => Promise<AuthenticatedRealtimeIdentity>
): Effect.Effect<AuthenticatedRealtimeIdentity, unknown> {
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
