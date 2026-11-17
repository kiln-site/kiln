import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import type { RecoveryKitReveal, RecoveryKitStatus } from "@/lib/recovery-kit"

// Kiln's recovery kit, for its platform administrators; see
// `recovery-kit.server.ts`.

export const getRecoveryKitStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<RecoveryKitStatus> => {
    const { recoveryKitStatus } = await import("@/server/recovery-kit.server")
    return recoveryKitStatus()
  }
)

// POST: it marks the first reveal, and its code stays out of URLs.
export const revealRecoveryKit = createServerFn({ method: "POST" })
  .validator(z.object({ code: z.string().max(64).nullable() }))
  .handler(async ({ data }): Promise<RecoveryKitReveal> => {
    const [{ getRequest }, { revealRecoveryKit: reveal }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/server/recovery-kit.server"),
    ])
    // Better Auth checks the code against the session this request carries.
    return reveal(data.code, getRequest().headers)
  })

export const acknowledgeRecoveryKit = createServerFn({
  method: "POST",
}).handler(async () => {
  const { acknowledgeRecoveryKit: acknowledge } =
    await import("@/server/recovery-kit.server")
  await acknowledge()
  return { saved: true as const }
})
