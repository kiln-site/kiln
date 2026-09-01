import { describe, expect, it } from "vite-plus/test"

import { relayConsoleTransport } from "@/lib/relay-console-route"

describe("Relay console routing", () => {
  it("maps every proxy mode to its browser transport", () => {
    expect(relayConsoleTransport(undefined)).toBeNull()
    expect(relayConsoleTransport("hearth")).toBe("hearth")
    expect(relayConsoleTransport("none")).toBe("direct")
    expect(relayConsoleTransport("traefik")).toBe("direct")
    expect(relayConsoleTransport("coolify")).toBe("direct")
  })
})
