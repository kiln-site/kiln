import { createServerFn } from "@tanstack/react-start"
import { relayIdSchema } from "@workspace/contracts"
import { z } from "zod"

import {
  domainAssignmentStrategySchema,
  domainBlacklistPatternsSchema,
  domainNameSchema,
  vanityLabelSchema,
} from "@/lib/domain-schemas"
import {
  configureDomainIntegrationHandler,
  createInstanceDomainHandler,
  discoverCloudflareDomainsHandler,
  getDomainSettingsHandler,
  getInstanceDomainHandler,
  removeInstanceDomainHandler,
  resyncDomainAssignmentsHandler,
  updateInstanceDomainHandler,
} from "@/server/domains.server"
import { publishDomainChange } from "@/lib/domain-realtime.server"

const apiTokenSchema = z.string().trim().min(20).max(512)
const zoneIdSchema = z.string().regex(/^[a-f0-9]{32}$/u)
const domainIdSchema = z.uuid()

const configureDomainInputSchema = z.object({
  apiToken: apiTokenSchema.optional(),
  blacklistPatterns: domainBlacklistPatternsSchema,
  defaultDomain: domainNameSchema,
  domains: z
    .array(z.object({ domain: domainNameSchema, zoneId: zoneIdSchema }))
    .min(1, "Choose at least one domain")
    .max(50),
  enabled: z.boolean().default(true),
  strategy: domainAssignmentStrategySchema,
})

const discoverDomainsInputSchema = z.object({
  apiToken: apiTokenSchema.optional(),
})

const instanceDomainInputSchema = z.object({
  instanceId: z.string().regex(/^[a-f0-9]{40}$/u),
  relayId: relayIdSchema,
})

const createInstanceDomainInputSchema = instanceDomainInputSchema.extend({
  domain: domainNameSchema,
  primary: z.boolean(),
  /** Omitted to let Kiln generate an available name. */
  vanityLabel: vanityLabelSchema.optional(),
})

const updateInstanceDomainInputSchema = z.object({
  domain: domainNameSchema,
  id: domainIdSchema,
  primary: z.boolean(),
  vanityLabel: vanityLabelSchema,
})

const removeInstanceDomainInputSchema = z.object({ id: domainIdSchema })

export type ConfigureDomainInput = z.infer<typeof configureDomainInputSchema>
export type DiscoverDomainsInput = z.infer<typeof discoverDomainsInputSchema>
export type InstanceDomainInput = z.infer<typeof instanceDomainInputSchema>
export type CreateInstanceDomainInput = z.infer<
  typeof createInstanceDomainInputSchema
>
export type UpdateInstanceDomainInput = z.infer<
  typeof updateInstanceDomainInputSchema
>
export type RemoveInstanceDomainInput = z.infer<
  typeof removeInstanceDomainInputSchema
>

export interface InstanceDomainOverview {
  address: string
  directAddress: string
  domain: string
  lastError: string | null
  srvActive: boolean
  status: "active" | "error" | "pending" | "removing"
  supportsSrv: boolean
  vanityLabel: string
}

export interface ManagedDomainOverview {
  address: string
  domain: string
  /** How many domains point at this row's game server. */
  domainCount: number
  id: string
  instanceId: string
  lastError: string | null
  port: number
  /** The game server's connect address; one per game server. */
  primary: boolean
  relayId: string
  relayName: string
  server: {
    brickId: string | undefined
    game: string | undefined
    implementation: string | undefined
    name: string
    /** The `/server/$serverId` param, as the Game Servers table links it. */
    routeId: string
  }
  srvActive: boolean
  status: "active" | "error" | "pending" | "removing"
  supportsSrv: boolean
  vanityLabel: string
  /** The Cloudflare zone, for its dashboard link. */
  zoneName: string | null
}

export interface DiscoveredCloudflareZone {
  id: string
  name: string
}

export const getDomainSettings = createServerFn({ method: "GET" }).handler(() =>
  getDomainSettingsHandler()
)

// POST, so a pasted token travels in the body rather than a URL.
export const discoverCloudflareDomains = createServerFn({ method: "POST" })
  .validator(discoverDomainsInputSchema)
  .handler(({ data }) => discoverCloudflareDomainsHandler(data))

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

export const createInstanceDomain = createServerFn({ method: "POST" })
  .validator(createInstanceDomainInputSchema)
  .handler(({ data }) => createInstanceDomainHandler(data))

export const updateInstanceDomain = createServerFn({ method: "POST" })
  .validator(updateInstanceDomainInputSchema)
  .handler(({ data }) => updateInstanceDomainHandler(data))

export const removeInstanceDomain = createServerFn({ method: "POST" })
  .validator(removeInstanceDomainInputSchema)
  .handler(({ data }) => removeInstanceDomainHandler(data))
