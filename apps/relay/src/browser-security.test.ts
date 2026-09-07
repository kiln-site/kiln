import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vite-plus/test"

import {
  BROWSER_FILE_PROOF_NONCE_BYTES,
  isCanonicalBrowserFileProofNonce,
} from "./browser-security.js"

describe("browser security", () => {
  it("accepts only canonical fixed-size file proof nonces", () => {
    const nonce = randomBytes(BROWSER_FILE_PROOF_NONCE_BYTES).toString(
      "base64url"
    )

    expect(isCanonicalBrowserFileProofNonce(nonce)).toBe(true)
    expect(isCanonicalBrowserFileProofNonce(`${nonce}=`)).toBe(false)
    expect(isCanonicalBrowserFileProofNonce("a".repeat(1024 * 1024))).toBe(
      false
    )
    expect(
      isCanonicalBrowserFileProofNonce(
        randomBytes(BROWSER_FILE_PROOF_NONCE_BYTES - 1).toString("base64url")
      )
    ).toBe(false)
    expect(
      isCanonicalBrowserFileProofNonce(
        randomBytes(BROWSER_FILE_PROOF_NONCE_BYTES + 1).toString("base64url")
      )
    ).toBe(false)
  })
})
