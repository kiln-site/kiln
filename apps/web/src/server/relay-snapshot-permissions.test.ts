import { Effect } from "effect"
import { relayInstanceSchema, relayNodeSchema } from "@workspace/contracts"
import { beforeEach, describe, expect, it, vi } from "vite-plus/test"
import type { AccessGrant } from "@/lib/access-control"

const mocks = vi.hoisted(() => ({
  grants: [] as AccessGrant[],
  snapshot: undefined as unknown,
  failSnapshot: false,
}))
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    handler: (handler: unknown, serverHandler?: unknown) => ({
      __executeServer: serverHandler ?? handler,
    }),
    validator: () => ({
      handler: (handler: unknown, serverHandler?: unknown) => ({
        __executeServer: serverHandler ?? handler,
      }),
    }),
  }),
}))
vi.mock("@/server/auth", () => ({
  requireEligibleResourceUser: async () => ({
    id: "user-one",
    role: "user",
    emailVerified: true,
    isDevelopmentBypass: false,
  }),
}))
vi.mock("@/lib/access-control", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/access-control")>()),
  listUserGrants: async () => mocks.grants,
}))
vi.mock("@/effect/runtime", () => ({
  runAppEffect: (_name: string, effect: Effect.Effect<unknown, unknown>) =>
    Effect.runPromise(effect),
}))
vi.mock("@/lib/relay-registry", () => ({
  listPersistedRelays: async () => [
    { id: "relay-one", name: "Relay one", enabled: true },
  ],
}))
vi.mock("@/lib/relay-client", () => ({
  cachedRelayJsonEffect: () =>
    mocks.failSnapshot
      ? Effect.fail(new Error("Offline"))
      : Effect.succeed(mocks.snapshot),
  cachedRelayFallbackJsonEffect: () => Effect.succeed(mocks.snapshot),
  relayCachePolicy: { snapshot: (relayId: string) => relayId },
}))
vi.mock("@/server/domains.server", () => ({
  applyManagedDomainAddressesEffect: (instances: unknown) =>
    Effect.succeed(instances),
}))

vi.mock("@/lib/final-instance-deletion", () => ({}))
vi.mock("@/lib/file-activity", () => ({}))
vi.mock("@/lib/instance-registry", () => ({}))

// Exercise the server provider rather than the generated client RPC stub.
import {
  getRelaySnapshot_createServerFn_handler as getRelaySnapshot,
  // @ts-expect-error TanStack Start exposes the provider through a Vite query.
} from "./relay?tss-serverfn-split"

const instance = relayInstanceSchema.parse({
  connectAddress: "server.test",
  containerId: null,
  desiredState: "running",
  directory: "a".repeat(40),
  game: "Minecraft",
  id: "a".repeat(40),
  implementation: "Paper",
  javaVersion: "21",
  name: "Server",
  observedState: "running",
  service: "server",
  shortId: "aaaaaaaa",
  status: "running",
  version: "1.21.11",
})
const node = relayNodeSchema.parse({
  id: "node-one",
  name: "Private node",
  version: "private-version",
  platform: "linux",
  arch: "arm64",
  cpu: { cores: 8, loadPercent: 30 },
  memory: { totalBytes: 100, usedBytes: 50 },
  storage: { totalBytes: 1000, usedBytes: 500 },
  docker: { available: true, version: "private-docker" },
  connectedAt: "2026-09-08T12:00:00.000Z",
})
beforeEach(() => {
  mocks.failSnapshot = false
  mocks.snapshot = {
    node,
    instances: [instance, { ...instance, id: "b".repeat(40) }],
  }
  mocks.grants = [
    {
      id: "child",
      relayId: "relay-one",
      resourceId: instance.id,
      resourceType: "instance",
      role: "viewer",
      permissions: ["instance.read"],
    },
  ]
})

describe("Relay snapshot server permissions", () => {
  it.each([false, true])(
    "retains child inventory but omits unauthorized node details (fallback: %s)",
    async (fallback) => {
      mocks.failSnapshot = fallback
      const snapshot = await getRelaySnapshot()
      expect(snapshot.nodes).toEqual([])
      expect(snapshot.instances).toHaveLength(1)
      expect(snapshot.instances[0]).toMatchObject({
        id: instance.id,
        relayId: "relay-one",
        relayName: "Relay one",
        routeId: "relay-one-aaaaaaaa",
      })
      expect(JSON.stringify(snapshot)).not.toContain("private-")
    }
  )

  it("returns nodes only after an independent relay.read grant", async () => {
    mocks.grants.push({
      id: "node",
      relayId: "relay-one",
      resourceId: "relay-one",
      resourceType: "relay",
      role: "viewer",
      permissions: ["relay.read"],
    })
    const snapshot = await getRelaySnapshot()
    expect(snapshot.nodes).toEqual([
      {
        ...node,
        relayId: "relay-one",
        relayName: "Relay one",
        relayStatus: "connected",
      },
    ])
    expect(snapshot.instances).toHaveLength(1)
  })
})
