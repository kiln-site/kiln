import { describe, expect, it } from "vite-plus/test"

import { isExpectedAppError } from "./sentry-policy"

describe("Sentry error policy", () => {
  it("ignores request cancellation errors", () => {
    expect(isExpectedAppError(new DOMException("cancelled", "AbortError"))).toBe(
      true
    )
  })

  it("still reports unrelated errors", () => {
    expect(isExpectedAppError(new Error("database unavailable"))).toBe(false)
  })
})
