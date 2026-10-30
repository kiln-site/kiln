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
}))

vi.mock("@/lib/access-control", () => ({
  isPlatformAdmin: (current: AuthenticatedUser) => current.role === "admin",
  refreshRelayAuthorizationUserEffect: fakes.refreshUser,
  requireRelayPermissionsEffect: fakes.requirePermissions,
}))

vi.mock("@/lib/environment", () => ({
  browserCapabilityMinimumVersion: () => 1,
  configuredKilnInstallationId: () => "kiln-test",
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
  issueFileCapabilityForRequest,
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
  controlDial: "hearth",
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
  describe("host file capabilities", () => {
    const hostId = "H".repeat(43)
    let granted: string[]
    beforeEach(() => {
      granted = ["relay.files.read"]
      fakes.loadRelay.mockReturnValue(
        Effect.succeed({ ...material, relay: { ...relay, id: hostId } })
      )
      for (const feature of [
        "browser-capability-v2",
        "file-request-replay-v1",
        "relay-host-files-v1",
      ])
        fakes.features.add(feature)
      fakes.requirePermissions.mockImplementation(
        (input: { instanceId?: string; permissions: string[] }) =>
          !input.instanceId &&
          input.permissions.every((permission) => granted.includes(permission))
            ? Effect.void
            : Effect.fail(new Error("Permission denied"))
      )
    })
    const issue = (
      action: "instance.files.download" | "instance.files.upload",
      instanceId = hostId
    ) =>
      issueFileCapabilityForRequest({
        action,
        instanceId,
        relayId: hostId,
        path: "etc/os-release",
        publicKeyJwk,
        optInV2: true,
        authenticate: () => Promise.resolve({ sessionId: "session-one", user }),
      })
    it("uses host permissions and keeps another Relay's root outside the capability", async () => {
      expect(
        decodeCapabilityPayload(
          (await issue("instance.files.download")).capability
        )
      ).toMatchObject({
        actions: ["relay.files.download"],
        instanceId: hostId,
        resourceKind: "relay",
        operation: "file",
      })
      await expect(
        issue("instance.files.download", "J".repeat(43))
      ).rejects.toThrow()
      await expect(issue("instance.files.upload")).rejects.toThrow()
      granted = ["instance.files.read", "app.files.read"]
      await expect(issue("instance.files.download")).rejects.toThrow()
    })
  })

  describe("Kiln's own logs", () => {
    beforeEach(() => {
      for (const feature of [
        "browser-capability-v2",
        "browser-lease-renewal-v1",
        "console-resources-v1",
        "relay-platform-v2",
      ]) {
        fakes.features.add(feature)
      }
    })

    const issueKilnLogs = (current: AuthenticatedUser) =>
      issueBrowserCapabilitiesForRequest({
        authenticate: () =>
          Promise.resolve({ sessionId: "session-one", user: current }),
        publicKeyJwk,
        relayId: "relay-one",
        requests: [{ kind: "console", optInV2: true, write: false }],
        resource: { id: "relay-one", kind: "platform", stream: "hearth" },
      })

    it("refuses them to anyone but platform administrators, whatever they hold on the Relay", async () => {
      await expect(issueKilnLogs(user)).rejects.toThrow(
        "Only platform administrators"
      )
    })
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
