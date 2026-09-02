import { describe, expect, it, vi } from "vite-plus/test"

import {
  registerRelayConsoleOperationClient,
  relayConsoleOperationClient,
} from "./relay-console-operations"

describe("Relay console operation ownership", () => {
  it("keeps a replacement socket registered when the old Scope closes", () => {
    const first = { request: vi.fn() }
    const second = { request: vi.fn() }
    const releaseFirst = registerRelayConsoleOperationClient(
      "relay-one",
      "instance-one",
      first
    )
    const releaseSecond = registerRelayConsoleOperationClient(
      "relay-one",
      "instance-one",
      second
    )

    releaseFirst()
    expect(relayConsoleOperationClient("relay-one", "instance-one")).toBe(
      second
    )

    releaseSecond()
    expect(relayConsoleOperationClient("relay-one", "instance-one")).toBeNull()
  })
})
