import { describe, expect, it, vi } from "vite-plus/test"

import { assignRelayWebRouteIds } from "./web-route-ids.js"

const randomBytes = vi.hoisted(() => ({ queue: [] as Array<string> }))

// Route IDs come from crypto randomness; queue specific values to force a
// collision and fall back to real randomness otherwise.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>()
  return {
    ...actual,
    randomBytes: (size: number) => {
      const next = randomBytes.queue.shift()
      return next ? Buffer.from(next, "hex") : actual.randomBytes(size)
    },
  }
})

const instanceId = "a".repeat(40)
const otherInstanceId = "b".repeat(40)
const route = {
  hostname: "map.example.com",
  name: "Live Map",
  path: "/map",
  stripPrefix: true,
  targetPort: 8_100,
}
const otherInstanceRoute = {
  ...route,
  id: "deadbeef",
  instanceId: otherInstanceId,
}

describe("Relay web route IDs", () => {
  it("allocates a new ID when the generated one is taken on the Relay", () => {
    randomBytes.queue.push("deadbeef", "cafebabe")

    const [assigned] = assignRelayWebRouteIds(
      instanceId,
      [route],
      [otherInstanceRoute]
    )

    expect(assigned?.id).toBe("cafebabe")
  })

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
