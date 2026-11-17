import { createHash, randomUUID, sign } from "node:crypto"

import {
  relayBrowserPreviewLeaseMs,
  relayConsoleReadActions,
  appIdFromFileRoot,
  databaseIdFromFileRoot,
  fileRootOwner,
  fileTransferAction,
  relayFileRootId,
  relayProxyBrowserMetadataSchema,
} from "@workspace/contracts"
import type {
  RelayBrowserOperationKind,
  RelayConsoleResource,
  RelayProxyBrowserMetadata,
  RelayProxyMode,
} from "@workspace/contracts"
import { Clock, Effect, Result } from "effect"

import {
  isPlatformAdmin,
  refreshRelayAuthorizationUserEffect,
  requireRelayPermissionsEffect,
} from "@/lib/access-control"
import type {
  AuthenticatedRealtimeIdentity,
  AuthenticatedUser,
} from "@/lib/auth-session"
import { kilnPublicUrl } from "@/lib/environment"
import { readAuthorizationRevisionEffect } from "@/lib/authorization-revision"
import { relayBrowserAuthorizationReady } from "@/lib/relay-connection"
import {
  decryptRelayIssuanceCredentialsEffect,
  loadEnabledRelayForIssuanceEffect,
} from "@/lib/relay-registry"
import type { PersistedRelay, RelayCredentials } from "@/lib/relay-registry"
import { CredentialError } from "@/effect/errors"
import { recoverPromise } from "@/effect/promise"
import { runAppEffect, traceAppPromise } from "@/effect/runtime"
import type { AccessPermission } from "@/lib/permissions"
import { requireGatewayPermission } from "@/server/tunnel-access.server"

type BrowserPublicKey = {
  crv: "P-256"
  kty: "EC"
  x: string
  y: string
}

type BrowserAction =
  | "app.read"
  | "database.dump.export"
  | "database.dump.import"
  | "database.read"
  | "instance.console.read"
  | "instance.console.write"
  | "instance.files.download"
  | "instance.files.upload"
  | "instance.logs.read"
  | "instance.read"
  | "relay.logs.read"
  | "relay.files.download"
  | "relay.files.upload"

interface IssuedBrowserCapability {
  browserOrigin: string
  capability: string
  expiresAt: number
  proxyMode: RelayProxyMode
  relayId: string
}

export function issueBrowserCapabilitiesForRequest(input: {
  authenticate: () => Promise<AuthenticatedRealtimeIdentity>
  publicKeyJwk: BrowserPublicKey
  relayId: string
  requests: ReadonlyArray<
    { kind: "console"; write: boolean } | { kind: "resources" }
  >
  resource: RelayConsoleResource
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
      const actionsByRequest = new Map(
        input.requests.map((request) => [
          request.kind,
          browserActions(input.resource, request),
        ])
      )
      const authorizationInput = {
        authorizationSession: {
          id: identity.sessionId,
          kind: "better_auth" as const,
        },
        permissions: [
          ...new Set(
            [...actionsByRequest.values()]
              .flat()
              .map(permissionForBrowserAction)
          ),
        ],
        relayId: material.relay.id,
        resource: input.resource,
        identity,
      }
      yield* authorizeBrowserCapabilityEffect(authorizationInput)
      const [credentials, proxy, issuerGeneration] = yield* Effect.all(
        [
          decryptRelayIssuanceCredentialsEffect(material),
          resolveRelayBrowserMetadataEffect(material.relay),
          relayBrowserAuthorizationReadyEffect(
            material.relay.id,
            material.relay.issuerGeneration
          ),
        ] as const,
        { concurrency: 3 }
      )
      const synchronizedRelay = {
        ...material.relay,
        issuerGeneration,
      }
      // Metadata/control RPCs and private-key loading can take measurable time.
      // Re-authorize after that work so the revision embedded below is the last
      // externally observed state before the synchronous signing step.
      const authorization =
        yield* authorizeBrowserCapabilityEffect(authorizationInput)
      const capabilities = yield* Effect.all(
        input.requests.map((request) =>
          createBrowserCapabilityEffect({
            actions: actionsByRequest.get(request.kind) ?? [],
            authorizationRevision: authorization.revision,
            credentials,
            loginSessionId: identity.sessionId,
            operation: request.kind,
            path: null,
            proxy,
            publicKeyJwk: input.publicKeyJwk,
            relay: synchronizedRelay,
            resource: input.resource,
            subject: identity.user.id,
          }).pipe(
            Effect.map((capability) => ({ ...capability, kind: request.kind }))
          )
        ),
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
      path: null,
      publicKeyJwk: input.publicKeyJwk,
      relayId: input.relayId,
      resolveBrowserMetadata: false,
      resource: { id: input.instanceId, kind: "instance" },
      identity: Effect.succeed({
        sessionId: `cli:${input.credentialId}`,
        user: input.user,
      }),
    })
  )
}

export function prepareConsoleCapabilityForIdentity(input: {
  identity: AuthenticatedRealtimeIdentity
  publicKeyJwk: BrowserPublicKey
  relayId: string
  resource: RelayConsoleResource
}): Promise<PreparedBrowserCapability> {
  return runAppEffect(
    "console.capability.prepareProxyV2",
    prepareBrowserCapabilityEffect({
      actions: [relayConsoleReadActions[input.resource.kind]],
      identity: Effect.succeed(input.identity),
      path: null,
      publicKeyJwk: input.publicKeyJwk,
      relayId: input.relayId,
      resolveBrowserMetadata: false,
      resource: input.resource,
    })
  )
}

export function issueFileCapabilityForRequest(input: {
  action: "instance.files.download" | "instance.files.upload"
  authenticate: () => Promise<AuthenticatedRealtimeIdentity>
  instanceId: string
  path: string
  publicKeyJwk: BrowserPublicKey
  relayId: string
}): Promise<IssuedBrowserCapability> {
  return runAppEffect(
    "file.capability.issue",
    prepareBrowserCapabilityEffect({
      actions: [
        fileTransferAction(
          input.instanceId,
          input.action === "instance.files.upload" ? "upload" : "download"
        ),
      ],
      path: input.path,
      publicKeyJwk: input.publicKeyJwk,
      relayId: input.relayId,
      resolveBrowserMetadata: true,
      resource: fileRootResource(input.instanceId),
      identity: authenticatedIdentityEffect(input.authenticate),
    }).pipe(Effect.map((prepared) => prepared.capability))
  )
}

/**
 * A link the browser's own media player can follow to read one file, as
 * for a video it seeks through. It is a download capability that needs no
 * request proof, so it is only ever for reading, and it lasts as long as a
 * file is likely to stay open.
 */
export function issueFilePreviewCapabilityForRequest(input: {
  authenticate: () => Promise<AuthenticatedRealtimeIdentity>
  instanceId: string
  path: string
  publicKeyJwk: BrowserPublicKey
  relayId: string
}): Promise<IssuedBrowserCapability> {
  return runAppEffect(
    "file.preview.capability.issue",
    prepareBrowserCapabilityEffect({
      actions: [fileTransferAction(input.instanceId, "download")],
      operation: "preview",
      path: input.path,
      publicKeyJwk: input.publicKeyJwk,
      relayId: input.relayId,
      resolveBrowserMetadata: true,
      resource: fileRootResource(input.instanceId),
      identity: authenticatedIdentityEffect(input.authenticate),
    }).pipe(Effect.map((prepared) => prepared.capability))
  )
}

// A file root as the resource a capability names: the root's ID, under the
// kind of thing its files belong to.
function fileRootResource(rootId: string): RelayConsoleResource {
  return { id: rootId, kind: fileRootOwner(rootId).kind }
}

const prepareBrowserCapabilityEffect = Effect.fn("relay.capability.prepare")(
  function* (input: {
    actions: ReadonlyArray<BrowserAction>
    authorizationSession?:
      | { id: string; kind: "better_auth" }
      | { id: string; kind: "cli_credential" }
    path: string | null
    publicKeyJwk: BrowserPublicKey
    relayId: string
    resolveBrowserMetadata: boolean
    resource: RelayConsoleResource
    identity: Effect.Effect<AuthenticatedRealtimeIdentity, unknown>
    /** Set for a preview link; other operations follow from the actions. */
    operation?: "preview"
  }) {
    const [userResult, materialResult] = yield* Effect.all(
      [
        Effect.result(input.identity),
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

    const operation: RelayBrowserOperationKind =
      input.operation ??
      (input.actions.some(
        (action) =>
          action.startsWith("instance.files.") ||
          action.startsWith("app.files.") ||
          action.startsWith("relay.files.") ||
          action.startsWith("database.dump.")
      )
        ? "file"
        : input.actions.some((action) => resourceUsageActions.has(action))
          ? "resources"
          : "console")
    if (identity.sessionId.length === 0) {
      return yield* Effect.fail(
        new Error(`${operation} capability requires a login session`)
      )
    }
    const authorizationInput = {
      authorizationSession:
        input.authorizationSession ??
        (identity.sessionId
          ? { id: identity.sessionId, kind: "better_auth" as const }
          : null),
      identity,
      permissions: input.actions.map(permissionForBrowserAction),
      relayId: material.relay.id,
      resource: input.resource,
    }
    yield* authorizeBrowserCapabilityEffect(authorizationInput)

    // Keep private-key work and Relay control traffic behind stable, freshly
    // checked authorization.
    const [credentials, proxy, issuerGeneration] = yield* Effect.all(
      [
        decryptRelayIssuanceCredentialsEffect(material),
        input.resolveBrowserMetadata
          ? resolveRelayBrowserMetadataEffect(material.relay)
          : Effect.succeed(null),
        relayBrowserAuthorizationReadyEffect(
          material.relay.id,
          material.relay.issuerGeneration
        ),
      ] as const,
      { concurrency: 3 }
    )
    const synchronizedRelay = { ...material.relay, issuerGeneration }
    // Re-check after all slow/external preparation. Capability construction is
    // synchronous from this point, keeping the authorization-to-sign window as
    // small as the runtime permits.
    const authorization =
      yield* authorizeBrowserCapabilityEffect(authorizationInput)
    const capability = yield* createBrowserCapabilityEffect({
      actions: input.actions,
      authorizationRevision: authorization.revision,
      credentials,
      loginSessionId: identity.sessionId,
      operation,
      path: input.path,
      proxy,
      publicKeyJwk: input.publicKeyJwk,
      relay: synchronizedRelay,
      resource: input.resource,
      subject: user.id,
    })
    return {
      capability,
      relay: synchronizedRelay,
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
  permissions: ReadonlyArray<AccessPermission>
  relayId: string
  resource: RelayConsoleResource
}) {
  // A Relay's own output and host files (`relay:<relayId>`), and Kiln's
  // services on its host, are only ever the Relay the capability is for.
  if (
    (input.resource.kind === "platform" &&
      input.resource.id !== input.relayId) ||
    (input.resource.kind === "relay" &&
      input.resource.id !== input.relayId &&
      input.resource.id !== relayFileRootId(input.relayId))
  ) {
    return yield* Effect.fail(new Error("Relay not found"))
  }
  for (
    let attempt = 0;
    attempt < MAX_AUTHORIZATION_STABILITY_ATTEMPTS;
    attempt += 1
  ) {
    const snapshot = yield* refreshRelayAuthorizationUserEffect({
      loginSession: input.authorizationSession,
      user: input.identity.user,
    })
    // Kiln's own services are for platform administrators, as their page is.
    if (input.resource.kind === "platform" && !isPlatformAdmin(snapshot.user)) {
      return yield* Effect.fail(
        new Error("Only platform administrators can read Kiln's logs")
      )
    }
    // A gateway is its owner's, or anyone's who may on its Relay.
    if (input.resource.kind === "tunnel") {
      const gatewayId = input.resource.id
      for (const permission of input.permissions) {
        const gateway = yield* Effect.tryPromise(() =>
          requireGatewayPermission(snapshot.user, gatewayId, permission)
        )
        if (gateway.relayId !== input.relayId) {
          return yield* Effect.fail(new Error("Tunnel not found"))
        }
      }
    } else {
      yield* requireRelayPermissionsEffect({
        ...resourceScope(input.resource),
        permissions: input.permissions,
        relayId: input.relayId,
        user: snapshot.user,
      })
    }
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
    traceAppPromise("relay.capability.browserMetadata.read", (span) =>
      recoverPromise(
        async () => {
          const { relayConnectionBrowserMetadata, relayRpc } =
            await import("@/lib/relay-connection")
          const synchronized = relayConnectionBrowserMetadata(relay.id)
          if (synchronized) {
            span.attribute("kiln.console.metadata_shape", "connection_snapshot")
            return synchronized
          }
          const value = await relayRpc(
            relay,
            "relay.proxy.read",
            { includeDiagnostics: false },
            5_000
          )
          const metadata = relayProxyBrowserMetadataSchema.safeParse(value)
          if (!metadata.success) {
            span.attribute("kiln.console.metadata_shape", "registry_fallback")
            return null
          }
          span.attribute("kiln.console.metadata_shape", "lightweight")
          return metadata.data
        },
        () => {
          span.attribute("kiln.console.metadata_shape", "registry_fallback")
          return null
        }
      )
    )
  )
})

const createBrowserCapabilityEffect = Effect.fn("relay.capability.sign")(
  function* (input: {
    actions: ReadonlyArray<BrowserAction>
    authorizationRevision: number
    credentials: RelayCredentials
    loginSessionId: string
    operation: RelayBrowserOperationKind
    path: string | null
    proxy: RelayProxyBrowserMetadata | null
    publicKeyJwk: BrowserPublicKey
    relay: PersistedRelay
    resource: RelayConsoleResource
    subject: string
  }) {
    const now = yield* Clock.currentTimeMillis
    return yield* Effect.try({
      try: () => {
        const mutation = input.actions.some(
          (action) =>
            action === "instance.console.write" ||
            action === "instance.files.upload" ||
            action === "relay.files.upload" ||
            action === "database.dump.import"
        )
        const payload = {
          actions: input.actions,
          audience: input.relay.id,
          capabilityId: randomUUID(),
          expiresAt:
            now +
            (input.operation === "preview"
              ? relayBrowserPreviewLeaseMs
              : mutation
                ? 30_000
                : 60_000),
          instanceId: input.resource.id,
          issuedAt: now,
          issuer: input.credentials.clientId,
          keyThumbprint: browserKeyThumbprint(input.publicKeyJwk),
          origin: kilnPublicUrl().origin,
          path: input.path,
          subject: input.subject,
          authorizationRevision: input.authorizationRevision,
          issuerGeneration: input.relay.issuerGeneration,
          loginSessionId: input.loginSessionId,
          operation: input.operation,
          // Game servers leave it out.
          ...(input.resource.kind === "instance"
            ? {}
            : { resourceKind: input.resource.kind }),
          version: 2,
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
    }).pipe(
      Effect.withSpan("hearth.browser.capability.sign", {
        attributes: { "capability.operation": input.operation },
      })
    )
  }
)

// The action that reads each kind's live usage.
const resourceUsageReadActions = {
  app: "app.read",
  database: "database.read",
  instance: "instance.read",
} as const
const resourceUsageActions: ReadonlySet<string> = new Set(
  Object.values(resourceUsageReadActions)
)

// What a browser asks for: console output, with input for servers, or a
// game server's, App's, or database's usage.
function browserActions(
  resource: RelayConsoleResource,
  request: { kind: "console"; write: boolean } | { kind: "resources" }
): ReadonlyArray<BrowserAction> {
  if (
    request.kind === "resources" &&
    (resource.kind === "app" || resource.kind === "database")
  ) {
    return [resourceUsageReadActions[resource.kind]]
  }
  if (resource.kind !== "instance") {
    if (request.kind !== "console" || request.write) {
      throw new Error(`A ${resource.kind} only has console output to read`)
    }
    return [relayConsoleReadActions[resource.kind]]
  }
  if (request.kind === "resources") return ["instance.read"]
  return request.write
    ? ["instance.console.read", "instance.console.write"]
    : ["instance.console.read"]
}

// The grant scope a resource's permissions are checked in.
function resourceScope(resource: RelayConsoleResource) {
  switch (resource.kind) {
    case "instance":
      return { instanceId: resource.id }
    // A database's dumps are addressed by its dump folder
    // (`database:<databaseId>`).
    case "database":
      return { databaseId: databaseIdFromFileRoot(resource.id) ?? resource.id }
    // An app's files are addressed by its data directory (`app:<appId>`).
    case "app":
      return { appId: appIdFromFileRoot(resource.id) ?? resource.id }
    case "relay":
    case "platform":
    case "tunnel":
      return {}
    default:
      return resource.kind satisfies never
  }
}

function relayBrowserAuthorizationReadyEffect(
  relayId: string,
  minimumIssuerGeneration: number
) {
  return Effect.tryPromise({
    try: () => relayBrowserAuthorizationReady(relayId, minimumIssuerGeneration),
    catch: (cause) => cause,
  }).pipe(Effect.withSpan("hearth.browser.authorization.ready"))
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
    case "relay.files.download":
      return "relay.files.read"
    case "relay.files.upload":
      return "relay.files.write"
    default:
      return action
  }
}

function browserKeyThumbprint(jwk: BrowserPublicKey): string {
  return createHash("sha256")
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest("base64url")
}
