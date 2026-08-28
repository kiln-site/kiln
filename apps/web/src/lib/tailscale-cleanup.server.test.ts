import { assert, beforeEach, describe, it } from "@effect/vitest"
import { vi } from "vite-plus/test"

const state = vi.hoisted(() => ({
  complete: false,
  events: [] as Array<string>,
  failCommit: false,
  removed: false,
}))

const networkId = "a".repeat(40)
const relayId = "b".repeat(43)

vi.mock("@/effect/tailscale-cleanup", async () => {
  const { Effect } = await import("effect")
  return {
    completeTailscaleCleanupEffect: () =>
      Effect.sync(() => {
        state.events.push("complete")
        state.complete = true
      }),
    deferTailscaleCleanupEffect: () =>
      Effect.sync(() => state.events.push("defer")),
    loadPendingTailscaleCleanupsEffect: () =>
      Effect.succeed(
        state.complete
          ? []
          : [
              {
                attempts: 0,
                deployment: {
                  id: networkId,
                  relayId,
                  relayName: "Relay One",
                },
                lastError: null,
                requestedBy: "user-one",
              },
            ]
      ),
    recordTailscaleCleanupFinalizationFailureEffect: () => Effect.void,
    tailscaleCleanupRetryDelaySeconds: () => 2,
  }
})

vi.mock("@/effect/tailscale-api", async () => {
  const { Effect } = await import("effect")
  return {
    removeTailscaleControlPlaneDeviceEffect: () => Effect.void,
    syncTailscaleControlPlaneEffect: () => Effect.void,
  }
})

vi.mock("@/effect/tailscale-networks", async () => {
  const { Effect } = await import("effect")
  return {
    loadTailscaleNetworkCredentialEffect: () => Effect.die("No credential"),
    loadTailscaleNetworkDefinitionsEffect: () =>
      Effect.succeed(
        state.removed
          ? []
          : [
              {
                cleanup: {
                  attempts: 0,
                  lastError: null,
                  nextAttemptAt: null,
                  pendingRelays: state.complete ? 0 : 1,
                  requestedAt: "2026-08-28T12:00:00.000Z",
                },
                domain: "test",
                id: networkId,
                integration: null,
                name: "Private Network",
              },
            ]
      ),
    removeTailscaleNetworkDefinitionEffect: () =>
      Effect.sync(() => {
        state.events.push("finalize")
        state.removed = true
      }),
  }
})

vi.mock("@/effect/runtime", async () => {
  const { Effect } = await import("effect")
  return {
    runAppEffect: (_operation: string, effect: unknown) =>
      Effect.runPromise(effect as never),
  }
})

vi.mock("@/lib/relay-client", async () => {
  const { Effect } = await import("effect")
  return {
    invalidateRelayCache: () =>
      Effect.sync(() => state.events.push("invalidate")),
    relayCachePolicy: { snapshot: (id: string) => id },
  }
})

vi.mock("@/lib/relay-connection", () => ({
  relayRpc: async (
    _relay: unknown,
    _method: string,
    input: { mode: "commit" | "prepare" }
  ) => {
    state.events.push(input.mode)
    if (input.mode === "commit" && state.failCommit) {
      throw new Error("Relay commit failed")
    }
  },
}))

vi.mock("@/lib/realtime-source.server", () => ({
  publishRealtimeChange: () => undefined,
}))

vi.mock("@/lib/relay-registry", () => ({
  listPersistedRelays: async () => [
    { enabled: true, id: relayId, name: "Relay One" },
  ],
}))

import { processTailscaleCleanupJobs } from "./tailscale-cleanup.server"

describe("Tailscale cleanup worker", () => {
  beforeEach(() => {
    state.complete = false
    state.events.length = 0
    state.failCommit = false
    state.removed = false
  })

  it("prepares and commits Relay cleanup before finalizing the network", async () => {
    await processTailscaleCleanupJobs()

    assert.deepEqual(state.events, [
      "prepare",
      "commit",
      "complete",
      "invalidate",
      "finalize",
    ])
  })

  it("defers a failed commit without completing the Relay cleanup", async () => {
    state.failCommit = true

    await processTailscaleCleanupJobs()

    assert.deepEqual(state.events, ["prepare", "commit", "defer"])
  })
})
