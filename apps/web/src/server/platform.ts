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
  error: string | null
  relayId: string
  relayName: string
  status: RelayPlatformStatus | null
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

/** Puts a Kiln backup back, or with none, what the last restore replaced. */
export const restoreKiln = createServerFn({ method: "POST" })
  .validator(
    z.strictObject({ backupId: z.uuid().nullable(), relayId: relayIdSchema })
  )
  .handler(async ({ data }) => {
    const { restoreKilnBackup } =
      await import("@/server/kiln-platform-operations.server")
    await restoreKilnBackup(data)
  })

export const runKilnPlatformAction = createServerFn({ method: "POST" })
  .validator(
    relayPlatformActionInputSchema
      .refine(({ action }) => action !== "restore")
      .and(z.object({ relayId: relayIdSchema }))
  )
  .handler(async ({ data }) => {
    const { runKilnServiceAction } =
      await import("@/server/kiln-platform-operations.server")
    return relayPlatformStatusSchema.parse(await runKilnServiceAction(data))
  })
