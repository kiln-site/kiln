import { describe, expect, it } from "vite-plus/test"

import { parseRange } from "./browser-socket.js"

describe("Relay browser byte ranges", () => {
  it("supports open, bounded, oversized, and suffix ranges", () => {
    expect(parseRange(undefined, 100)).toBeNull()
    expect(parseRange("bytes=10-", 100)).toEqual({ end: 99, start: 10 })
    expect(parseRange("bytes=10-19", 100)).toEqual({ end: 19, start: 10 })
    expect(parseRange("bytes=90-999", 100)).toEqual({ end: 99, start: 90 })
    expect(parseRange("bytes=-10", 100)).toEqual({ end: 99, start: 90 })
    expect(parseRange("bytes=-999", 100)).toEqual({ end: 99, start: 0 })
  })

  it("rejects malformed and unsatisfiable ranges", () => {
    expect(() => parseRange("bytes=100-", 100)).toThrow()
    expect(() => parseRange("bytes=20-10", 100)).toThrow()
    expect(() => parseRange("bytes=-0", 100)).toThrow()
    expect(() => parseRange("bytes=0-1,3-4", 100)).toThrow()
  })
})
