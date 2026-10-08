import { describe, expect, it } from "vite-plus/test"

import {
  databaseRouteIdentifier,
  resolveDatabaseRoute,
} from "@/lib/database-route"

const first = { id: `abcdef12${"1".repeat(32)}` }
const second = { id: `abcdef12${"2".repeat(32)}` }
const other = { id: `99999999${"3".repeat(32)}` }

describe("database routes", () => {
  it("keeps databases that share a short ID reachable by their full ID", () => {
    const databases = [first, second, other]

    expect(resolveDatabaseRoute(databases, "abcdef12")).toEqual({
      status: "ambiguous",
    })
    for (const database of [first, second]) {
      const routeId = databaseRouteIdentifier(databases, database)
      expect(resolveDatabaseRoute(databases, routeId)).toEqual({
        database,
        status: "found",
      })
    }
  })

  it("uses the short ID when it is unique", () => {
    const databases = [first, other]
    const routeId = databaseRouteIdentifier(databases, first)

    expect(routeId).toBe("abcdef12")
    expect(resolveDatabaseRoute(databases, routeId)).toEqual({
      database: first,
      status: "found",
    })
  })
})
