import { describe, expect, it } from "vite-plus/test"

import {
  displayNameFromEmail,
  parseDisplayName,
  resolveDisplayName,
} from "@/lib/display-name"

describe("display name helpers", () => {
  it("trims required display names and enforces the maximum length", () => {
    expect(parseDisplayName("  Ember  ")).toBe("Ember")
    expect(() => parseDisplayName("   ")).toThrow("Enter a display name")
    expect(() => parseDisplayName("a".repeat(17))).toThrow(
      "Use no more than 16 characters"
    )
  })

  it("derives a bounded legacy fallback from the email address", () => {
    expect(displayNameFromEmail(" OldOperator@example.com ")).toBe(
      "oldoperator"
    )
    expect(displayNameFromEmail(`${"a".repeat(20)}@example.com`)).toBe(
      "a".repeat(16)
    )
    expect(resolveDisplayName("  ", "operator@example.com")).toBe("operator")
  })
})
