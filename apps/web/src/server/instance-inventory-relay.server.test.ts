import { Effect } from "effect"
import type { InstanceInventoryRequest } from "@workspace/contracts"
import { expect, it, vi } from "vite-plus/test"

// The Relay connection is the boundary; this Relay predates scoped views.
const relay = vi.hoisted(() => ({ response: [] as Array<unknown> }))
vi.mock("@/lib/relay-connection", () => ({
  isRelayUpdating: () => false,
  relayConnectionInstances: () => [],
  relayConnectionState: () => ({ status: "authenticated" }),
  relayRpc: async () => relay.response,
}))

import type { PersistedRelay } from "@/lib/relay-registry"
import {
  InstanceInventorySource,
  InstanceInventorySourceLive,
} from "@/server/instance-inventory.server"

const relayId = "r".repeat(43)
const app = (id: string) => ({
  connectedDatabaseIds: [],
  containers: [],
  dataDirectory: `/apps/${id}`,
  deployment: null,
  hostname: `app-${id.slice(0, 8)}`,
  id,
  network: `app-${id}`,
  observedState: "running",
  shortId: id.slice(0, 8),
  status: "Running",
})

it("projects an older Relay's full app list onto the requested views", async () => {
  const requested = "a".repeat(40)
  const absent = "c".repeat(40)
  relay.response = [app(requested), app("b".repeat(40))]
  const requests = (
    [
      [requested, "status"],
      [requested, "table"],
      [requested, "detail"],
      [absent, "status"],
    ] as const
  ).map(([id, view]): InstanceInventoryRequest => ({
    reference: { kind: "app", relayId, id },
    view,
  }))
  const results = await Effect.runPromise(
    Effect.gen(function* () {
      const source = yield* InstanceInventorySource
      return yield* source.read(
        { id: relayId, enabled: true } as PersistedRelay,
        requests
      )
    }).pipe(Effect.provide(InstanceInventorySourceLive))
  )
  const values = results.map((result) =>
    "value" in result ? result.value : result
  )
  expect(values).toMatchObject([
    {
      view: "status",
      observation: { runtime: "running", inventory: "available" },
    },
    {
      view: "table",
      data: { containerCount: 0, runningContainerCount: 0, deploying: false },
    },
    { view: "detail", data: { id: requested, hostname: "app-aaaaaaaa" } },
    { view: "status", observation: { runtime: null, inventory: "missing" } },
  ])
})
