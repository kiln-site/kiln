import { describe, expect, it } from "vite-plus/test"

import {
  invitePath,
  invitationReferenceFromRedirect,
} from "@/lib/invitation-auth"

describe("invitation auth helpers", () => {
  it("resolves both delivered invitation IDs and token links for account onboarding", () => {
    const id = "2a226644-998c-449a-b574-971b22a722d3"
    const token = "a".repeat(32)
    expect(invitationReferenceFromRedirect(`/invite?id=${id}`)).toEqual({ id })
    expect(invitationReferenceFromRedirect(invitePath(token))).toEqual({
      token,
    })
  })
  it("ignores redirects that are not a well-formed invitation link", () => {
    const id = "2a226644-998c-449a-b574-971b22a722d3"
    for (const redirect of [
      "/invite?id=not-an-invitation",
      `https://elsewhere.test/invite?id=${id}`,
      `/?redirect=${invitePath("a".repeat(32))}`,
      "/invite?token=short",
      "/invite?://",
    ]) {
      expect(invitationReferenceFromRedirect(redirect)).toBeNull()
    }
  })
})
