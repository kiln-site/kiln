import { assert, layer } from "@effect/vitest"
import { Effect, Layer, Schedule } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { relayTailscaleStackSchema } from "@workspace/contracts"

import {
  recordTailscaleCleanupFinalizationFailureEffect,
  requestTailscaleNetworkCleanupEffect,
  type PersistedTailscaleDeployment,
} from "@/effect/tailscale-cleanup"
import {
  createTailscaleNetworkDefinitionEffect,
  saveTailscaleNetworkDefinitionEffect,
} from "@/effect/tailscale-networks"
import {
  subscribeRealtimeChanges,
  type RealtimeSourceEvent,
} from "@/lib/realtime-source.server"
import {
  deleteTailscaleNetwork,
  startTailscaleNetworkDeletion,
} from "@/lib/tailscale-cleanup.server"
import { disposeAppRuntime } from "@/effect/runtime"
import { loadOperation } from "@/operations/lanes"
import { testOperationsEngine } from "@/operations/test/engine"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertRows, selectRows } from "@/test/seed"

// The Relay and the Tailscale API are the only fakes: Relays holding
// Tailscale stacks as `<relay>/<stack>`, and a tailnet with device hostnames
// and split-DNS resolvers.
const fake = vi.hoisted(() => ({
  relayStacks: new Set<string>(),
  relayCommitFails: false,
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
      if (fake.relayCommitFails)
        throw new Error("Relay could not remove the stack")
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

  fake.relayCommitFails = false
  fake.relayStacks.clear()
  fake.relayStacks.add(stack)
  fake.tailnetDown = false
  fake.tailnetDevices.clear()
  fake.tailnetDevices.add(hostname)
  fake.tailnetDns.clear()
  fake.tailnetDns.set(domain, ["100.64.0.10"])
})

const assertFullyRemoved = Effect.gen(function* () {
  assert.isFalse(fake.relayStacks.has(stack))
  assert.isFalse(fake.tailnetDevices.has(hostname))
  assert.isFalse(fake.tailnetDns.has(domain))
  assert.deepStrictEqual(yield* deploymentRows, [])
  assert.deepStrictEqual(yield* networkRows, [])
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

// Deletes the network, as a request to delete it does, and waits for the
// operation to end.
const deleteNetwork = Effect.gen(function* () {
  const id = yield* startTailscaleNetworkDeletion(networkId, "user-one")
  return yield* until(loadOperation(id), (op) => op?.state === "succeeded")
})

describeMysql("Tailscale network deletion", () => {
  // Live clock: retries wait real time, and the engine keeps it.
  layer(Cleanup, { excludeTestServices: true, timeout: 60_000 })((it) => {
    it.effect(
      "removes the device, Relay stack, and network as soon as the last Relay is cleaned up",
      () =>
        Effect.gen(function* () {
          yield* seedNetworkBeingDeleted
          // An earlier failed attempt pushed the network's retry out an hour.
          yield* recordTailscaleCleanupFinalizationFailureEffect(
            networkId,
            3_600,
            "Tailscale timed out"
          )

          yield* deleteNetwork

          yield* assertFullyRemoved
        }),
      // The first to need the engine starts it.
      30_000
    )

    for (const failing of ["Tailscale", "the Relay"] as const) {
      it.effect(
        `keeps the cleanup queued while ${failing} fails, then finishes on retry`,
        () =>
          Effect.gen(function* () {
            yield* seedNetworkBeingDeleted
            if (failing === "Tailscale") fake.tailnetDown = true
            else fake.relayCommitFails = true

            const id = yield* startTailscaleNetworkDeletion(
              networkId,
              "user-one"
            )
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
            fake.relayCommitFails = false
            yield* until(loadOperation(id), (op) => op?.state === "succeeded")

            yield* assertFullyRemoved
          }),
        30_000
      )
    }

    it.effect(
      "finishes deleting a network with no Relays left once Tailscale answers",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* createTailscaleNetworkDefinitionEffect(
            { domain, id: networkId, name: "Private Network" },
            { clientId: "tailscale-client", scopes: [], tags: ["tag:kiln"] },
            fake.tailnetSecret,
            "user-one"
          )
          yield* requestTailscaleNetworkCleanupEffect(networkId, "user-one", [])
          fake.tailnetDown = true
          fake.tailnetDns.clear()
          fake.tailnetDns.set(domain, ["100.64.0.10"])

          const id = yield* startTailscaleNetworkDeletion(networkId, "user-one")
          yield* until(networkRows, ([row]) => row?.cleanup_last_error !== null)

          assert.lengthOf(yield* networkRows, 1)
          assert.isTrue(fake.tailnetDns.has(domain))

          fake.tailnetDown = false
          yield* until(loadOperation(id), (op) => op?.state === "succeeded")

          assert.isFalse(fake.tailnetDns.has(domain))
          assert.deepStrictEqual(yield* networkRows, [])
        }),
      30_000
    )

    it.effect(
      "tells admins to refresh when every due cleanup row is corrupt",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* saveTailscaleNetworkDefinitionEffect(
            {
              cleanup: null,
              domain,
              id: networkId,
              integration: null,
              name: "Private Network",
            },
            "user-one"
          )
          yield* requestTailscaleNetworkCleanupEffect(networkId, "user-one", [])
          yield* insertRows("tailscale_network_deployment", {
            network_id: networkId,
            relay_id: relayId,
            deployment: JSON.stringify({ not: "a deployment" }),
            cleanup_next_attempt_at: Date.now() - 1_000,
            observed_at: Date.now() - 60_000,
            updated_at: Date.now() - 60_000,
          })
          const events: Array<RealtimeSourceEvent> = []
          const unsubscribe = subscribeRealtimeChanges((event) => {
            events.push(event)
          })

          yield* startTailscaleNetworkDeletion(networkId, "user-one")
          yield* until(
            Effect.sync(() =>
              events.some(
                (event) =>
                  event.type === "hearth.invalidate" &&
                  event.topics.includes("tailscale")
              )
            ),
            (told) => told
          ).pipe(Effect.ensuring(Effect.sync(unsubscribe)))

          const [corrupt] = yield* deploymentRows
          assert.include(String(corrupt?.cleanup_last_error), "invalid")
          assert.lengthOf(yield* networkRows, 1)
        })
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
