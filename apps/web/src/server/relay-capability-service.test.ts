import { generateKeyPairSync } from "node:crypto"

import { beforeEach, describe, expect, it, vi } from "vite-plus/test"
import { Effect } from "effect"

vi.hoisted(() => {
  process.env.DB_HOST ??= "127.0.0.1"
  process.env.DB_NAME ??= "test"
  process.env.DB_PASSWORD ??= "test"
  process.env.DB_USERNAME ??= "test"
})

const fakes = vi.hoisted(() => ({
  decryptCredentials: vi.fn(),
  loadRelay: vi.fn(),
  relayRpc: vi.fn(),
  requirePermissions: vi.fn(),
  span: { setAttribute: vi.fn() },
}))

vi.mock("@sentry/tanstackstart-react", () => ({
  startSpan: (_options: unknown, run: (span: typeof fakes.span) => unknown) =>
    run(fakes.span),
}))

vi.mock("@/lib/access-control", () => ({
  requireRelayPermissionsEffect: fakes.requirePermissions,
}))

vi.mock("@/lib/environment", () => ({
  kilnPublicUrl: () => new URL("https://hearth.example.com"),
}))

vi.mock("@/lib/relay-connection", () => ({
  relayRpc: fakes.relayRpc,
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
import { issueConsoleCapabilityForRequest } from "@/server/relay-capability-service"

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
  fakes.decryptCredentials.mockReturnValue(Effect.succeed(credentials))
  fakes.relayRpc.mockResolvedValue({
    browserOrigin: "https://relay-live.example.com",
    mode: "none",
  })
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

  it("authorizes once before parallel signer and live-route work", async () => {
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

    expect(fakes.requirePermissions).toHaveBeenCalledOnce()
    expect(fakes.requirePermissions).toHaveBeenCalledWith({
      instanceId: "instance-one",
      permissions: ["instance.console.read", "instance.console.write"],
      relayId: "relay-one",
      user,
    })
    expect(fakes.decryptCredentials).toHaveBeenCalledOnce()
    expect(fakes.relayRpc).toHaveBeenCalledOnce()
    expect(issued.browserOrigin).toBe("https://relay-live.example.com")
    expect(decodeCapabilityPayload(issued.capability)).toMatchObject({
      actions: ["instance.console.read", "instance.console.write"],
      audience: "relay-one",
      instanceId: "instance-one",
      origin: "https://hearth.example.com",
      subject: "user-one",
    })
  })
})

function decodeCapabilityPayload(capability: string): Record<string, unknown> {
  const [payload] = capability.split(".")
  if (!payload) throw new Error("Capability payload is missing")
  return JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8")
  ) as Record<string, unknown>
}
