import { createServerFn } from "@tanstack/react-start"
import { relayIdSchema } from "@workspace/contracts"
import { z } from "zod"

import {
  domainBlacklistPatternsSchema,
  domainNameSchema,
  vanityLabelSchema,
} from "@/lib/domain-schemas"
import {
  configureDomainIntegrationHandler,
  getDomainSettingsHandler,
  getInstanceDomainHandler,
  resyncDomainAssignmentsHandler,
  setInstanceVanityHandler,
} from "@/server/domains.server"
import { publishRealtimeChange } from "@/lib/realtime-source.server"

const configureDomainInputSchema = z.object({
  apiToken: z.string().trim().min(20).max(512).optional(),
  blacklistPatterns: domainBlacklistPatternsSchema,
  domain: domainNameSchema,
  enabled: z.boolean().default(true),
})

const instanceDomainInputSchema = z.object({
  instanceId: z.string().regex(/^[a-f0-9]{40}$/u),
  relayId: relayIdSchema,
})

const setVanityInputSchema = instanceDomainInputSchema.extend({
  vanityLabel: vanityLabelSchema,
})

export type ConfigureDomainInput = z.infer<typeof configureDomainInputSchema>
export type InstanceDomainInput = z.infer<typeof instanceDomainInputSchema>
export type SetVanityInput = z.infer<typeof setVanityInputSchema>

export interface InstanceDomainOverview {
  address: string
  directAddress: string
  domain: string
  lastError: string | null
  srvActive: boolean
  status: "active" | "error" | "pending"
  supportsSrv: boolean
  vanityLabel: string
}

export interface ManagedDomainOverview {
  address: string
  instanceId: string
  port: number
  relayId: string
  relayName: string
  serverName: string
  srvActive: boolean
  status: "active" | "error" | "pending"
  supportsSrv: boolean
}

export const getDomainSettings = createServerFn({ method: "GET" }).handler(() =>
  getDomainSettingsHandler()
)

export const configureDomainIntegration = createServerFn({ method: "POST" })
  .validator(configureDomainInputSchema)
  .handler(async ({ data }) => {
    const result = await configureDomainIntegrationHandler(data)
    publishDomainChange()
    return result
  })

export const resyncDomainAssignments = createServerFn({
  method: "POST",
}).handler(async () => {
  const result = await resyncDomainAssignmentsHandler()
  publishDomainChange()
  return result
})

export const getInstanceDomain = createServerFn({ method: "GET" })
  .validator(instanceDomainInputSchema)
  .handler(({ data }) => getInstanceDomainHandler(data))

export const setInstanceVanity = createServerFn({ method: "POST" })
  .validator(setVanityInputSchema)
  .handler(async ({ data }) => {
    const result = await setInstanceVanityHandler(data)
    publishDomainChange()
    return result
  })

function publishDomainChange(): void {
  publishRealtimeChange({
    audience: { kind: "authenticated" },
    topics: ["domains"],
    type: "hearth.invalidate",
  })
}
