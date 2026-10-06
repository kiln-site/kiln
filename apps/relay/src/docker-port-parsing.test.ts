import { describe, expect, it } from "vite-plus/test"

import {
  dockerPublishedHostPortsFromListing,
  procNetTcpHasListener,
} from "./docker-port-parsing.js"

describe("Docker port listings", () => {
  it("collects host ports from compact listings, including ranges and IPv6", () => {
    const listing = [
      "0.0.0.0:30000->25565/tcp, [::]:30000->25565/tcp",
      "127.0.0.1:30001-30003->19132-19134/udp",
      "8080/tcp, 9000/udp",
      "garbage, :->/tcp, 0.0.0.0:70000->1/tcp",
      "",
    ].join("\n")

    expect([...dockerPublishedHostPortsFromListing(listing, "tcp")]).toEqual([
      30_000,
    ])
    expect([...dockerPublishedHostPortsFromListing(listing, "udp")]).toEqual([
      30_001, 30_002, 30_003,
    ])
  })
})

describe("/proc/net/tcp listeners", () => {
  it("finds IPv4 and IPv6 listeners and ignores connected sockets", () => {
    const procNetTcp = [
      "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt",
      "0: 00000000:63DD 00000000:0000 0A 00000000:00000000",
      "1: 00000000000000000000000000000000:9C40 00000000000000000000000000000000:0000 0A 00000000:00000000",
      "2: 0100007F:63DE 0100007F:C001 01 00000000:00000000",
    ].join("\n")

    expect(procNetTcpHasListener(procNetTcp, 25_565)).toBe(true)
    expect(procNetTcpHasListener(procNetTcp, 40_000)).toBe(true)
    expect(procNetTcpHasListener(procNetTcp, 25_566)).toBe(false)
  })
})
