import { describe, expect, it } from "vite-plus/test"

import {
  requireFastReservedPatterns,
  vanityLabelAllowed,
} from "@/server/reserved-names"

describe("reserved vanity names", () => {
  it("refuses a pattern that backtracks, and never hangs on one", () => {
    const slow = "^(((.*)*)*)*!$"
    expect(() => requireFastReservedPatterns(["^www$", slow])).toThrow(
      "Reserved name pattern 2 is too slow"
    )
    // Saved anyway, it reserves names instead of stalling Hearth.
    const started = performance.now()
    for (let index = 0; index < 20; index += 1)
      expect(vanityLabelAllowed("a".repeat(40), [slow])).toBe(false)
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})
