import { beforeEach, describe, expect, it, vi } from "vite-plus/test"
import {
  builtinTailscaleBrick,
  relayInstanceSchema,
  relaySnapshotSchema,
} from "@workspace/contracts"
import type { AccessGrant } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
const mocks = vi.hoisted(() => {
  Object.assign(process.env, {
    DB_HOST: "127.0.0.1",
    DB_NAME: "test",
    DB_PASSWORD: "test",
    DB_USERNAME: "test",
  })
  return {
    grants: [] as AccessGrant[],
    user: {} as AuthenticatedUser,
    rpc: vi.fn(),
  }
})
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    validator: () => ({
      handler: (handler: unknown, serverHandler?: unknown) => ({
        __executeServer: serverHandler ?? handler,
      }),
    }),
    handler: (handler: unknown, serverHandler?: unknown) => ({
      __executeServer: serverHandler ?? handler,
    }),
  }),
}))
vi.mock("@/server/auth", () => ({
  requireEligibleResourceUser: async () => mocks.user,
}))
vi.mock("@/lib/access-control", async (original) => ({
  ...(await original<typeof import("@/lib/access-control")>()),
  listUserGrants: async () => mocks.grants,
  requireRelayPermission: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/lib/relay-registry", () => ({
  listPersistedRelays: async () => [{ id: "relay-a", enabled: true }],
}))
vi.mock("@/lib/brick-catalog-source.server", () => ({
  hydrateBrickIcon: async (brick: unknown) => brick,
}))
vi.mock("@/effect/runtime", () => ({
  runAppEffect: (_name: string, input: unknown) => mocks.rpc(input),
}))
vi.mock("@/lib/relay-client", () => ({
  relayJsonEffect: (_relay: unknown, path: string) => path,
}))
// @ts-expect-error TanStack's server split exposes the handler for boundary tests.
import { getInstanceStartup_createServerFn_handler as getInstanceStartup } from "./bricks?tss-serverfn-split"
const instance = relayInstanceSchema.parse({
  id: "a".repeat(40),
  shortId: "aaaaaaaa",
  name: "Own server",
  service: "server",
  directory: "/data/server",
  containerId: "container",
  desiredState: "stopped",
  observedState: "stopped",
  status: "stopped",
  game: "Minecraft",
  implementation: "paper",
  javaVersion: "21",
  version: "1.21",
  connectAddress: "play.example.test:25565",
  brickSource: builtinTailscaleBrick.source,
  variables: {},
  limits: { diskBytes: 1024 ** 3, memoryBytes: 1024 ** 3 },
})
const snapshot = relaySnapshotSchema.parse({
  instances: [
    instance,
    {
      ...instance,
      id: "b".repeat(40),
      limits: { diskBytes: 2 * 1024 ** 3, memoryBytes: 2 * 1024 ** 3 },
    },
  ],
  node: {
    id: "relay-a",
    name: "Relay",
    version: "test",
    platform: "linux",
    arch: "arm64",
    connectedAt: "2026-01-01T00:00:00.000Z",
    cpu: { cores: 4, loadPercent: 0 },
    memory: { totalBytes: 8 * 1024 ** 3, usedBytes: 3 * 1024 ** 3 },
    storage: { totalBytes: 20 * 1024 ** 3, usedBytes: 4 * 1024 ** 3 },
    docker: { available: true, version: "test" },
  },
})
beforeEach(() => {
  mocks.grants = []
  mocks.user = {
    id: "user",
    role: "user",
    emailVerified: true,
    emailVerifiedAt: "2026-01-01T00:00:00Z",
    status: "enabled",
  } as AuthenticatedUser
  mocks.rpc.mockImplementation(async (path: string) =>
    path === "/v1/snapshot" ? snapshot : builtinTailscaleBrick
  )
})
describe("Startup node allocation boundary", () => {
  it.each(["instance", "database", "relay"] as const)(
    "withholds host allocation without relay.read on a %s grant",
    async (resourceType) => {
      mocks.grants = [
        {
          id: "grant",
          relayId: "relay-a",
          resourceId: instance.id,
          resourceType,
          role: "viewer",
          permissions: ["instance.configuration.read"],
        },
      ]
      const result = await getInstanceStartup({
        data: { relayId: "relay-a", instanceId: instance.id },
      })
      expect(result.allocation).toBeNull()
      expect(result.instance.limits).toEqual(instance.limits)
      expect(result.brick).toEqual(builtinTailscaleBrick)
      expect(result.variables).toBeDefined()
    }
  )
  it("does not reuse node permission from another Relay", async () => {
    mocks.grants = [
      {
        id: "grant",
        relayId: "relay-b",
        resourceId: "relay-b",
        resourceType: "relay",
        role: "viewer",
        permissions: ["relay.read"],
      },
    ]
    expect(
      (
        await getInstanceStartup({
          data: { relayId: "relay-a", instanceId: instance.id },
        })
      ).allocation
    ).toBeNull()
  })
  it.each([false, true])(
    "preserves host allocation for node readers or admin=%s",
    async (admin) => {
      if (admin) mocks.user.role = "admin"
      else
        mocks.grants = [
          {
            id: "grant",
            relayId: "relay-a",
            resourceId: "relay-a",
            resourceType: "relay",
            role: "viewer",
            permissions: ["relay.read"],
          },
        ]
      const result = await getInstanceStartup({
        data: { relayId: "relay-a", instanceId: instance.id },
      })
      expect(result.allocation.memory).toEqual({
        availableBytes: 6 * 1024 ** 3,
        nodeTotalBytes: 8 * 1024 ** 3,
        nodeUsedBytes: 3 * 1024 ** 3,
      })
      expect(result.allocation.storage.nodeTotalBytes).toBe(20 * 1024 ** 3)
    }
  )
})
