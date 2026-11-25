import vm from "node:vm"

import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import {
  requireFastReservedPatterns,
  vanityLabelAllowed,
} from "@/server/reserved-names"

afterEach(() => {
  vi.restoreAllMocks()
})

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

  // One pause of Hearth's would otherwise reserve every name of a domain
  // until Hearth next starts.
  it("doesn't take a pattern interrupted once for a slow one", () => {
    vi.spyOn(vm.Script.prototype, "runInContext").mockImplementationOnce(() => {
      throw new Error("Script execution timed out after 25ms")
    })
    expect(vanityLabelAllowed("play", ["^interrupted$"])).toBe(true)
    expect(vanityLabelAllowed("interrupted", ["^interrupted$"])).toBe(false)
  })
})
