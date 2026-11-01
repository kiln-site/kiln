import { Effect } from "effect"
import { describe, expect, it } from "vite-plus/test"

import {
  applyTailscaleDeploymentPlanEffect,
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
          rewriteDns: async () => undefined,
        },
        reservedSubnets: new Set([colliding.subnet]),
      })
    ).rejects.toThrow("already assigned")

    expect(removed).toEqual(["relay-a"])
  })

  it("restores every node after a DNS rewrite failure, then rewrites DNS from what they hold", async () => {
    const restored: Array<string> = []
    // What each node holds, and the DNS last written from it.
    const held = new Map<string, string>()
    let dns: Record<string, string> | null = null
    let failed = false
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
            held.set(desired.relayId, input.bindings[0]?.hostname ?? "")
            if (input.bindings[0]?.hostname === "old") {
              restored.push(desired.relayId)
              return deployment(desired.relayId, "old")
            }
            return deployment(desired.relayId, "changed")
          },
          remove: async () => undefined,
          rewriteDns: async () => {
            if (!failed) {
              failed = true
              throw new Error("DNS failed")
            }
            dns = Object.fromEntries(held)
          },
        },
      })
    ).rejects.toThrow("DNS failed")

    expect(restored.sort()).toEqual(["relay-a", "relay-b"])
    expect(dns).toEqual({ "relay-a": "old", "relay-b": "old" })
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
