import { describe, expect, it } from "vite-plus/test"

import {
  invitationDestination,
  invitePath,
  inviteTokenFromRedirect,
  invitationReferenceFromRedirect,
} from "@/lib/invitation-auth"

describe("invitation auth helpers", () => {
  it("resolves both delivered invitation IDs and token links for account onboarding", () => {
    const id = "2a226644-998c-449a-b574-971b22a722d3"
    expect(invitationReferenceFromRedirect(`/invite?id=${id}`)).toEqual({ id })
    expect(invitationReferenceFromRedirect(invitePath("a".repeat(64)))).toEqual(
      { token: "a".repeat(64) }
    )
    expect(
      invitationReferenceFromRedirect("/invite?id=not-an-invitation")
    ).toBeNull()
    expect(
      invitationReferenceFromRedirect(`https://elsewhere.test/invite?id=${id}`)
    ).toBeNull()
  })
  it("builds and parses invite redirect paths", () => {
    const token = "a".repeat(32)
    const path = invitePath(token)
    expect(path).toBe(`/invite?token=${token}`)
    expect(inviteTokenFromRedirect(path)).toBe(token)
    expect(inviteTokenFromRedirect(`/?redirect=${path}`)).toBeNull()
    expect(inviteTokenFromRedirect("/invite?token=short")).toBeNull()
    expect(inviteTokenFromRedirect("/invite?://")).toBeNull()
  })

  it("sends accepted invitations to the invited resource", () => {
    expect(
      invitationDestination({
        accessType: "platform_admin",
        databaseId: null,
        instanceId: null,
      })
    ).toBe("/infra/relays")
    expect(
      invitationDestination({
        accessType: "relay_creator",
        databaseId: null,
        instanceId: null,
      })
    ).toBe("/infra/relays")
    expect(
      invitationDestination({
        accessType: "scoped",
        databaseId: null,
        instanceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      })
    ).toBe("/server/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/console")
    expect(
      invitationDestination({
        accessType: "scoped",
        databaseId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        instanceId: null,
      })
    ).toBe("/infra/databases?search=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    expect(
      invitationDestination({
        accessType: "scoped",
        databaseId: null,
        instanceId: null,
      })
    ).toBe("/infra/servers")
  })
})
