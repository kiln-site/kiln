import { describe, expect, it } from "vite-plus/test"

import { normalizeNotificationPreferences } from "@/lib/notification-preferences"

describe("notification preferences", () => {
  it("keeps today's behavior for settings stored before these choices", () => {
    const preferences = normalizeNotificationPreferences({
      kinds: { "app.deployed": { inbox: false, push: true } },
    })
    expect(preferences.scope).toBe("all")
    expect(preferences.resources).toEqual({})
    expect(preferences.kinds["app.deployed"].inbox).toBe(false)
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
})
