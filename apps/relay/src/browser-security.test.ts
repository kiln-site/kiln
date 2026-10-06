import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vite-plus/test"

import { isCanonicalBrowserFileProofNonce } from "./browser-security.js"

// Hearth signs file requests with a 32-byte base64url nonce.
const nonceBytes = 32

describe("browser security", () => {
  it("accepts only canonical fixed-size file proof nonces", () => {
    const nonce = randomBytes(nonceBytes).toString("base64url")

    expect(isCanonicalBrowserFileProofNonce(nonce)).toBe(true)
    expect(isCanonicalBrowserFileProofNonce(`${nonce}=`)).toBe(false)
    expect(isCanonicalBrowserFileProofNonce("a".repeat(1024 * 1024))).toBe(
      false
    )
    expect(
      isCanonicalBrowserFileProofNonce(
        randomBytes(nonceBytes - 1).toString("base64url")
      )
    ).toBe(false)
    expect(
      isCanonicalBrowserFileProofNonce(
        randomBytes(nonceBytes + 1).toString("base64url")
      )
    ).toBe(false)
  })
})
