import { describe, expect, it } from "vite-plus/test"

import { tunnelCoreDnsRecords } from "./private-network.js"

describe("Tunnel DNS records", () => {
  // A tunnel with no records file reads the ones its Corefile had inline,
  // before CoreDNS answered from a hosts file.
  it("reads the records a Corefile from before held inline", () => {
    const corefile = `test:53 {
    errors
    cache 30
    hosts {
        10.140.2.10 survival.test
        10.165.55.10 paper.test
        ttl 60
    }
}
`

    expect(tunnelCoreDnsRecords("test", corefile)).toEqual([
      { address: "10.140.2.10", hostname: "survival" },
      { address: "10.165.55.10", hostname: "paper" },
    ])
  })
})
