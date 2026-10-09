import { generateKeyPairSync } from "node:crypto"

import { beforeEach, describe, expect, it, vi } from "vite-plus/test"
import { Effect } from "effect"

const fakes = vi.hoisted(() => ({
  decryptCredentials: vi.fn(),
  relayBrowserMetadata: vi.fn(),
  relayBrowserAuthorizationReady: vi.fn(),
  loadRelay: vi.fn(),
  relayRpc: vi.fn(),
  refreshUser: vi.fn(),
  requirePermissions: vi.fn(),
  revisions: vi.fn(),
  features: new Set<string>(),
  span: { setAttribute: vi.fn() },
}))

vi.mock("@sentry/tanstackstart-react", () => ({
  startSpan: (_options: unknown, run: (span: typeof fakes.span) => unknown) =>
    run(fakes.span),
}))

vi.mock("@/lib/access-control", () => ({
  refreshRelayAuthorizationUserEffect: fakes.refreshUser,
  requireRelayPermissionsEffect: fakes.requirePermissions,
}))

vi.mock("@/lib/environment", () => ({
  browserCapabilityMinimumVersion: () => 1,
  kilnPublicUrl: () => new URL("https://hearth.example.com"),
}))

vi.mock("@/lib/relay-connection", () => ({
  relayBrowserAuthorizationReady: fakes.relayBrowserAuthorizationReady,
  relayConnectionBrowserMetadata: fakes.relayBrowserMetadata,
  relayConnectionFeatures: () => fakes.features,
  relayRpc: fakes.relayRpc,
}))

vi.mock("@/lib/authorization-revision", () => ({
  readAuthorizationRevisionEffect: fakes.revisions,
}))

vi.mock("@/lib/relay-registry", () => ({
  decryptRelayIssuanceCredentialsEffect: fakes.decryptCredentials,
  loadEnabledRelayForIssuanceEffect: fakes.loadRelay,
}))

import type { AuthenticatedUser } from "@/lib/auth-session"
import type {
  PersistedRelay,
  RelayCredentials,
  RelayIssuanceMaterial,
} from "@/lib/relay-registry"
import {
  issueBrowserCapabilitiesForRequest,
  issueConsoleCapabilityForRequest,
  issueFileCapabilityForRequest,
  prepareConsoleCapabilityForUser,
} from "@/server/relay-capability-service"

const user = {
  email: "user@example.com",
  emailVerified: true,
  id: "user-one",
  isDevelopmentBypass: false,
  name: "User",
  role: "user",
  twoFactorEnabled: false,
} satisfies AuthenticatedUser

const relay = {
  actions: ["relay.proxy.read"],
  browserOrigin: "https://relay.example.com",
  clientId: "client-one",
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: "user-one",
  enabled: true,
  hostname: "relay.example.com",
  id: "relay-one",
  issuerGeneration: 1,
  lastConnectedAt: null,
  lastError: null,
  managedEmberCount: 1,
  managedTls: true,
  name: "Relay One",
  nodeArch: "arm64",
  nodePlatform: "linux",
  nodeVersion: "24.0.0",
  paired: true,
  port: 4100,
  role: "full_access",
  useTls: true,
} satisfies PersistedRelay

const signerKeys = generateKeyPairSync("ed25519")
const credentials = {
  caCertificatePem: "relay-ca",
  clientId: "client-one",
  clientPrivateKeyPem: signerKeys.privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString(),
  clientPublicKeyPem: signerKeys.publicKey
    .export({ format: "pem", type: "spki" })
    .toString(),
  relayPublicKeyPem: signerKeys.publicKey
    .export({ format: "pem", type: "spki" })
    .toString(),
} satisfies RelayCredentials

const material = {
  encryptedCredentials: {
    caCertificatePem: "relay-ca",
    clientId: "client-one",
    clientPrivateKeyCiphertext: "encrypted-private-key",
    clientPublicKeyPem: credentials.clientPublicKeyPem,
    relayId: "relay-one",
    relayPublicKeyPem: credentials.relayPublicKeyPem,
  },
  relay,
} satisfies RelayIssuanceMaterial

const publicKeyJwk = {
  crv: "P-256" as const,
  kty: "EC" as const,
  x: "a".repeat(43),
  y: "b".repeat(43),
}

beforeEach(() => {
  vi.clearAllMocks()
  fakes.loadRelay.mockReturnValue(Effect.succeed(material))
  fakes.requirePermissions.mockReturnValue(Effect.void)
  fakes.refreshUser.mockImplementation(({ user: current }) =>
    Effect.succeed({ revision: 7, user: current })
  )
  fakes.revisions.mockReturnValue(Effect.succeed(7))
  fakes.decryptCredentials.mockReturnValue(Effect.succeed(credentials))
  fakes.relayBrowserMetadata.mockReturnValue(null)
  fakes.relayBrowserAuthorizationReady.mockResolvedValue(1)
  fakes.relayRpc.mockResolvedValue({
    browserOrigin: "https://relay-live.example.com",
    mode: "none",
  })
  fakes.features.clear()
})

describe("Relay capability issuance orchestration", () => {
  it("returns authentication failure before Relay lookup failure", async () => {
    const authenticationError = new Error("Authentication required")
    fakes.loadRelay.mockReturnValue(
      Effect.fail(new Error("Relay is not available"))
    )

    await expect(
      issueConsoleCapabilityForRequest({
        authenticate: () => Promise.reject(authenticationError),
        instanceId: "instance-one",
        publicKeyJwk,
        relayId: "missing-relay",
        write: false,
      })
    ).rejects.toBe(authenticationError)

    expect(fakes.requirePermissions).not.toHaveBeenCalled()
    expect(fakes.decryptCredentials).not.toHaveBeenCalled()
    expect(fakes.relayRpc).not.toHaveBeenCalled()
  })

  it("does not decrypt credentials or contact the Relay before authorization", async () => {
    const authorizationError = new Error("Console access denied")
    fakes.requirePermissions.mockReturnValue(Effect.fail(authorizationError))

    await expect(
      issueConsoleCapabilityForRequest({
        authenticate: () => Promise.resolve(user),
        instanceId: "instance-one",
        publicKeyJwk,
        relayId: "relay-one",
        write: true,
      })
    ).rejects.toBe(authorizationError)

    expect(fakes.decryptCredentials).not.toHaveBeenCalled()
    expect(fakes.relayRpc).not.toHaveBeenCalled()
  })

  it("authorizes before preparation and again immediately before signing", async () => {
    let authorized = false
    fakes.requirePermissions.mockImplementation(() =>
      Effect.sync(() => {
        authorized = true
      })
    )
    fakes.decryptCredentials.mockImplementation(() =>
      Effect.sync(() => {
        expect(authorized).toBe(true)
        return credentials
      })
    )
    fakes.relayRpc.mockImplementation(async () => {
      expect(authorized).toBe(true)
      return {
        browserOrigin: "https://relay-live.example.com",
        mode: "none",
      }
    })

    const issued = await issueConsoleCapabilityForRequest({
      authenticate: () => Promise.resolve(user),
      instanceId: "instance-one",
      publicKeyJwk,
      relayId: "relay-one",
      write: true,
    })

    expect(fakes.requirePermissions).toHaveBeenCalledWith({
      instanceId: "instance-one",
      permissions: ["instance.console.read", "instance.console.write"],
      relayId: "relay-one",
      user,
    })
    expect(issued.browserOrigin).toBe("https://relay-live.example.com")
    expect(decodeCapabilityPayload(issued.capability)).toMatchObject({
      actions: ["instance.console.read", "instance.console.write"],
      audience: "relay-one",
      instanceId: "instance-one",
      origin: "https://hearth.example.com",
      subject: "user-one",
    })
  })

  it("uses synchronized route metadata without contacting the Relay", async () => {
    fakes.relayBrowserMetadata.mockReturnValue({
      browserOrigin: "https://relay-snapshot.example.com",
      mode: "hearth",
    })

    const issued = await issueConsoleCapabilityForRequest({
      authenticate: () => Promise.resolve(user),
      instanceId: "instance-one",
      publicKeyJwk,
      relayId: "relay-one",
      write: false,
    })

    expect(fakes.relayRpc).not.toHaveBeenCalled()
    expect(issued).toMatchObject({
      browserOrigin: "https://relay-snapshot.example.com",
      proxyMode: "hearth",
    })
  })

  it("does not resolve browser metadata for the Hearth proxy", async () => {
    fakes.relayBrowserMetadata.mockReturnValue({
      browserOrigin: "https://relay-snapshot.example.com",
      mode: "hearth",
    })

    const prepared = await prepareConsoleCapabilityForUser({
      credentialId: "credential-one",
      instanceId: "instance-one",
      publicKeyJwk,
      relayId: "relay-one",
      user,
    })

    expect(fakes.requirePermissions).toHaveBeenCalledWith({
      instanceId: "instance-one",
      permissions: ["instance.console.read"],
      relayId: "relay-one",
      user,
    })
    expect(fakes.relayRpc).not.toHaveBeenCalled()
    expect(prepared.capability).toMatchObject({
      browserOrigin: "https://relay.example.com",
      proxyMode: "none",
    })
  })

  it("issues a session-bound short mutation capability only after v2 negotiation", async () => {
    fakes.features.add("browser-capability-v2")
    fakes.features.add("browser-lease-renewal-v1")

    const issued = await issueBrowserCapabilitiesForRequest({
      authenticate: () => Promise.resolve({ sessionId: "session-one", user }),
      publicKeyJwk,
      relayId: "relay-one",
      requests: [{ kind: "console", optInV2: true, write: true }],
      resource: { id: "instance-one", kind: "instance" },
    })

    expect(issued.capabilities[0]).toMatchObject({
      kind: "console",
      version: 2,
    })
    const payload = decodeCapabilityPayload(issued.capabilities[0]!.capability)
    expect(payload).toMatchObject({
      authorizationRevision: 7,
      issuerGeneration: 1,
      loginSessionId: "session-one",
      operation: "console",
      version: 2,
    })
    expect(Number(payload.expiresAt) - Number(payload.issuedAt)).toBe(30_000)
  })

  describe("database consoles", () => {
    // Alice can read the logs of database-one only.
    beforeEach(() => {
      fakes.features.add("browser-capability-v2")
      fakes.features.add("browser-lease-renewal-v1")
      fakes.features.add("console-resources-v1")
      fakes.requirePermissions.mockImplementation(
        (input: { databaseId?: string; permissions: Array<string> }) =>
          input.databaseId === "database-one" &&
          input.permissions.every(
            (permission) => permission === "database.logs.read"
          )
            ? Effect.void
            : Effect.fail(new Error("Permission denied"))
      )
    })

    const issue = (
      databaseId: string,
      write = false
    ): ReturnType<typeof issueBrowserCapabilitiesForRequest> =>
      issueBrowserCapabilitiesForRequest({
        authenticate: () => Promise.resolve({ sessionId: "session-one", user }),
        publicKeyJwk,
        relayId: "relay-one",
        requests: [{ kind: "console", optInV2: true, write }],
        resource: { id: databaseId, kind: "database" },
      })

    it("issues a capability to read a database's console", async () => {
      const issued = await issue("database-one")

      expect(
        decodeCapabilityPayload(issued.capabilities[0]!.capability)
      ).toMatchObject({
        actions: ["database.logs.read"],
        instanceId: "database-one",
        operation: "console",
        resourceKind: "database",
        version: 2,
      })
    })

    it("refuses a database whose logs the person can't read", async () => {
      await expect(issue("database-two")).rejects.toThrow()
    })

    it("refuses console input to a database", async () => {
      await expect(issue("database-one", true)).rejects.toThrow()
    })

    it("refuses Relays that can't stream database consoles", async () => {
      fakes.features.delete("console-resources-v1")

      await expect(issue("database-one")).rejects.toThrow(
        "Update this Relay to view these logs."
      )
    })
  })

  describe("apps", () => {
    const appId = "a".repeat(40)
    // Alice holds app permissions on the Relay, which cover all its apps;
    // `granted` lists them.
    let granted: Array<string>
    beforeEach(() => {
      granted = ["app.logs.read", "app.files.read"]
      for (const feature of [
        "browser-capability-v2",
        "browser-lease-renewal-v1",
        "console-resources-v1",
        "file-request-replay-v1",
        "apps-v1",
      ]) {
        fakes.features.add(feature)
      }
      fakes.requirePermissions.mockImplementation(
        (input: {
          databaseId?: string
          instanceId?: string
          permissions: Array<string>
        }) =>
          !input.databaseId &&
          !input.instanceId &&
          input.permissions.every((permission) => granted.includes(permission))
            ? Effect.void
            : Effect.fail(new Error("Permission denied"))
      )
    })

    const issueLogs = () =>
      issueBrowserCapabilitiesForRequest({
        authenticate: () => Promise.resolve({ sessionId: "session-one", user }),
        publicKeyJwk,
        relayId: "relay-one",
        requests: [{ kind: "console", optInV2: true, write: false }],
        resource: { id: appId, kind: "app" },
      })
    const issueFiles = (
      action: "instance.files.download" | "instance.files.upload"
    ) =>
      issueFileCapabilityForRequest({
        action,
        authenticate: () => Promise.resolve({ sessionId: "session-one", user }),
        instanceId: `app:${appId}`,
        optInV2: true,
        path: "config.yml",
        publicKeyJwk,
        relayId: "relay-one",
      })

    it("issues a capability to read an app's logs", async () => {
      const issued = await issueLogs()

      expect(
        decodeCapabilityPayload(issued.capabilities[0]!.capability)
      ).toMatchObject({
        actions: ["app.logs.read"],
        instanceId: appId,
        resourceKind: "app",
      })
    })

    it("refuses Relays that can't run apps", async () => {
      fakes.features.delete("apps-v1")

      await expect(issueLogs()).rejects.toThrow(
        "Update this Relay to view these logs."
      )
    })

    it("transfers an app's files with the app's own file permissions", async () => {
      const issued = await issueFiles("instance.files.download")

      expect(decodeCapabilityPayload(issued.capability)).toMatchObject({
        actions: ["app.files.download"],
        instanceId: `app:${appId}`,
        operation: "file",
        resourceKind: "app",
      })
      await expect(issueFiles("instance.files.upload")).rejects.toThrow()
      granted = ["instance.files.read", "instance.files.write"]
      await expect(issueFiles("instance.files.download")).rejects.toThrow()
    })
  })

  it("uses the generation synchronized after stale issuance material was loaded", async () => {
    fakes.features.add("browser-capability-v2")
    fakes.features.add("browser-lease-renewal-v1")
    fakes.relayBrowserAuthorizationReady.mockResolvedValue(4)

    const issued = await issueBrowserCapabilitiesForRequest({
      authenticate: () => Promise.resolve({ sessionId: "session-one", user }),
      publicKeyJwk,
      relayId: "relay-one",
      requests: [{ kind: "console", optInV2: true, write: false }],
      resource: { id: "instance-one", kind: "instance" },
    })

    expect(
      decodeCapabilityPayload(issued.capabilities[0]!.capability)
    ).toMatchObject({ issuerGeneration: 4, version: 2 })
  })

  it("re-authorizes when the revision changes during capability issuance", async () => {
    fakes.features.add("browser-capability-v2")
    fakes.features.add("browser-lease-renewal-v1")
    fakes.refreshUser
      .mockImplementationOnce(({ user: current }) =>
        Effect.succeed({ revision: 7, user: current })
      )
      .mockImplementationOnce(({ user: current }) =>
        Effect.succeed({ revision: 8, user: current })
      )
      .mockImplementationOnce(({ user: current }) =>
        Effect.succeed({ revision: 8, user: current })
      )
    fakes.revisions
      .mockReturnValueOnce(Effect.succeed(8))
      .mockReturnValueOnce(Effect.succeed(8))
      .mockReturnValueOnce(Effect.succeed(8))

    const issued = await issueBrowserCapabilitiesForRequest({
      authenticate: () => Promise.resolve({ sessionId: "session-one", user }),
      publicKeyJwk,
      relayId: "relay-one",
      requests: [{ kind: "console", optInV2: true, write: true }],
      resource: { id: "instance-one", kind: "instance" },
    })

    expect(
      decodeCapabilityPayload(issued.capabilities[0]!.capability)
    ).toMatchObject({ authorizationRevision: 8 })
  })

  it("refuses to sign when access is revoked during capability issuance", async () => {
    const revoked = new Error("Console access denied")
    fakes.features.add("browser-capability-v2")
    fakes.features.add("browser-lease-renewal-v1")
    fakes.requirePermissions
      .mockReturnValueOnce(Effect.void)
      .mockReturnValue(Effect.fail(revoked))

    await expect(
      issueBrowserCapabilitiesForRequest({
        authenticate: () => Promise.resolve({ sessionId: "session-one", user }),
        publicKeyJwk,
        relayId: "relay-one",
        requests: [{ kind: "console", optInV2: true, write: true }],
        resource: { id: "instance-one", kind: "instance" },
      })
    ).rejects.toBe(revoked)
  })
})

function decodeCapabilityPayload(capability: string): Record<string, unknown> {
  const [payload] = capability.split(".")
  if (!payload) throw new Error("Capability payload is missing")
  return JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8")
  ) as Record<string, unknown>
}
