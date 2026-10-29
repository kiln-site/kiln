import { describe, expect, it } from "vite-plus/test"

import { tailscaleMemberProblem } from "./tailscale-members"

const relayId = "r".repeat(43)
const otherRelayId = "s".repeat(43)
const databaseId = "d".repeat(40)

describe("Tailscale network members", () => {
  const records = {
    apps: [],
    databases: [{ databaseId, relayId: otherRelayId }],
    instances: [],
  }

  it("refuses a database that runs on another Relay than the binding's", () => {
    expect(
      tailscaleMemberProblem(
        { memberId: `database:${databaseId}`, relayId },
        records
      )
    ).toBe(`Database ${databaseId.slice(0, 8)} is unavailable`)
    expect(
      tailscaleMemberProblem(
        { memberId: `database:${databaseId}`, relayId: otherRelayId },
        records
      )
    ).toBeNull()
  })
})
