import { describe, expect, it } from "vite-plus/test"

import {
  tunnelCoreDnsConfiguration,
  tunnelCoreDnsRecords,
} from "./private-network.js"

describe("Tailscale stack DNS records", () => {
  it("reads back the records it writes to the stack Corefile", () => {
    const records = [
      { address: "10.140.2.10", hostname: "survival" },
      { address: "10.165.55.10", hostname: "paper" },
    ]

    const corefile = tunnelCoreDnsConfiguration("test", records)

    expect(tunnelCoreDnsRecords("test", corefile)).toEqual([
      { address: "10.165.55.10", hostname: "paper" },
      { address: "10.140.2.10", hostname: "survival" },
    ])
  })
})
