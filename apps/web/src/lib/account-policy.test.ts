import { describe, expect, it } from "vite-plus/test"

import {
  isAccountEnabled,
  isAccountVerified,
  requireEligibleAccount,
  requireVerifiedAccount,
} from "./account-policy"

const unverified = {
  status: "enabled" as const,
  emailVerified: true,
  emailVerifiedAt: null,
  manuallyVerifiedAt: null,
  legacyVerificationRecordedAt: null,
}

describe("account eligibility", () => {
  it("does not mistake the integration flag for current verification evidence", () => {
    expect(isAccountVerified(unverified)).toBe(false)
    expect(() => requireEligibleAccount(unverified)).toThrow("verification")
  })
  it("accepts manual evidence without asserting mailbox ownership", () => {
    expect(
      isAccountVerified({
        ...unverified,
        emailVerified: false,
        manuallyVerifiedAt: "2026-09-08T00:00:00Z",
      })
    ).toBe(true)
  })
  it("preserves explicit legacy trust without inventing email or manual evidence", () => {
    expect(
      isAccountVerified({
        ...unverified,
        legacyVerificationRecordedAt: "2026-09-08T00:00:00Z",
      })
    ).toBe(true)
  })
  it("permits verified disabled self-account access while denying resources", () => {
    const disabled = {
      ...unverified,
      status: "disabled" as const,
      manuallyVerifiedAt: "2026-09-08T00:00:00Z",
    }
    expect(() => requireVerifiedAccount(disabled)).not.toThrow()
    expect(() => requireEligibleAccount(disabled)).toThrow("disabled")
  })
  it("preserves migrated temporary disable expiry", () => {
    const user = {
      status: "disabled" as const,
      statusExpiresAt: "2026-09-08T00:00:00Z",
    }
    const expiry = Date.parse(user.statusExpiresAt)
    expect(isAccountEnabled(user, expiry - 1)).toBe(false)
    expect(isAccountEnabled(user, expiry)).toBe(true)
    expect(isAccountEnabled({ ...user, statusExpiresAt: null }, expiry)).toBe(
      false
    )
  })
})
