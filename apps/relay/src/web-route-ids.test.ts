import { describe, expect, it } from "vite-plus/test"

import { assignRelayWebRouteIds } from "./web-route-ids.js"

const instanceId = "a".repeat(40)
const route = {
  hostname: "map.example.com",
  name: "Live Map",
  path: "/map",
  stripPrefix: true,
  targetPort: 8_100,
}

describe("Relay web route IDs", () => {
  it("allocates short IDs and retries Relay-local collisions", () => {
    const candidates = ["deadbeef", "cafebabe"]
    const configured = [
      {
        ...route,
        id: "deadbeef",
        instanceId: "b".repeat(40),
      },
    ]

    const [assigned] = assignRelayWebRouteIds(
      instanceId,
      [route],
      configured,
      () => candidates.shift() ?? "facefeed"
    )

    expect(assigned?.id).toBe("cafebabe")
  })

  it("rejects a route ID owned by another instance on the Relay", () => {
    expect(() =>
      assignRelayWebRouteIds(
        instanceId,
        [{ ...route, id: "deadbeef" }],
        [
          {
            ...route,
            id: "deadbeef",
            instanceId: "b".repeat(40),
          },
        ]
      )
    ).toThrow("Another Ember already uses web route ID deadbeef")
  })
})
