import { Deferred, Effect, Exit, Fiber } from "effect"
import { expect, it, onTestFinished, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import type { RelayStoredWebRoute } from "./effect/state.js"
import { exclusive, laneKeys } from "./operation-lanes.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness } from "./test/relay.js"

const serverId = "a".repeat(40)
const route: RelayStoredWebRoute = {
  hostname: "map.example.com",
  id: "b00d4423",
  instanceId: serverId,
  name: "Live Map",
  path: null,
  stripPrefix: false,
  httpsRedirect: true,
  primary: false,
  redirect: null,
  www: "none",
  targetPort: 8080,
}

// A Relay behind Coolify's Traefik, serving one route to a game server.
async function coolifyRelay() {
  const harness = await relayHarness()
  onTestFinished(() => fakeDocker.reset())
  const server = await harness.seedServer({ id: serverId })
  fakeDocker.addNetwork({ name: "coolify" })
  fakeDocker.addContainer({
    image: "traefik:v3.1",
    name: "coolify-proxy",
    networks: ["coolify"],
    running: true,
  })
  // Before the proxy is set, so its upkeep's timer is one the test drives.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  onTestFinished(() => {
    vi.useRealTimers()
  })
  await harness.lifecycle.configureProxy(
    { acmeEmail: null, mode: "coolify", traefikImage: "traefik:v3.1" },
    [route]
  )
  const edge = harness.resources.edgeNetwork
  expect(server.networks.has(edge)).toBe(true)
  return {
    harness,
    // What the Relay's upkeep repairs: the game server off the edge network.
    drift: () => server.networks.delete(edge),
    routed: () => server.networks.has(edge),
  }
}

it("leaves Coolify's routing alone while the Relay is paused, and repairs it once resumed", async () => {
  const relay = await coolifyRelay()
  relay.harness.lanes.setPaused(true)
  relay.drift()

  await vi.advanceTimersByTimeAsync(30_000)
  expect(relay.routed()).toBe(false)

  relay.harness.lanes.setPaused(false)
  await vi.advanceTimersByTimeAsync(30_000)
  await vi.waitFor(() => expect(relay.routed()).toBe(true))
})

it("skips Coolify's upkeep while a route change holds the routes", async () => {
  const relay = await coolifyRelay()
  const changed = Deferred.makeUnsafe<void>()
  const change = Effect.runFork(
    relay.harness.lanes.run(
      { label: "instance.routes.write", locks: [exclusive(laneKeys.routes)] },
      Deferred.await(changed)
    )
  )
  relay.drift()

  await vi.advanceTimersByTimeAsync(30_000)
  expect(relay.routed()).toBe(false)

  Deferred.doneUnsafe(changed, Exit.void)
  await Effect.runPromise(Fiber.join(change))
  await vi.advanceTimersByTimeAsync(30_000)
  await vi.waitFor(() => expect(relay.routed()).toBe(true))
})
