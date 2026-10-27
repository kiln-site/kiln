import { describe, expect, it } from "vite-plus/test"

import {
  badWordsPattern,
  validateBlacklistPatterns,
} from "@/lib/domain-schemas"
import {
  requireFastReservedPatterns,
  vanityLabelAllowed,
} from "@/server/reserved-names"

describe("reserved vanity names", () => {
  it("validates reserved name patterns", () => {
    const patterns = validateBlacklistPatterns(["^(admin|api)$", "^staff-"])
    expect(vanityLabelAllowed("api", patterns)).toBe(false)
    expect(vanityLabelAllowed("staff-lobby", patterns)).toBe(false)
    expect(vanityLabelAllowed("survival", patterns)).toBe(true)
    expect(() => validateBlacklistPatterns(["["])).toThrow(
      "Blacklist pattern 1 is not valid"
    )
  })

  it("keeps profanity out however it's disguised", () => {
    const patterns = validateBlacklistPatterns([badWordsPattern])
    for (const label of ["shit-smp", "sh1t", "fvck", "f-u-c-k", "pen-island"])
      expect(vanityLabelAllowed(label, patterns), label).toBe(false)
    // Words that only contain one stay usable.
    for (const label of ["classic-smp", "assassin-games", "scunthorpe"])
      expect(vanityLabelAllowed(label, patterns), label).toBe(true)
  })

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
