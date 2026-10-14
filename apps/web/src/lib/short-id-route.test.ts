import { describe, expect, it } from "vite-plus/test"

import {
  resolveShortIdRoute,
  shortIdRouteIdentifier,
} from "@/lib/short-id-route"

const first = { id: `abcdef12${"1".repeat(32)}` }
const second = { id: `abcdef12${"2".repeat(32)}` }
const other = { id: `99999999${"3".repeat(32)}` }

describe("short ID routes", () => {
  it("keeps resources that share a short ID reachable by their full ID", () => {
    const resources = [first, second, other]

    expect(resolveShortIdRoute(resources, "abcdef12")).toEqual({
      status: "ambiguous",
    })
    for (const resource of [first, second]) {
      const routeId = shortIdRouteIdentifier(resources, resource)
      expect(resolveShortIdRoute(resources, routeId)).toEqual({
        resource,
        status: "found",
      })
    }
  })

  it("uses the short ID when it is unique", () => {
    const resources = [first, other]
    const routeId = shortIdRouteIdentifier(resources, first)

    expect(routeId).toBe("abcdef12")
    expect(resolveShortIdRoute(resources, routeId)).toEqual({
      resource: first,
      status: "found",
    })
  })
})
