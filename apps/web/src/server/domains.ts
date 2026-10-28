import { createServerFn } from "@tanstack/react-start"
import { appIdSchema, relayIdSchema } from "@workspace/contracts"
import { z } from "zod"

import {
  domainBlacklistPatternsSchema,
  domainNameSchema,
  vanityLabelSchema,
} from "@/lib/domain-schemas"
import {
  createInstanceDomainHandler,
  getInstanceDomainHandler,
  removeInstanceDomainHandler,
  updateInstanceDomainHandler,
} from "@/server/domains.server"
import {
  deleteDomainConnectionHandler,
  discoverCloudflareDomainsHandler,
  getDomainSettingsHandler,
  getManualWebHostnamesHandler,
  resyncDomainAssignmentsHandler,
  saveDomainConnectionHandler,
} from "@/server/domain-settings.server"
import {
  getResourceWebHostnamesHandler,
  releaseWebHostnameHandler,
} from "@/server/web-hostname-access.server"

const apiTokenSchema = z.string().trim().min(20).max(512)
const zoneIdSchema = z.string().regex(/^[a-f0-9]{32}$/u)
const domainIdSchema = z.uuid()
const connectionIdSchema = z.string().regex(/^[a-z0-9]{1,32}$/u)

const saveDomainConnectionInputSchema = z.object({
  apiToken: apiTokenSchema.optional(),
  /** A shared connection's reserved names; omitted to keep them. */
  blacklistPatterns: domainBlacklistPatternsSchema.optional(),
  /** Omitted when none of this connection's domains is the default. */
  defaultDomain: domainNameSchema.optional(),
  /** Its vanity domains; empty to only manage web route records. */
  domains: z
    .array(z.object({ domain: domainNameSchema, zoneId: zoneIdSchema }))
    .max(50),
  /** Omitted for a new connection. */
  id: connectionIdSchema.optional(),
  name: z.string().trim().min(1, "Name this connection").max(64),
  /** A new shared connection, by a platform administrator. */
  platform: z.boolean().default(false),
})

const deleteDomainConnectionInputSchema = z.object({ id: connectionIdSchema })

const discoverDomainsInputSchema = z.object({
  apiToken: apiTokenSchema.optional(),
  /** A saved connection whose token to use when none is pasted. */
  connectionId: connectionIdSchema.optional(),
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

const resourceWebHostnamesInputSchema = z.discriminatedUnion("resourceType", [
  z.object({
    relayId: relayIdSchema,
    resourceId: z.string().regex(/^[a-f0-9]{40}$/u),
    resourceType: z.literal("instance"),
  }),
  z.object({
    relayId: relayIdSchema,
    resourceId: appIdSchema,
    resourceType: z.literal("app"),
  }),
])

const releaseWebHostnameInputSchema = z.object({ id: domainIdSchema })

export type SaveDomainConnectionInput = z.infer<
  typeof saveDomainConnectionInputSchema
>
export type DeleteDomainConnectionInput = z.infer<
  typeof deleteDomainConnectionInputSchema
>
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
export type ResourceWebHostnamesInput = z.infer<
  typeof resourceWebHostnamesInputSchema
>
export type ReleaseWebHostnameInput = z.infer<
  typeof releaseWebHostnameInputSchema
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
  /** Whether the person may rename or delete it. */
  canManage: boolean
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

/** A web route hostname, and the DNS record Kiln keeps for it, if any. */
export interface WebHostnameOverview {
  /** Whether the person may release it. */
  canManage: boolean
  /** The connection's name, when it's one the person sees. */
  connectionName: string | null
  /** Kiln's generated address for an app. */
  generated: boolean
  hostname: string
  id: string
  lastError: string | null
  /** Used by a web route, so it goes with the route. */
  routed: boolean
  relayId: string
  relayName: string
  resource:
    | {
        id: string
        kind: "app"
        name: string
        /** The `/app/$appId` param. */
        routeId: string
      }
    | {
        brickId: string | undefined
        id: string
        implementation: string | undefined
        kind: "server"
        name: string
        /** The `/server/$serverId` param. */
        routeId: string
      }
  /** `manual`: on no connected domain, so its owner points it by hand. */
  status: "active" | "error" | "external" | "manual" | "pending" | "removing"
  /** The Relay address its record points at. */
  target: string | null
  /** Named under a vanity domain. */
  vanity: boolean
  /** The Cloudflare zone, for its dashboard link. */
  zoneName: string | null
}

/** A web hostname as a game server's or app's network page shows it. */
export interface ResourceWebHostname {
  canRelease: boolean
  generated: boolean
  hostname: string
  id: string
  lastError: string | null
  status: Exclude<WebHostnameOverview["status"], "manual">
}

export interface DiscoveredCloudflareZone {
  id: string
  name: string
}

export const getDomainSettings = createServerFn({ method: "GET" }).handler(() =>
  getDomainSettingsHandler()
)

export const getManualWebHostnames = createServerFn({ method: "GET" }).handler(
  () => getManualWebHostnamesHandler()
)

// POST, so a pasted token travels in the body rather than a URL.
export const discoverCloudflareDomains = createServerFn({ method: "POST" })
  .validator(discoverDomainsInputSchema)
  .handler(({ data }) => discoverCloudflareDomainsHandler(data))

export const saveDomainConnection = createServerFn({ method: "POST" })
  .validator(saveDomainConnectionInputSchema)
  .handler(({ data }) => saveDomainConnectionHandler(data))

export const deleteDomainConnection = createServerFn({ method: "POST" })
  .validator(deleteDomainConnectionInputSchema)
  .handler(({ data }) => deleteDomainConnectionHandler(data))

export const resyncDomainAssignments = createServerFn({
  method: "POST",
}).handler(() => resyncDomainAssignmentsHandler())

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

export const getResourceWebHostnames = createServerFn({ method: "GET" })
  .validator(resourceWebHostnamesInputSchema)
  .handler(({ data }) => getResourceWebHostnamesHandler(data))

export const releaseWebHostname = createServerFn({ method: "POST" })
  .validator(releaseWebHostnameInputSchema)
  .handler(({ data }) => releaseWebHostnameHandler(data))
