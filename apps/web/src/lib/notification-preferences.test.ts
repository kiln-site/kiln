import { describe, expect, it } from "vite-plus/test"

import {
  mergeNotificationPreferences,
  normalizeNotificationPreferences,
  notificationPreferencesUpdateSchema,
} from "@/lib/notification-preferences"

const key = "app:relay-a:app-a"
const muted = {
  kinds: { "app.deployed": false as const },
  name: "Site",
  type: "app" as const,
}

describe("notification preferences", () => {
  it("keeps today's behavior for settings stored before these choices", () => {
    const preferences = normalizeNotificationPreferences({
      kinds: { "app.deployed": { inbox: false, push: true } },
    })
    expect(preferences.scope).toBe("all")
    expect(preferences.resources).toEqual({})
    expect(preferences.kinds["app.deployed"].inbox).toBe(false)
  })

  it("reads what it can of a stored setting, field by field", () => {
    const preferences = normalizeNotificationPreferences({
      resources: { [key]: muted, "app:relay-a:broken": { name: 5 } },
      scope: "nonsense",
      skipPushWhileActive: false,
    })
    expect(preferences.resources).toEqual({ [key]: muted })
    expect(preferences.scope).toBe("all")
    expect(preferences.skipPushWhileActive).toBe(false)
  })

  it("carries a Relay's muted updates over to Kiln's", () => {
    const preferences = normalizeNotificationPreferences({
      kinds: { "relay.updated": { inbox: false, push: true } },
      resources: {
        "relay:relay-a:relay-a": {
          kinds: { "relay.updated": false },
          name: "Frankfurt",
          type: "relay",
        },
      },
    })
    expect(preferences.kinds["kiln.updated"].inbox).toBe(false)
    expect(preferences.resources["relay:relay-a:relay-a"]?.kinds).toEqual({
      "kiln.updated": false,
    })
  })

  it("saves and resets one resource, leaving the rest", () => {
    const other = "database:relay-a:db-a"
    const stored = mergeNotificationPreferences(
      { resources: { [other]: { ...muted, type: "database" } } },
      { resources: { [key]: muted } }
    )
    expect(Object.keys(stored.resources)).toEqual([other, key])
    const reset = mergeNotificationPreferences(stored, {
      resources: { [key]: null },
    })
    expect(Object.keys(reset.resources)).toEqual([other])
  })

  it("keeps a kind a newer Kiln turned off for a resource", () => {
    const stored = mergeNotificationPreferences(
      {
        resources: {
          [key]: { ...muted, kinds: { "app.crashed": false } },
        },
      },
      { idleMinutes: 5 }
    )
    expect(stored.resources[key]?.kinds).toEqual({ "app.crashed": false })
  })

  it("refuses what a save has no business storing", () => {
    const parse = (resources: unknown) =>
      notificationPreferencesUpdateSchema.safeParse({ resources }).success
    expect(parse({ [key]: muted })).toBe(true)
    expect(parse({ [key]: null })).toBe(true)
    expect(parse({ "not-a-resource": muted })).toBe(false)
    expect(
      parse({ [key]: { ...muted, kinds: { "app.deployed": true } } })
    ).toBe(false)
    expect(parse({ [key]: { ...muted, extra: "x" } })).toBe(false)
  })
})
