import { createServerFn } from "@tanstack/react-start"
import {
  relayIdSchema,
  relayPlatformActionInputSchema,
  relayPlatformStatusSchema,
  type RelayPlatformStatus,
} from "@workspace/contracts"
import { z } from "zod"

import type { KilnPlatform } from "@/lib/kiln-host"

// Kiln's own services: Hearth, its database, its cache, and the Traefik in
// front of it, as reported by the Relay on their Docker host. Platform
// administrators only; Hearth's logs can hold anything it printed.

export interface KilnPlatformHost {
  /** Whether the Relay browses Hearth's database (`relay-platform-database-v1`). */
  database: boolean
  error: string | null
  relayId: string
  relayName: string
  status: RelayPlatformStatus | null
  /** Whether the Relay streams logs and opens shells (`relay-platform-v2`). */
  v2: boolean
}

export const getKilnPlatform = createServerFn({ method: "GET" }).handler(
  async (): Promise<KilnPlatform> => {
    const [{ kilnPlatformHosts, requirePlatformAdministrator }, installation] =
      await Promise.all([
        import("@/server/platform-access.server"),
        import("@/effect/installation"),
      ])
    await requirePlatformAdministrator()
    return {
      hosts: await kilnPlatformHosts(),
      installationId: installation.loadedKilnInstallationId(),
    }
  }
)

export const runKilnPlatformAction = createServerFn({ method: "POST" })
  .validator(
    relayPlatformActionInputSchema.and(z.object({ relayId: relayIdSchema }))
  )
  .handler(async ({ data }) => {
    const { runKilnServiceAction } =
      await import("@/server/kiln-platform-operations.server")
    return relayPlatformStatusSchema.parse(await runKilnServiceAction(data))
  })
