import { assert, it as effectIt } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect, it } from "vite-plus/test"

import { TailscaleOrchestrationError } from "@/effect/errors"

import {
  applyTailscaleDeploymentPlanEffect,
  synchronizeInstanceDeletionDnsEffect,
  type DesiredTailscaleDeployment,
  type TailscaleDeploymentState,
} from "./tailscale-orchestration"

interface TestDeployment extends TailscaleDeploymentState {
  revision: string
}

const applyTailscaleDeploymentPlan = <
  TDeployment extends TailscaleDeploymentState,
>(
  input: Parameters<typeof applyTailscaleDeploymentPlanEffect<TDeployment>>[0]
) => Effect.runPromise(applyTailscaleDeploymentPlanEffect(input))

const synchronizeInstanceDeletionDns = <
  TDeployment extends TailscaleDeploymentState,
>(
  input: Parameters<typeof synchronizeInstanceDeletionDnsEffect<TDeployment>>[0]
) => Effect.runPromise(synchronizeInstanceDeletionDnsEffect(input))

describe("Tailscale deployment orchestration", () => {
  effectIt.effect("keeps validation failures in the typed error channel", () =>
    Effect.gen(function* () {
      const failure = yield* applyTailscaleDeploymentPlanEffect({
        authKey: "one-off-key",
        current: [],
        desired: [target("relay-a"), target("relay-b")],
        domain: "test",
        id: "a".repeat(40),
        name: "Test network",
        operations: {
          apply: async (desired) => deployment(desired.relayId, "applied"),
          remove: async () => undefined,
          syncDns: async (value) => value,
        },
      }).pipe(Effect.flip)

      assert.instanceOf(failure, TailscaleOrchestrationError)
      assert.strictEqual(failure.phase, "validation")
      assert.include(failure.message, "one new Relay at a time")
    })
  )

  it("applies nodes sequentially and sends the auth key only to new nodes", async () => {
    const calls: Array<{ authKey?: string; relayId: string }> = []
    let active = 0
    let maximumActive = 0
    const current = [deployment("relay-a", "old")]

    const result = await applyTailscaleDeploymentPlan({
      authKey: "test-auth-key",
      current,
      desired: [target("relay-a"), target("relay-b")],
      domain: "test",
      id: "a".repeat(40),
      name: "Test network",
      operations: {
        apply: async (desired, input) => {
          active += 1
          maximumActive = Math.max(maximumActive, active)
          await Promise.resolve()
          calls.push({ authKey: input.authKey, relayId: desired.relayId })
          active -= 1
          return deployment(desired.relayId, "applied")
        },
        remove: async () => undefined,
        syncDns: async (value) => value,
      },
    })

    expect(maximumActive).toBe(1)
    expect(calls).toEqual([
      { authKey: undefined, relayId: "relay-a" },
      { authKey: "test-auth-key", relayId: "relay-b" },
    ])
    expect(result.map(({ relayId }) => relayId)).toEqual(["relay-a", "relay-b"])
  })

  it("creates a separate auth key for each new node", async () => {
    const created: Array<string> = []
    const applied: Array<{ authKey?: string; relayId: string }> = []

    await applyTailscaleDeploymentPlan({
      authKeyForTarget: async (desired) => {
        created.push(desired.relayId)
        return `key-${desired.relayId}`
      },
      current: [deployment("relay-a", "old")],
      desired: [target("relay-a"), target("relay-b"), target("relay-c")],
      domain: "test",
      id: "a".repeat(40),
      name: "Test network",
      operations: {
        apply: async (desired, input) => {
          applied.push({
            authKey: input.authKey,
            relayId: desired.relayId,
          })
          return deployment(desired.relayId, "applied")
        },
        remove: async () => undefined,
        syncDns: async (value) => value,
      },
    })

    expect(created).toEqual(["relay-b", "relay-c"])
    expect(applied).toEqual([
      { authKey: undefined, relayId: "relay-a" },
      { authKey: "key-relay-b", relayId: "relay-b" },
      { authKey: "key-relay-c", relayId: "relay-c" },
    ])
  })

  it("rejects a manual auth key before applying more than one new node", async () => {
    const applied: Array<string> = []

    await expect(
      applyTailscaleDeploymentPlan({
        authKey: "one-off-key",
        current: [],
        desired: [target("relay-a"), target("relay-b")],
        domain: "test",
        id: "a".repeat(40),
        name: "Test network",
        operations: {
          apply: async (desired) => {
            applied.push(desired.relayId)
            return deployment(desired.relayId, "applied")
          },
          remove: async () => undefined,
          syncDns: async (value) => value,
        },
      })
    ).rejects.toThrow("one new Relay at a time")

    expect(applied).toEqual([])
  })

  it("rolls back a new node whose allocated subnet is already reserved", async () => {
    const removed: Array<string> = []
    const colliding = deployment("relay-a", "installed")

    await expect(
      applyTailscaleDeploymentPlan({
        authKey: "test-auth-key",
        current: [],
        desired: [target("relay-a")],
        domain: "test",
        id: "a".repeat(40),
        name: "Test network",
        operations: {
          apply: async () => colliding,
          remove: async (value, mode) => {
            if (mode === "commit") removed.push(value.relayId)
          },
          syncDns: async (value) => value,
        },
        reservedSubnets: new Set([colliding.subnet]),
      })
    ).rejects.toThrow("already assigned")

    expect(removed).toEqual(["relay-a"])
  })

  it("restores changed nodes when a later node apply fails", async () => {
    const applyRevisions: Array<string> = []
    const synchronized: Array<string> = []
    const current = [deployment("relay-a", "old")]

    await expect(
      applyTailscaleDeploymentPlan({
        authKey: "test-auth-key",
        current,
        desired: [target("relay-a"), target("relay-b")],
        domain: "test",
        id: "a".repeat(40),
        name: "Test network",
        operations: {
          apply: async (desired, input) => {
            if (desired.relayId === "relay-b") throw new Error("join failed")
            const revision =
              input.bindings[0]?.hostname === "old" ? "restored" : "changed"
            applyRevisions.push(revision)
            return deployment(desired.relayId, revision)
          },
          remove: async () => undefined,
          syncDns: async (value) => {
            synchronized.push(value.relayId)
            return value
          },
        },
      })
    ).rejects.toThrow("join failed")

    expect(applyRevisions).toEqual(["changed", "restored"])
    expect(synchronized).toEqual(["relay-a"])
  })

  it("removes a newly installed node when a later apply fails", async () => {
    const removed: Array<string> = []

    await expect(
      applyTailscaleDeploymentPlan({
        authKeyForTarget: async (desired) => `key-${desired.relayId}`,
        current: [],
        desired: [target("relay-a"), target("relay-b")],
        domain: "test",
        id: "a".repeat(40),
        name: "Test network",
        operations: {
          apply: async (desired) => {
            if (desired.relayId === "relay-b") throw new Error("join failed")
            return deployment(desired.relayId, "installed")
          },
          remove: async (value, mode) => {
            if (mode === "commit") removed.push(value.relayId)
          },
          syncDns: async (value) => value,
        },
      })
    ).rejects.toThrow("join failed")

    expect(removed).toEqual(["relay-a"])
  })

  it("restores every node after a DNS synchronization failure", async () => {
    const restored: Array<string> = []
    const current = [deployment("relay-a", "old"), deployment("relay-b", "old")]

    await expect(
      applyTailscaleDeploymentPlan({
        current,
        desired: [target("relay-a"), target("relay-b")],
        domain: "test",
        id: "a".repeat(40),
        name: "Test network",
        operations: {
          apply: async (desired, input) => {
            if (input.bindings[0]?.hostname === "old") {
              restored.push(desired.relayId)
              return deployment(desired.relayId, "old")
            }
            return deployment(desired.relayId, "changed")
          },
          remove: async () => undefined,
          syncDns: async (value) => {
            if (value.revision === "changed" && value.relayId === "relay-b") {
              throw new Error("DNS failed")
            }
            return value
          },
        },
      })
    ).rejects.toThrow("DNS failed")

    expect(restored.sort()).toEqual(["relay-a", "relay-b"])
  })

  it("restores retained nodes when removing a leaving node fails", async () => {
    const applyRevisions: Array<string> = []
    const removed: Array<string> = []
    const synchronized: Array<string> = []
    const current = [deployment("relay-a", "old"), deployment("relay-b", "old")]

    await expect(
      applyTailscaleDeploymentPlan({
        current,
        desired: [target("relay-a")],
        domain: "test",
        id: "a".repeat(40),
        name: "Test network",
        operations: {
          apply: async (desired, input) => {
            const revision =
              input.bindings[0]?.hostname === "old" ? "restored" : "changed"
            applyRevisions.push(revision)
            return deployment(desired.relayId, revision)
          },
          remove: async (value, mode) => {
            removed.push(`${value.relayId}:${mode}`)
            if (mode === "prepare") throw new Error("remove failed")
          },
          syncDns: async (value) => {
            synchronized.push(`${value.relayId}:${value.revision}`)
            return value
          },
        },
      })
    ).rejects.toThrow("remove failed")

    expect(applyRevisions).toEqual(["changed", "restored"])
    expect(removed).toEqual(["relay-b:prepare", "relay-b:rollback"])
    expect(synchronized).toEqual([
      "relay-a:changed",
      "relay-a:old",
      "relay-b:old",
    ])
  })

  it("removes every current node when the desired network is empty", async () => {
    const removed: Array<string> = []
    const current = [deployment("relay-a", "old"), deployment("relay-b", "old")]

    const result = await applyTailscaleDeploymentPlan({
      current,
      desired: [],
      domain: "test",
      id: "a".repeat(40),
      name: "Test network",
      operations: {
        apply: async (desired) => deployment(desired.relayId, "changed"),
        remove: async (value, mode) => {
          removed.push(`${value.relayId}:${mode}`)
        },
        syncDns: async (value) => value,
      },
    })

    expect(result).toEqual([])
    expect(removed).toEqual([
      "relay-a:prepare",
      "relay-b:prepare",
      "relay-a:commit",
      "relay-b:commit",
    ])
  })

  it("retries a transient removal commit before reporting success", async () => {
    const removals: Array<string> = []
    let commitAttempts = 0
    const current = [deployment("relay-a", "old")]

    const result = await applyTailscaleDeploymentPlan({
      current,
      desired: [],
      domain: "test",
      id: "a".repeat(40),
      name: "Test network",
      operations: {
        apply: async (desired) => deployment(desired.relayId, "changed"),
        remove: async (value, mode) => {
          removals.push(`${value.relayId}:${mode}`)
          if (mode === "commit" && commitAttempts++ < 2) {
            throw new Error("temporary cleanup failure")
          }
        },
        syncDns: async (value) => value,
      },
    })

    expect(result).toEqual([])
    expect(removals).toEqual([
      "relay-a:prepare",
      "relay-a:commit",
      "relay-a:commit",
      "relay-a:commit",
    ])
  })

  it("reports a final removal failure without rolling back durable state", async () => {
    const removals: Array<string> = []
    const current = [deployment("relay-a", "old")]

    await expect(
      applyTailscaleDeploymentPlan({
        current,
        desired: [],
        domain: "test",
        id: "a".repeat(40),
        name: "Test network",
        operations: {
          apply: async (desired) => deployment(desired.relayId, "changed"),
          remove: async (value, mode) => {
            removals.push(`${value.relayId}:${mode}`)
            if (mode === "commit") throw new Error("cleanup unavailable")
          },
          syncDns: async (value) => value,
        },
      })
    ).rejects.toThrow("Relay cleanup failed after 3 attempts")

    expect(removals).toEqual([
      "relay-a:prepare",
      "relay-a:commit",
      "relay-a:commit",
      "relay-a:commit",
    ])
  })

  it("restores earlier removals when a later removal cannot be prepared", async () => {
    const removals: Array<string> = []
    const current = [deployment("relay-a", "old"), deployment("relay-b", "old")]

    await expect(
      applyTailscaleDeploymentPlan({
        current,
        desired: [],
        domain: "test",
        id: "a".repeat(40),
        name: "Test network",
        operations: {
          apply: async (desired) => deployment(desired.relayId, "changed"),
          remove: async (value, mode) => {
            removals.push(`${value.relayId}:${mode}`)
            if (value.relayId === "relay-b" && mode === "prepare") {
              throw new Error("second removal failed")
            }
          },
          syncDns: async (value) => value,
        },
      })
    ).rejects.toThrow("second removal failed")

    expect(removals).toEqual([
      "relay-a:prepare",
      "relay-b:prepare",
      "relay-b:rollback",
      "relay-a:rollback",
    ])
  })

  it("restores replicated DNS when finalizing a whole-network removal fails", async () => {
    const synchronized = new Map<string, Array<string>>()
    const current = [
      deployment("relay-a", "old", "10.165.55.10"),
      deployment("relay-b", "old", "10.165.55.11"),
    ]

    await expect(
      applyTailscaleDeploymentPlan({
        current,
        desired: [],
        domain: "test",
        id: "a".repeat(40),
        name: "Test network",
        operations: {
          apply: async (desired) => deployment(desired.relayId, "changed"),
          remove: async () => undefined,
          syncDns: async (value, records) => {
            synchronized.set(
              value.relayId,
              records.map(({ address }) => address)
            )
            return value
          },
        },
        beforeFinalize: async () => {
          throw new Error("control-plane cleanup failed")
        },
      })
    ).rejects.toThrow("control-plane cleanup failed")

    expect([...synchronized.entries()]).toEqual([
      ["relay-a", ["10.165.55.10", "10.165.55.11"]],
      ["relay-b", ["10.165.55.10", "10.165.55.11"]],
    ])
  })

  it("removes a deleted server from peer Relay DNS", async () => {
    const synchronized = new Map<
      string,
      Array<{ address: string; hostname: string }>
    >()
    const current = [
      deployment("relay-a", "old", "10.165.55.10"),
      deployment("relay-b", "old", "10.165.55.11"),
    ]

    await synchronizeInstanceDeletionDns({
      current,
      instanceId: "relay-a",
      mode: "prepare",
      operations: {
        syncDns: async (value, records) => {
          synchronized.set(value.relayId, records)
          return value
        },
      },
      relayId: "relay-a",
      stackIds: ["a".repeat(40)],
    })

    expect([...synchronized.entries()]).toEqual([
      ["relay-b", [{ address: "10.165.55.11", hostname: "old" }]],
    ])
  })

  it("restores peer DNS when preparing a server deletion fails", async () => {
    const calls: Array<{ addresses: Array<string>; relayId: string }> = []
    const current = [
      deployment("relay-a", "old", "10.165.55.10"),
      deployment("relay-b", "old", "10.165.55.11"),
      deployment("relay-c", "old", "10.165.55.12"),
    ]

    await expect(
      synchronizeInstanceDeletionDns({
        current,
        instanceId: "relay-a",
        mode: "prepare",
        operations: {
          syncDns: async (value, records) => {
            calls.push({
              addresses: records.map(({ address }) => address),
              relayId: value.relayId,
            })
            if (value.relayId === "relay-c") {
              throw new Error("peer unavailable")
            }
            return value
          },
        },
        relayId: "relay-a",
        stackIds: ["a".repeat(40)],
      })
    ).rejects.toThrow("peer unavailable")

    expect(calls).toEqual([
      {
        addresses: ["10.165.55.11", "10.165.55.12"],
        relayId: "relay-b",
      },
      {
        addresses: ["10.165.55.11", "10.165.55.12"],
        relayId: "relay-c",
      },
      {
        addresses: ["10.165.55.10", "10.165.55.11", "10.165.55.12"],
        relayId: "relay-b",
      },
    ])
  })

  it("restores peer DNS when a server deletion prepare is cancelled", async () => {
    const controller = new AbortController()
    const calls: Array<{ addresses: Array<string>; relayId: string }> = []
    const current = [
      deployment("relay-a", "old", "10.165.55.10"),
      deployment("relay-b", "old", "10.165.55.11"),
      deployment("relay-c", "old", "10.165.55.12"),
    ]

    await expect(
      synchronizeInstanceDeletionDns({
        current,
        instanceId: "relay-a",
        mode: "prepare",
        operations: {
          syncDns: async (value, records) => {
            calls.push({
              addresses: records.map(({ address }) => address),
              relayId: value.relayId,
            })
            if (calls.length === 1) controller.abort()
            return value
          },
        },
        relayId: "relay-a",
        signal: controller.signal,
        stackIds: ["a".repeat(40)],
      })
    ).rejects.toThrow("cancelled")

    expect(calls).toEqual([
      {
        addresses: ["10.165.55.11", "10.165.55.12"],
        relayId: "relay-b",
      },
      {
        addresses: ["10.165.55.10", "10.165.55.11", "10.165.55.12"],
        relayId: "relay-b",
      },
    ])
  })
})

function target(relayId: string): DesiredTailscaleDeployment {
  return {
    bindings: [
      { enabled: true, hostname: `new-${relayId}`, instanceId: relayId },
    ],
    hostname: `network-${relayId}`,
    relayId,
    relayName: relayId,
  }
}

function deployment(
  relayId: string,
  revision: string,
  address = "10.165.55.10"
): TestDeployment {
  return {
    bindings: [
      {
        address,
        enabled: true,
        hostname: revision === "old" ? "old" : `new-${relayId}`,
        instanceId: relayId,
      },
    ],
    domain: "test",
    hostname: `network-${relayId}`,
    id: "a".repeat(40),
    name: "Test network",
    relayId,
    relayName: relayId,
    revision,
    subnet: `10.128.${relayId.at(-1)?.charCodeAt(0) ?? 0}.0/24`,
  }
}
