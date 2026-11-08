import { describe, expect, it } from "vite-plus/test"

import { findRelayInstance } from "@/lib/relay-selectors"

const servers = [
  { id: "aaaaaaaaaaaa", name: "Survival", relayId: "111111111111" },
  { id: "aaaaaaaabbbb", name: "Creative", relayId: "222222222222" },
]

describe("Relay render selectors", () => {
  it("finds a game server by its instance ID on any Relay", () => {
    expect(findRelayInstance(servers, "aaaaaaaabbbb")).toBe(servers[1])
  })

  it("matches neither part of an ID nor a name", () => {
    expect(findRelayInstance(servers, "aaaaaaaa")).toBeUndefined()
    expect(findRelayInstance(servers, "Survival")).toBeUndefined()
    expect(findRelayInstance(servers, null)).toBeUndefined()
  })
})
