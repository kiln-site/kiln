import { describe, expect, it } from "vite-plus/test"

import { assignRelayWebRouteIds } from "./web-route-ids.js"

const instanceId = "a".repeat(40)
const otherInstanceId = "b".repeat(40)
const route = {
  hostname: "map.example.com",
  name: "Live Map",
  path: "/map",
  stripPrefix: true,
  httpsRedirect: true,
  primary: false,
  redirect: null,
  www: "none" as const,
  targetPort: 8_100,
}
const otherInstanceRoute = {
  ...route,
  id: "deadbeef",
  instanceId: otherInstanceId,
}

describe("Relay web route IDs", () => {
  it("rejects a route ID owned by another instance on the Relay", () => {
    const claimed = { ...route, id: "deadbeef" }

    expect(() =>
      assignRelayWebRouteIds(instanceId, [claimed], [otherInstanceRoute])
    ).toThrow()
    expect(
      assignRelayWebRouteIds(otherInstanceId, [claimed], [otherInstanceRoute])
    ).toEqual([claimed])
  })
})
