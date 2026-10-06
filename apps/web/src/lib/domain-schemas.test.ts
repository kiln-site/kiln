import { describe, expect, it } from "vite-plus/test"

import {
  validateBlacklistPatterns,
  vanityLabelAllowed,
} from "@/lib/domain-schemas"

describe("managed game domains", () => {
  it("validates administrator blacklist patterns", () => {
    const patterns = validateBlacklistPatterns(["^(admin|api)$", "^staff-"])
    expect(vanityLabelAllowed("api", patterns)).toBe(false)
    expect(vanityLabelAllowed("staff-lobby", patterns)).toBe(false)
    expect(vanityLabelAllowed("survival", patterns)).toBe(true)
    expect(() => validateBlacklistPatterns(["["])).toThrow(
      "Blacklist pattern 1 is not valid"
    )
  })
})
