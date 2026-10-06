import { describe, expect, it } from "vite-plus/test"

import {
  isPublicRemoteAddress,
  isSourceAllowed,
  normalizeSourceCidrs,
} from "./source-policy.js"

describe("Relay source policy", () => {
  it("normalizes exact addresses and rejects sources outside the CIDR", () => {
    const policy = normalizeSourceCidrs([
      "192.0.2.19",
      "2001:db8::/48",
      "192.0.2.19/32",
    ])

    expect(policy).toEqual(["192.0.2.19/32", "2001:db8::/48"])
    expect(isSourceAllowed("192.0.2.19", policy)).toBe(true)
    expect(isSourceAllowed("192.0.2.20", policy)).toBe(false)
    expect(isSourceAllowed("2001:db8::42", policy)).toBe(true)
    expect(isSourceAllowed("2001:db9::42", policy)).toBe(false)
  })

  it("handles IPv4-mapped peers and fails closed without a peer", () => {
    expect(isSourceAllowed("::ffff:127.0.0.1", ["127.0.0.0/8"])).toBe(true)
    expect(isSourceAllowed(undefined, ["127.0.0.0/8"])).toBe(false)
    expect(isSourceAllowed(undefined, [])).toBe(true)
  })

  it("rejects malformed and oversized policies", () => {
    expect(() => normalizeSourceCidrs(["192.0.2.1/33"])).toThrow()
    expect(() => normalizeSourceCidrs(Array(17).fill("192.0.2.1"))).toThrow()
  })

  it("blocks private, loopback, link-local, and reserved remote downloads", () => {
    expect(isPublicRemoteAddress("8.8.8.8")).toBe(true)
    expect(isPublicRemoteAddress("::ffff:808:808")).toBe(true)
    expect(isPublicRemoteAddress("2606:4700:4700::1111")).toBe(true)
    expect(isPublicRemoteAddress("127.0.0.1")).toBe(false)
    expect(isPublicRemoteAddress("10.42.0.1")).toBe(false)
    expect(isPublicRemoteAddress("169.254.169.254")).toBe(false)
    expect(isPublicRemoteAddress("::1")).toBe(false)
    expect(isPublicRemoteAddress("::ffff:127.0.0.1")).toBe(false)
    expect(isPublicRemoteAddress("::ffff:7f00:1")).toBe(false)
    expect(isPublicRemoteAddress("64:ff9b::7f00:1")).toBe(false)
  })
})
