import { assert, layer } from "@effect/vitest"
import { Effect, Layer, Schedule } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { tunnelSchema } from "@workspace/contracts"

import {
  requestTunnelCleanupEffect,
  type PersistedGateway,
} from "@/effect/tunnel-gateways"
import { createTunnelDefinitionEffect } from "@/effect/tunnels"
import { deleteTunnel, startTunnelDeletion } from "@/lib/tunnel-deletion.server"
import { disposeAppRuntime } from "@/effect/runtime"
import { loadOperation } from "@/operations/records"
import { testOperationsEngine } from "@/operations/test/engine"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, selectRows } from "@/test/seed"

// The Relay and the Tailscale API are the only fakes: Relays holding
// Tailscale stacks as `<relay>/<stack>`, and a tunnel with device hostnames
// and split-DNS resolvers.
const fake = vi.hoisted(() => ({
  relayStacks: new Set<string>(),
  tunnelDevices: new Set<string>(),
  tunnelDns: new Map<string, ReadonlyArray<string>>(),
  tunnelDown: false,
  tunnelSecret: "tailscale-client-secret",
}))

vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (
    relay: { id: string },
    operation: string,
    payload: unknown
  ) => {
    if (operation !== "tunnel.remove") {
      throw new Error(`Unexpected Relay operation ${operation}`)
    }
    const { id, mode } = payload as { id: string; mode: "commit" | "prepare" }
    if (mode === "commit") {
      fake.relayStacks.delete(`${relay.id}/${id}`)
    }
    return { id, removed: mode === "commit" }
  },
}))

vi.mock("@/effect/tailscale-api", async (importOriginal) => {
  const { Effect } = await import("effect")
  const tunnel = (credential: {
    clientSecret: string
  }): import("effect").Effect.Effect<void, Error> =>
    fake.tunnelDown || credential.clientSecret !== fake.tunnelSecret
      ? Effect.fail(new Error("Tailscale returned HTTP 503"))
      : Effect.void
  return {
    ...(await importOriginal<typeof import("@/effect/tailscale-api")>()),
    removeTailscaleControlPlaneDeviceEffect: (
      credential: { clientSecret: string },
      deployment: { hostname: string }
    ) =>
      tunnel(credential).pipe(
        Effect.andThen(
          Effect.sync(() => {
            fake.tunnelDevices.delete(deployment.hostname)
          })
        )
      ),
    syncTailscaleControlPlaneEffect: (
      credential: { clientSecret: string },
      network: {
        gateways: ReadonlyArray<{ status: { ipv4Address: string | null } }>
        domains: ReadonlyArray<string>
      }
    ) =>
      tunnel(credential).pipe(
        Effect.map(() => {
          const resolvers = network.gateways.flatMap(({ status }) =>
            status.ipv4Address ? [status.ipv4Address] : []
          )
          for (const domain of network.domains) {
            if (resolvers.length > 0) fake.tunnelDns.set(domain, resolvers)
            else fake.tunnelDns.delete(domain)
          }
          return { resolvers }
        })
      ),
  }
})

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"s".repeat(32)}`)

const networkId = "a".repeat(12)
const relayId = "b".repeat(12)
const gatewayId = "c".repeat(12)
const domain = "private.test"
const hostname = "private-network"
const stack = `${relayId}/${gatewayId}`

const networkRows = selectRows<{ cleanup_last_error: string | null }>("tunnel")
const deploymentRows = selectRows<{
  cleanup_attempts: number
  cleanup_last_error: string | null
}>("tunnel_gateway")

// A Tailscale-integrated network deployed on one Relay, with deletion
// requested.
const seedNetworkBeingDeleted = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertRelay(relayId, { name: "Relay One" })
  yield* createTunnelDefinitionEffect(
    {
      brickSource: null,
      domains: [domain],
      id: networkId,
      name: "Private Network",
    },
    { clientId: "tailscale-client", scopes: [], tags: ["tag:kiln"] },
    fake.tunnelSecret,
    "user-one"
  )
  yield* requestTunnelCleanupEffect(networkId, "user-one", [deployment()])

  fake.relayStacks.clear()
  fake.relayStacks.add(stack)
  fake.tunnelDown = false
  fake.tunnelDevices.clear()
  fake.tunnelDevices.add(hostname)
  fake.tunnelDns.clear()
  fake.tunnelDns.set(domain, ["100.64.0.10"])
})

afterAll(() => disposeAppRuntime())

const Cleanup = testOperationsEngine(deleteTunnel.layer).pipe(
  Layer.provideMerge(TestDatabase)
)

const until = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  done: (value: A) => boolean
) =>
  effect.pipe(
    Effect.repeat({ schedule: Schedule.spaced("50 millis"), until: done }),
    Effect.timeout("20 seconds")
  )

describeMysql("tunnel deletion", () => {
  // Live clock: retries wait real time, and the engine keeps it.
  layer(Cleanup, { excludeTestServices: true })((it) => {
    it.effect(
      "keeps the cleanup queued while Tailscale fails, then finishes on retry",
      () =>
        Effect.gen(function* () {
          yield* seedNetworkBeingDeleted
          fake.tunnelDown = true

          const id = yield* startTunnelDeletion(networkId, "user-one")
          const [queued] = yield* until(
            deploymentRows,
            ([row]) => row?.cleanup_attempts === 1
          )

          assert.isTrue(fake.relayStacks.has(stack))
          assert.isNotNull(queued?.cleanup_last_error)
          const [network] = yield* networkRows
          assert.isNotNull(network?.cleanup_last_error)
          assert.strictEqual((yield* loadOperation(id))?.state, "running")

          // The first retry is due two seconds later.
          fake.tunnelDown = false
          yield* until(loadOperation(id), (op) => op?.state === "succeeded")

          assert.isFalse(fake.relayStacks.has(stack))
          assert.isFalse(fake.tunnelDevices.has(hostname))
          assert.isFalse(fake.tunnelDns.has(domain))
          assert.deepStrictEqual(yield* deploymentRows, [])
          assert.deepStrictEqual(yield* networkRows, [])
        })
    )
  })
})

function deployment(): PersistedGateway {
  const parsed = tunnelSchema.parse({
    bindings: [],
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
    domains: [domain],
    hostname,
    id: gatewayId,
    name: "Private Network",
    observedState: "running",
    status: {
      connected: true,
      ipv4Address: null,
      ipv6Address: null,
      message: null,
    },
    subnet: "10.165.55.0/24",
    tailnetId: networkId,
  })
  return { ...parsed, relayId, relayName: "Relay One" }
}
