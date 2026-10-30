import { Effect } from "effect"
import { describe, expect, it } from "vite-plus/test"

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
        memberId: "relay-a",
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
      { enabled: true, hostname: `new-${relayId}`, memberId: relayId },
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
        memberId: relayId,
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
