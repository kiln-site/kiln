import { assert, layer } from "@effect/vitest"
import { Effect, Layer, Schedule } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { relayTailscaleStackSchema } from "@workspace/contracts"

import {
  requestTailscaleNetworkCleanupEffect,
  type PersistedTailscaleDeployment,
} from "@/effect/tailscale-cleanup"
import { createTailscaleNetworkDefinitionEffect } from "@/effect/tailscale-networks"
import {
  deleteTailscaleNetwork,
  startTailscaleNetworkDeletion,
} from "@/lib/tailscale-cleanup.server"
import { disposeAppRuntime } from "@/effect/runtime"
import { loadOperation } from "@/operations/records"
import { testOperationsEngine } from "@/operations/test/engine"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, selectRows } from "@/test/seed"

// The Relay and the Tailscale API are the only fakes: Relays holding
// Tailscale stacks as `<relay>/<stack>`, and a tailnet with device hostnames
// and split-DNS resolvers.
const fake = vi.hoisted(() => ({
  relayStacks: new Set<string>(),
  tailnetDevices: new Set<string>(),
  tailnetDns: new Map<string, ReadonlyArray<string>>(),
  tailnetDown: false,
  tailnetSecret: "tailscale-client-secret",
}))

vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (
    relay: { id: string },
    operation: string,
    payload: unknown
  ) => {
    if (operation !== "relay.tailscale.stack.remove") {
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
  const tailnet = (credential: {
    clientSecret: string
  }): import("effect").Effect.Effect<void, Error> =>
    fake.tailnetDown || credential.clientSecret !== fake.tailnetSecret
      ? Effect.fail(new Error("Tailscale returned HTTP 503"))
      : Effect.void
  return {
    ...(await importOriginal<typeof import("@/effect/tailscale-api")>()),
    removeTailscaleControlPlaneDeviceEffect: (
      credential: { clientSecret: string },
      deployment: { hostname: string }
    ) =>
      tailnet(credential).pipe(
        Effect.andThen(
          Effect.sync(() => {
            fake.tailnetDevices.delete(deployment.hostname)
          })
        )
      ),
    syncTailscaleControlPlaneEffect: (
      credential: { clientSecret: string },
      network: {
        deployments: ReadonlyArray<{ status: { ipv4Address: string | null } }>
        domain: string
      }
    ) =>
      tailnet(credential).pipe(
        Effect.map(() => {
          const resolvers = network.deployments.flatMap(({ status }) =>
            status.ipv4Address ? [status.ipv4Address] : []
          )
          if (resolvers.length > 0)
            fake.tailnetDns.set(network.domain, resolvers)
          else fake.tailnetDns.delete(network.domain)
          return { resolvers }
        })
      ),
  }
})

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"s".repeat(32)}`)

const networkId = "a".repeat(40)
const relayId = "b".repeat(43)
const domain = "private.test"
const hostname = "private-network"
const stack = `${relayId}/${networkId}`

const networkRows = selectRows<{ cleanup_last_error: string | null }>(
  "tailscale_network"
)
const deploymentRows = selectRows<{
  cleanup_attempts: number
  cleanup_last_error: string | null
}>("tailscale_network_deployment")

// A Tailscale-integrated network deployed on one Relay, with deletion
// requested.
const seedNetworkBeingDeleted = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertRelay(relayId, { name: "Relay One" })
  yield* createTailscaleNetworkDefinitionEffect(
    { domain, id: networkId, name: "Private Network" },
    { clientId: "tailscale-client", scopes: [], tags: ["tag:kiln"] },
    fake.tailnetSecret,
    "user-one"
  )
  yield* requestTailscaleNetworkCleanupEffect(networkId, "user-one", [
    deployment(),
  ])

  fake.relayStacks.clear()
  fake.relayStacks.add(stack)
  fake.tailnetDown = false
  fake.tailnetDevices.clear()
  fake.tailnetDevices.add(hostname)
  fake.tailnetDns.clear()
  fake.tailnetDns.set(domain, ["100.64.0.10"])
})

afterAll(() => disposeAppRuntime())

const Cleanup = testOperationsEngine(deleteTailscaleNetwork.layer).pipe(
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

describeMysql("Tailscale network deletion", () => {
  // Live clock: retries wait real time, and the engine keeps it.
  layer(Cleanup, { excludeTestServices: true, timeout: 60_000 })((it) => {
    it.effect(
      "keeps the cleanup queued while Tailscale fails, then finishes on retry",
      () =>
        Effect.gen(function* () {
          yield* seedNetworkBeingDeleted
          fake.tailnetDown = true

          const id = yield* startTailscaleNetworkDeletion(networkId, "user-one")
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
          fake.tailnetDown = false
          yield* until(loadOperation(id), (op) => op?.state === "succeeded")

          assert.isFalse(fake.relayStacks.has(stack))
          assert.isFalse(fake.tailnetDevices.has(hostname))
          assert.isFalse(fake.tailnetDns.has(domain))
          assert.deepStrictEqual(yield* deploymentRows, [])
          assert.deepStrictEqual(yield* networkRows, [])
        }),
      30_000
    )
  })
})

function deployment(): PersistedTailscaleDeployment {
  const parsed = relayTailscaleStackSchema.parse({
    bindings: [],
    components: { coreDnsRunning: true, tailscaleRunning: true },
    domain,
    hostname,
    id: networkId,
    instance: {
      brickId: "tailscale",
      connectAddress: `${hostname}.${domain}`,
      containerId: "docker-container-id",
      desiredState: "running",
      directory: networkId,
      game: "Networking",
      id: networkId,
      implementation: "Tailscale",
      javaVersion: "Tailscale + CoreDNS",
      managedByRelay: true,
      name: "Private Network",
      observedState: "running",
      service: "kiln-ts-aaaaaaaa",
      shortId: networkId.slice(0, 8),
      status: "Up",
      version: "stable",
    },
    name: "Private Network",
    status: {
      connected: true,
      ipv4Address: null,
      ipv6Address: null,
      message: null,
    },
    subnet: "10.165.55.0/24",
  })
  return { ...parsed, relayId, relayName: "Relay One" }
}
