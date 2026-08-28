import { describe, expect, it } from "vite-plus/test"

import { hearthAudienceAllows } from "./hearth-realtime-topics"

const basePolicy = {
  canManageRelays: false,
  isPlatformAdmin: false,
  readableRelays: new Set(["relay-a"]),
  userId: "user-a",
}

describe("Hearth realtime audiences", () => {
  it("allows every signed-in stream for non-sensitive shared state", () => {
    expect(hearthAudienceAllows(basePolicy, { kind: "authenticated" })).toBe(
      true
    )
  })

  it("targets exact users without exposing the event to others", () => {
    expect(
      hearthAudienceAllows(basePolicy, {
        kind: "users",
        userIds: ["user-a"],
      })
    ).toBe(true)
    expect(
      hearthAudienceAllows(basePolicy, {
        kind: "users",
        userIds: ["user-b"],
      })
    ).toBe(false)
  })

  it("allows only Relay managers for manager-wide state", () => {
    expect(hearthAudienceAllows(basePolicy, { kind: "relay-managers" })).toBe(
      false
    )
    expect(
      hearthAudienceAllows(
        { ...basePolicy, canManageRelays: true },
        { kind: "relay-managers" }
      )
    ).toBe(true)
  })

  it("targets backup storage owners and platform administrators", () => {
    expect(
      hearthAudienceAllows(basePolicy, {
        kind: "backup-storage",
        ownerUserId: "user-a",
      })
    ).toBe(true)
    expect(
      hearthAudienceAllows(basePolicy, {
        kind: "backup-storage",
        ownerUserId: "user-b",
      })
    ).toBe(false)
    expect(
      hearthAudienceAllows(
        { ...basePolicy, isPlatformAdmin: true },
        { kind: "backup-storage", ownerUserId: "user-b" }
      )
    ).toBe(true)
    expect(
      hearthAudienceAllows(basePolicy, {
        kind: "backup-storage",
        ownerUserId: null,
      })
    ).toBe(true)
  })

  it("targets platform administrators without broadcasting admin state", () => {
    expect(hearthAudienceAllows(basePolicy, { kind: "platform-admins" })).toBe(
      false
    )
    expect(
      hearthAudienceAllows(
        { ...basePolicy, isPlatformAdmin: true },
        { kind: "platform-admins" }
      )
    ).toBe(true)
  })

  it("matches Relay-scoped state without requiring every Relay", () => {
    expect(
      hearthAudienceAllows(basePolicy, {
        kind: "relays",
        relayIds: ["relay-b", "relay-a"],
      })
    ).toBe(true)
    expect(
      hearthAudienceAllows(basePolicy, {
        kind: "relays",
        relayIds: ["relay-b"],
      })
    ).toBe(false)
  })
})
