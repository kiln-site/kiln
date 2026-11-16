import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import { createTunnelDefinitionEffect } from "@/effect/tunnels"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { runOperationPromise } from "@/operations/operation"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertInstance, insertRelay, selectRows } from "@/test/seed"

import { connectTunnelOperation } from "./tunnels.server"

// The Relays and the Tailscale API are the fakes. Each Relay keeps its
// gateways as it would (`tunnel.*`, its own name for one), with addresses for
// what each connects, and undoes a gateway it couldn't make itself. Tailscale
// keeps a device for each gateway logged in with a key it made.
const fake = vi.hoisted(() => ({
  applies: [] as Array<{ authKey: boolean; id: string; relayId: string }>,
  devices: new Set<string>(),
  failDns: false,
  gateways: new Map<string, Map<string, Record<string, unknown>>>(),
  instances: new Map<string, Array<string>>(),
  nextSubnet: 10,
}))

const gatewaysOn = (relayId: string) => {
  const gateways = fake.gateways.get(relayId) ?? new Map()
  fake.gateways.set(relayId, gateways)
  return gateways
}

vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (
    relay: { id: string },
    operation: string,
    payload: Record<string, unknown>
  ) => {
    const gateways = gatewaysOn(relay.id)
    switch (operation) {
      case "relay.snapshot":
        return {
          instances: (fake.instances.get(relay.id) ?? []).map((id) => ({
            brickPrimaryPortProtocol: "tcp",
            brickType: "minecraft",
            connectAddress: "203.0.113.10:25565",
            containerId: "container",
            desiredState: "running",
            directory: id,
            game: "Minecraft",
            id,
            implementation: "Paper",
            javaVersion: "21",
            managedByRelay: true,
            name: `Survival ${id.slice(0, 2)}`,
            observedState: "running",
            publicHost: "203.0.113.10",
            publicPort: 25_565,
            service: id,
            status: "running",
            version: "1.21.11",
          })),
          node: {
            arch: "arm64",
            connectedAt: "2026-01-01T00:00:00.000Z",
            cpu: { cores: 4, loadPercent: 0 },
            docker: { available: true, version: "test" },
            id: relay.id,
            memory: { totalBytes: 1, usedBytes: 0 },
            name: "Relay",
            platform: "linux",
            storage: { totalBytes: 1, usedBytes: 0 },
            version: "test",
          },
        }
      case "tunnel.list":
        return [...gateways.values()].filter(
          (gateway) => !gateway.removalPending
        )
      case "tunnel.state":
        return [...gateways.values()].map((gateway) => ({
          bindings: (gateway.bindings as Array<object>).map((binding) => ({
            ...binding,
            frozen: false,
          })),
          id: gateway.id,
          removalPending: Boolean(gateway.removalPending),
          tailnetId: gateway.tailnetId,
        }))
      case "tunnel.apply": {
        const id = payload.id as string
        const existing = gateways.get(id)
        fake.applies.push({
          authKey: typeof payload.authKey === "string",
          id,
          relayId: relay.id,
        })
        if (!existing && !payload.authKey) {
          throw new Error("An auth key is required to install Tailscale")
        }
        const subnet =
          (existing?.subnet as string | undefined) ??
          `10.${fake.nextSubnet++}.0.0/24`
        const prefix = subnet.split(".").slice(0, 3).join(".")
        const gateway = {
          bindings: (
            payload.bindings as Array<{ enabled: boolean; memberId: string }>
          ).map((binding, index) => ({
            ...binding,
            address: `${prefix}.${index + 10}`,
          })),
          brick: {
            id: "tailscale",
            images: {
              dns: "coredns/coredns:1.14.7",
              tailscale: "tailscale/tailscale:stable",
            },
            revision: 1,
            source: null,
          },
          components: { coreDnsRunning: true, tailscaleRunning: true },
          domains: payload.domains,
          hostname: payload.hostname,
          id,
          name: payload.name,
          observedState: "running",
          status: {
            connected: true,
            ipv4Address: `100.64.0.${fake.nextSubnet}`,
            ipv6Address: null,
            message: null,
          },
          subnet,
          tailnetId: payload.tailnetId,
        }
        gateways.set(id, gateway)
        if (!existing) fake.devices.add(payload.hostname as string)
        return gateway
      }
      case "tunnel.remove": {
        const id = payload.id as string
        const gateway = gateways.get(id)
        if (!gateway) return { id, removed: false }
        if (payload.mode === "prepare") gateway.removalPending = true
        if (payload.mode === "rollback") gateway.removalPending = false
        if (payload.mode === "commit") {
          gateways.delete(id)
          // The Relay logs it out, unless Tailscale already deleted it.
          fake.devices.delete(gateway.hostname as string)
        }
        return { id, removed: payload.mode === "commit" }
      }
      case "tunnel.dns": {
        if (fake.failDns) throw new Error("CoreDNS could not be reached")
        return gateways.get(payload.id as string)
      }
      default:
        throw new Error(`Unexpected Relay request ${operation}`)
    }
  },
}))

vi.mock("@/effect/tailscale-api", async (importOriginal) => {
  const { Effect } = await import("effect")
  return {
    ...(await importOriginal<typeof import("@/effect/tailscale-api")>()),
    createTailscaleNodeAuthKeyEffect: () =>
      Effect.succeed("tskey-auth-kTest1234CNTRL-abcdefghijklmnop"),
    removeTailscaleControlPlaneDeviceEffect: (
      _credential: unknown,
      gateway: { hostname: string }
    ) =>
      Effect.sync(() => {
        fake.devices.delete(gateway.hostname)
      }),
    syncTailscaleControlPlaneEffect: () => Effect.succeed({ resolvers: [] }),
  }
})

// Kiln's own catalog, with its Tailscale tunnel Brick.
vi.mock("@/server/brick-catalogs.server", async (importOriginal) => {
  const { brickSchema } = await import("@workspace/contracts")
  return {
    ...(await importOriginal<
      typeof import("@/server/brick-catalogs.server")
    >()),
    defaultBrickCatalog: async () => ({
      bricks: [
        brickSchema.parse({
          deploy: { image: "tailscale/tailscale:stable", type: "image" },
          format: "kiln.brick/v2",
          inputs: [],
          kind: "tunnel",
          metadata: {
            author: "Kiln",
            id: "tailscale",
            name: "Tailscale",
            summary: "Reach what runs on a Relay by name.",
            tags: [],
          },
          source: "https://bricks.test/tailscale.yml",
          tunnel: { dns: { image: "coredns/coredns:1.14.7" } },
          type: "tailscale",
        }),
      ],
    }),
  }
})

vi.mock("@/lib/realtime-source.server", () => ({
  publishRealtimeChange: () => undefined,
}))

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"s".repeat(32)}`)

afterAll(() => disposeAppRuntime())

const admin = vi.hoisted((): AuthenticatedUser => ({
  email: "owner@example.test",
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  id: "owner",
  isDevelopmentBypass: false,
  name: "owner",
  role: "admin",
  status: "enabled",
  twoFactorEnabled: false,
}))

const tunnelId = "a".repeat(12)
const relayOne = "1".repeat(12)
const relayTwo = "2".repeat(12)
const survival = "c".repeat(12)
const creative = "d".repeat(12)

const seed = Effect.gen(function* () {
  yield* resetDatabase
  fake.applies = []
  fake.devices.clear()
  fake.failDns = false
  fake.gateways.clear()
  fake.instances = new Map([
    [relayOne, [survival, creative]],
    [relayTwo, []],
  ])
  yield* insertRelay(relayOne, { name: "Relay One" })
  yield* insertRelay(relayTwo, { name: "Relay Two" })
  yield* insertInstance(relayOne, survival, { owner_id: admin.id })
  yield* insertInstance(relayOne, creative, { owner_id: admin.id })
  yield* createTunnelDefinitionEffect(
    {
      brickSource: "https://bricks.test/tailscale.yml",
      domains: ["kiln"],
      id: tunnelId,
      name: "Home",
    },
    { clientId: "tailscale-client", scopes: [], tags: ["tag:kiln"] },
    "tailscale-client-secret-0123456789",
    admin.id
  )
})

// Connecting one, or disconnecting it, as its Network tab does.
const connect = (memberId: string, connected = true) =>
  Effect.promise(() =>
    runOperationPromise(
      connectTunnelOperation,
      {
        connected,
        memberId: `instance:${memberId}`,
        relayId: relayOne,
        tunnelId,
      },
      { user: admin }
    ).then(
      () => null,
      (error: unknown) =>
        error instanceof Error ? error.message : String(error)
    )
  )

const gatewayRows = selectRows<{ id: string; relay_id: string }>(
  "tunnel_gateway"
)
const nameRows = selectRows<{ label: string; member_id: string }>("tunnel_name")

describeMysql("a tunnel's gateways", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "makes a Relay's gateway as the first thing there connects, and reuses it",
      () =>
        Effect.gen(function* () {
          yield* seed

          assert.isNull(yield* connect(survival))
          const [gateway] = [...gatewaysOn(relayOne).values()]
          assert.ok(gateway, "Relay One has a gateway")
          assert.deepEqual(
            (yield* gatewayRows).map(({ id, relay_id }) => [id, relay_id]),
            [[gateway.id, relayOne]]
          )
          assert.strictEqual(fake.devices.size, 1)
          // A Relay nothing connects on gets none.
          assert.strictEqual(gatewaysOn(relayTwo).size, 0)

          assert.isNull(yield* connect(creative))
          assert.strictEqual(gatewaysOn(relayOne).size, 1)
          assert.deepEqual(
            (
              (gatewaysOn(relayOne).get(gateway.id as string)?.bindings ??
                []) as Array<{ memberId: string }>
            ).map(({ memberId }) => memberId),
            [`instance:${survival}`, `instance:${creative}`]
          )
          // Only the first apply logged a new device in.
          assert.deepEqual(
            fake.applies.map(({ authKey, id }) => [id, authKey]),
            [
              [gateway.id, true],
              [gateway.id, false],
            ]
          )
          assert.strictEqual((yield* gatewayRows).length, 1)
          assert.sameMembers(
            (yield* nameRows).map(({ member_id }) => member_id),
            [`instance:${survival}`, `instance:${creative}`]
          )
        })
    )

    it.effect(
      "takes a Relay's gateway and its Tailscale device away as the last thing there leaves",
      () =>
        Effect.gen(function* () {
          yield* seed
          assert.isNull(yield* connect(survival))
          assert.isNull(yield* connect(creative))
          const [gateway] = [...gatewaysOn(relayOne).values()]

          assert.isNull(yield* connect(survival, false))
          assert.strictEqual(gatewaysOn(relayOne).size, 1)
          assert.strictEqual(fake.devices.size, 1)

          assert.isNull(yield* connect(creative, false))
          assert.strictEqual(gatewaysOn(relayOne).size, 0)
          assert.isFalse(fake.devices.has(gateway?.hostname as string))
          assert.deepEqual(yield* gatewayRows, [])
          assert.deepEqual(yield* nameRows, [])
        })
    )

    it.effect("leaves nothing of a gateway it couldn't finish", () =>
      Effect.gen(function* () {
        yield* seed
        fake.failDns = true

        const refused = yield* connect(survival)

        assert.include(refused ?? "", "CoreDNS could not be reached")
        assert.strictEqual(gatewaysOn(relayOne).size, 0)
        assert.strictEqual(fake.devices.size, 0)
        assert.deepEqual(yield* gatewayRows, [])
        assert.deepEqual(yield* nameRows, [])
      })
    )
  })
})
