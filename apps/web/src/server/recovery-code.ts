import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import type {
  RecoveryCodeReveal,
  RecoveryCodeStatus,
} from "@/lib/recovery-code"

// Kiln's recovery code, for its platform administrators; see
// `recovery-code.server.ts`.

export const getRecoveryCodeStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<RecoveryCodeStatus> => {
    const { recoveryCodeStatus } = await import("@/server/recovery-code.server")
    return recoveryCodeStatus()
  }
)

// POST: it marks the first reveal, and its two-factor code stays out of
// URLs.
export const revealRecoveryCode = createServerFn({ method: "POST" })
  .validator(z.object({ twoFactorCode: z.string().max(64).nullable() }))
  .handler(async ({ data }): Promise<RecoveryCodeReveal> => {
    const [{ getRequest }, { revealRecoveryCode: reveal }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/server/recovery-code.server"),
    ])
    // Better Auth checks the two-factor code against the session this
    // request carries.
    return reveal(data.twoFactorCode, getRequest().headers)
  })

export const acknowledgeRecoveryCode = createServerFn({
  method: "POST",
}).handler(async () => {
  const { acknowledgeRecoveryCode: acknowledge } =
    await import("@/server/recovery-code.server")
  await acknowledge()
  return { saved: true as const }
})
