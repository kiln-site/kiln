import {
  relayNetworkingSchema,
  relayTailscaleStackConfigSchema,
} from "@workspace/contracts"
import { describe, expect, it } from "vite-plus/test"

import {
  allocateTailscaleStackSubnet,
  assignTailscaleBindingAddresses,
  coreDnsConfiguration,
  tailscaleCoreDnsConfiguration,
  tailscaleStackCoreDnsConfiguration,
  tailscaleStackCoreDnsRecords,
  tailscaleStackWithoutInstance,
} from "./private-network.js"

/** The hostname regex CoreDNS will apply, taken from a rendered Corefile. */
function matcher(corefile: string): RegExp {
  const expression = /match "([^"]+)"/u.exec(corefile)?.[1] ?? ""
  return new RegExp(expression.replace(/^\(\?i\)/u, ""), "iu")
}

describe("CoreDNS zones", () => {
  const networking = relayNetworkingSchema.parse({
    address: "203.0.113.5",
    domain: "kiln.test",
    enabled: true,
  })

  it("answers only for deployed hostnames inside the zone", () => {
    const pattern = matcher(
      coreDnsConfiguration(networking, [
        "1.21.11.paper.kiln.test",
        "paper.kiln.test",
        "outside.example",
      ])
    )

    expect(pattern.test("1.21.11.paper.kiln.test.")).toBe(true)
    expect(pattern.test("PAPER.KILN.TEST.")).toBe(true)
    expect(pattern.test("1x21x11.paper.kiln.test.")).toBe(false)
    expect(pattern.test("kiln.test.")).toBe(false)
    expect(pattern.test("typo.kiln.test.")).toBe(false)
    expect(pattern.test("outside.example.")).toBe(false)
  })

  it("answers for nothing before the first server is deployed", () => {
    const pattern = matcher(coreDnsConfiguration(networking, []))

    expect(pattern.test("kiln.test.")).toBe(false)
    expect(pattern.test("anything.kiln.test.")).toBe(false)
  })

  it("binds the private Tailscale zone only to the node's Tailscale address", () => {
    const corefile = tailscaleCoreDnsConfiguration(
      { dnsPort: 53, domain: "test", hostname: "kiln-node" },
      "100.91.22.14",
      ["1.21.11.paper.test"]
    )

    expect(corefile).toMatch(/^\s*bind 100\.91\.22\.14$/mu)
    expect(matcher(corefile).test("1.21.11.paper.test.")).toBe(true)
  })
})

describe("Tailscale stack addressing", () => {
  it("probes to another deterministic subnet when the preferred one is reserved", () => {
    const stackId = "a".repeat(40)
    const preferred = allocateTailscaleStackSubnet(stackId, "node-a", new Set())
    const replacement = allocateTailscaleStackSubnet(
      stackId,
      "node-a",
      new Set([preferred])
    )

    expect(replacement).not.toBe(preferred)
    expect(
      allocateTailscaleStackSubnet(stackId, "node-a", new Set([preferred]))
    ).toBe(replacement)
  })

  it("reclaims removed addresses while replacing a full subnet in one apply", () => {
    const existing = Array.from({ length: 245 }, (_, index) => ({
      address: `10.165.55.${index + 10}`,
      hostname: `old-${index}`,
      instanceId: `old-${index}`,
    }))
    const desired = Array.from({ length: 245 }, (_, index) => ({
      hostname: `new-${index}`,
      instanceId: `new-${index}`,
    }))

    const assigned = assignTailscaleBindingAddresses(
      "10.165.55.0/24",
      existing,
      desired
    )

    expect(new Set(assigned.map(({ address }) => address)).size).toBe(245)
    expect(assigned[0]?.address).toBe("10.165.55.10")
    expect(assigned.at(-1)?.address).toBe("10.165.55.254")
  })

  it("keeps retained addresses reserved while reusing removed ones", () => {
    const assigned = assignTailscaleBindingAddresses(
      "10.165.55.0/24",
      [
        { address: "10.165.55.10", hostname: "removed", instanceId: "removed" },
        { address: "10.165.55.11", hostname: "retained", instanceId: "retained" },
      ],
      [
        { hostname: "replacement", instanceId: "replacement" },
        { enabled: false, hostname: "retained-new-name", instanceId: "retained" },
      ]
    )

    expect(assigned).toEqual([
      {
        address: "10.165.55.10",
        enabled: true,
        hostname: "replacement",
        instanceId: "replacement",
      },
      {
        address: "10.165.55.11",
        enabled: false,
        hostname: "retained-new-name",
        instanceId: "retained",
      },
    ])
  })
})

describe("Tailscale stack DNS records", () => {
  it("reads back the records it writes to the stack Corefile", () => {
    const records = [
      { address: "10.140.2.10", hostname: "survival" },
      { address: "10.165.55.10", hostname: "paper" },
    ]

    const corefile = tailscaleStackCoreDnsConfiguration("test", records)

    expect(tailscaleStackCoreDnsRecords("test", corefile)).toEqual([
      { address: "10.165.55.10", hostname: "paper" },
      { address: "10.140.2.10", hostname: "survival" },
    ])
  })

  it("removes a deleted server's binding and only its replicated record", () => {
    const removedId = "b".repeat(40)
    const retainedId = "c".repeat(40)
    const config = relayTailscaleStackConfigSchema.parse({
      bindings: [
        { address: "10.165.55.10", hostname: "paper", instanceId: removedId },
        { address: "10.165.55.11", hostname: "survival", instanceId: retainedId },
      ],
      domain: "test",
      hostname: "private-network",
      id: "a".repeat(40),
      name: "Private Network",
      subnet: "10.165.55.0/24",
    })

    const detached = tailscaleStackWithoutInstance(
      config,
      [
        { address: "10.165.55.10", hostname: "paper" },
        { address: "10.165.55.11", hostname: "survival" },
        { address: "10.140.2.10", hostname: "remote" },
      ],
      removedId
    )

    expect(detached.config.bindings.map(({ instanceId }) => instanceId)).toEqual([
      retainedId,
    ])
    expect(detached.records).toEqual([
      { address: "10.165.55.11", hostname: "survival" },
      { address: "10.140.2.10", hostname: "remote" },
    ])
  })
})
