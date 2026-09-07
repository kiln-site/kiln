export const BROWSER_READ_LEASE_MAX_MS = 60_000
export const BROWSER_WRITE_LEASE_MAX_MS = 30_000
export const BROWSER_ISSUED_AT_SKEW_MS = 5_000
// Floors must outlive every capability minted before a revocation. Derive the
// retention from the same bounds enforced at admission, including clock skew.
export const BROWSER_AUTHORIZATION_FLOOR_RETENTION_MS =
  5 * Math.max(BROWSER_READ_LEASE_MAX_MS, BROWSER_WRITE_LEASE_MAX_MS) +
  BROWSER_ISSUED_AT_SKEW_MS
export const BROWSER_FILE_PROOF_NONCE_BYTES = 32

export function isCanonicalBrowserFileProofNonce(value: string): boolean {
  if (value.length !== 43) return false
  const decoded = Buffer.from(value, "base64url")
  return (
    decoded.byteLength === BROWSER_FILE_PROOF_NONCE_BYTES &&
    decoded.toString("base64url") === value
  )
}
