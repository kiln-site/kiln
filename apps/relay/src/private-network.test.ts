import { describe, expect, it } from "vite-plus/test"

import {
  tailscaleCoreDnsConfiguration,
  tailscaleStackCoreDnsConfiguration,
  tailscaleStackCoreDnsRecords,
} from "./private-network.js"

/** The hostname regex CoreDNS will apply, taken from a rendered Corefile. */
function matcher(corefile: string): RegExp {
  const expression = /match "([^"]+)"/u.exec(corefile)?.[1] ?? ""
  return new RegExp(expression.replace(/^\(\?i\)/u, ""), "iu")
}

describe("CoreDNS zones", () => {
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
})
