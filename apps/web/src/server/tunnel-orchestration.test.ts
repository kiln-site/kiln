import { Effect } from "effect"
import { describe, expect, it } from "vite-plus/test"

import {
  applyGatewayPlanEffect,
  type DesiredGateway,
  type GatewayPlanState,
} from "./tunnel-orchestration"

interface TestDeployment extends GatewayPlanState {
  revision: string
}

const applyTailscaleDeploymentPlan = <TDeployment extends GatewayPlanState>(
  input: Parameters<typeof applyGatewayPlanEffect<TDeployment>>[0]
) => Effect.runPromise(applyGatewayPlanEffect(input))

// Kiln's Tailscale Brick, which a new gateway is made from.
const tailscaleBrick = {
  definition: {
    deploy: { image: "tailscale/tailscale:stable", type: "image" as const },
    format: "kiln.brick/v2" as const,
    kind: "tunnel" as const,
    metadata: {
      author: "Kiln",
      id: "tailscale",
      name: "Tailscale",
      summary: "Reach what runs on a Relay by name.",
    },
    tunnel: { dns: { image: "coredns/coredns:1.14.7" } },
    type: "tailscale",
  },
  source: "https://bricks.example/bricks/tailscale.yml",
}

describe("Tailscale deployment orchestration", () => {
  it("rolls back a new node whose allocated subnet is already reserved", async () => {
    const removed: Array<string> = []
    const colliding = deployment("relay-a", "installed")

    await expect(
      applyTailscaleDeploymentPlan({
        authKeyForTarget: async () => "test-auth-key",
        brick: tailscaleBrick,
        current: [],
        desired: [target("relay-a")],
        domains: ["test"],
        id: "a".repeat(12),
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
        domains: ["test"],
        id: "a".repeat(12),
        name: "Test network",
        operations: {
          apply: async (desired, input) => {
            // The member it holds stands for what it was given.
            held.set(desired.relayId, input.bindings[0]?.memberId ?? "")
            if (input.bindings[0]?.memberId === "old") {
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

function target(relayId: string): DesiredGateway {
  return {
    bindings: [{ enabled: true, memberId: `new-${relayId}` }],
    hostname: `network-${relayId}`,
    id: gatewayId(relayId),
    relayId,
    relayName: relayId,
  }
}

// Each Relay's gateway has an ID of its own.
function gatewayId(relayId: string): string {
  return relayId.at(-1)!.repeat(12)
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
        memberId: revision === "old" ? "old" : `new-${relayId}`,
      },
    ],
    domains: ["test"],
    hostname: `network-${relayId}`,
    id: gatewayId(relayId),
    name: "Test network",
    relayId,
    relayName: relayId,
    revision,
    subnet: `10.128.${relayId.at(-1)?.charCodeAt(0) ?? 0}.0/24`,
    tailnetId: "f".repeat(12),
  }
}
