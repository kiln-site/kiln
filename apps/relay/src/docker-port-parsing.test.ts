import { describe, expect, it } from "vite-plus/test"

import { procNetTcpHasListener } from "./docker-port-parsing.js"

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
