import * as React from "react"

import { randomIdempotencyKey } from "@/lib/idempotency-key"

/**
 * The key a create is sent with: the same one for as long as what's asked
 * for stays the same, so trying it again reuses its ID, and a new one once
 * anything about it changes.
 */
export function useIdempotencyKey(): (input: unknown) => string {
  const attempt = React.useRef<{
    fingerprint: string
    idempotencyKey: string
  } | null>(null)
  return React.useCallback((input) => {
    const fingerprint = JSON.stringify(input)
    const idempotencyKey =
      attempt.current?.fingerprint === fingerprint
        ? attempt.current.idempotencyKey
        : randomIdempotencyKey()
    attempt.current = { fingerprint, idempotencyKey }
    return idempotencyKey
  }, [])
}
