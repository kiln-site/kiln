import { describe, expect, it } from "vite-plus/test"

import {
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
    expect(() => requireEligibleAccount(unverified)).toThrow()
  })
  it("permits verified disabled self-account access while denying resources", () => {
    const disabled = {
      ...unverified,
      status: "disabled" as const,
      manuallyVerifiedAt: "2026-09-08T00:00:00Z",
    }
    expect(() => requireVerifiedAccount(disabled)).not.toThrow()
    expect(() => requireEligibleAccount(disabled)).toThrow()
  })
})
