import { createServerFn } from "@tanstack/react-start"
import {
  appIdSchema,
  instanceIdSchema,
  relayAppWebRouteInputsSchema,
  relayIdSchema,
  relayInstanceWebRouteInputsSchema,
} from "@workspace/contracts"
import { z } from "zod"

import {
  domainBlacklistPatternsSchema,
  domainNameSchema,
  vanityLabelSchema,
  webRouteProxySchema,
} from "@/lib/domain-schemas"
import { runOperationPromise } from "@/operations/operation"
import { requireEligibleResourceUser } from "@/server/auth"
import {
  createInstanceDomainHandler,
  getInstanceDomainHandler,
  removeInstanceDomainHandler,
  updateInstanceDomainHandler,
} from "@/server/addresses.server"
import {
  deleteDomainConnectionHandler,
  discoverCloudflareDomainsHandler,
  getDomainSettingsHandler,
  getManualWebHostnamesHandler,
  resyncDomainAssignmentsHandler,
  saveDomainConnectionHandler,
} from "@/server/domain-settings.server"
import {
  adoptWebHostnameRecordHandler,
  checkWebCertificateHandler,
  getResourceWebHostnamesHandler,
  releaseWebHostnameHandler,
} from "@/server/web-hostname-access.server"
import { getWebRoutesHandler, saveWebRoutes } from "@/server/web-routes.server"

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

// The instance whose addresses these are: a game server, unless it says
// it is an App. Both have the same kind of ID.
const instanceDomainInputSchema = z.object({
  instanceId: instanceIdSchema,
  relayId: relayIdSchema,
  resourceType: z.enum(["app", "instance"]).optional(),
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
    resourceId: instanceIdSchema,
    resourceType: z.literal("instance"),
  }),
  z.object({
    relayId: relayIdSchema,
    resourceId: appIdSchema,
    resourceType: z.literal("app"),
  }),
])

// An instance's web routes as they are saved: a game server's, or an
// App's, which each name the service they reach.
const saveWebRoutesInputSchema = z.discriminatedUnion("resourceType", [
  z.object({
    proxy: webRouteProxySchema.optional(),
    relayId: relayIdSchema,
    resourceId: instanceIdSchema,
    resourceType: z.literal("instance"),
    routes: relayInstanceWebRouteInputsSchema,
  }),
  z.object({
    proxy: webRouteProxySchema.optional(),
    relayId: relayIdSchema,
    resourceId: appIdSchema,
    resourceType: z.literal("app"),
    routes: relayAppWebRouteInputsSchema,
  }),
])

const releaseWebHostnameInputSchema = z.object({ id: domainIdSchema })

const adoptWebHostnameRecordInputSchema = z.object({
  id: domainIdSchema,
  /** The record as the person saw it and agreed to hand it over. */
  record: z.object({
    content: z.string().max(255),
    id: z.string().regex(/^[a-f0-9]{32}$/u),
    proxied: z.boolean(),
    type: z.enum(["A", "AAAA", "CNAME"]),
  }),
})

const checkWebCertificateInputSchema = resourceWebHostnamesInputSchema.and(
  z.object({ hostname: z.string().trim().toLowerCase().min(1).max(253) })
)

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
export type AdoptWebHostnameRecordInput = z.infer<
  typeof adoptWebHostnameRecordInputSchema
>
export type CheckWebCertificateInput = z.infer<
  typeof checkWebCertificateInputSchema
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

/**
 * One of an instance's addresses, as its Network page lists them. For a
 * game server's, `address` is what players type and `directAddress` its
 * host and port. For any other, `address` is its name and `directAddress`
 * where its record points.
 */
export interface InstanceAddressOverview extends InstanceDomainOverview {
  /** A game server's address, pointing at its game port. */
  game: boolean
  hostname: string
  id: string
  /** Its instance's main address; one per instance. */
  primary: boolean
  /** Whether a web route answers on it. */
  routed: boolean
}

export interface ManagedDomainOverview {
  address: string
  /** Whether the person may rename or delete it. */
  canManage: boolean
  domain: string
  /** How many domains point at this row's game server. */
  domainCount: number
  hostname: string
  id: string
  instanceId: string
  lastError: string | null
  port: number
  /** The game server's connect address; one per game server. */
  primary: boolean
  relayId: string
  relayName: string
  /** Whether a web route answers on it. */
  routed: boolean
  server: {
    brickId: string | undefined
    game: string | undefined
    implementation: string | undefined
    name: string
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
  /**
   * Whether the person may have Kiln take over its existing record: they
   * may change its routes and own its Cloudflare connection.
   */
  canAdopt: boolean
  /** Whether the person may release it. */
  canManage: boolean
  /** The connection's name, when it's one the person sees. */
  connectionName: string | null
  /**
   * While `external`, the one address record Cloudflare already had, as
   * Kiln last saw it; null when it had none, or several.
   */
  existingRecord: {
    content: string
    id: string
    proxied: boolean
    type: "A" | "AAAA" | "CNAME"
  } | null
  /**
   * An App's own address, made for it or added, which it keeps without a
   * route. The rest follow the routes that answer on them.
   */
  generated: boolean
  hostname: string
  id: string
  lastError: string | null
  /** Its instance's main address, for one of its own (`generated`). */
  primary: boolean
  /** Through Cloudflare's proxy; null when Kiln doesn't know. */
  proxied: boolean | null
  /** Used by a web route, so it goes with the route. */
  routed: boolean
  relayId: string
  relayName: string
  resource:
    | {
        id: string
        kind: "app"
        name: string
      }
    | {
        brickId: string | undefined
        id: string
        implementation: string | undefined
        kind: "server"
        name: string
      }
  /** What its certificate waits for; null once it has one. */
  certificate: WebHostnameCertificate | null
  /** `manual`: on no connected domain, so its owner points it by hand. */
  status: "active" | "error" | "external" | "manual" | "pending" | "removing"
  /** The Relay address its record points at. */
  target: string | null
  /** Named under a vanity domain. */
  vanity: boolean
  /** The Cloudflare zone, for its dashboard link. */
  zoneName: string | null
}

/**
 * What a web route hostname's certificate waits for, as its Relay's bundled
 * Traefik last said. None waits on a Relay behind another proxy, which
 * keeps its own certificates.
 */
export interface WebHostnameCertificate {
  /** A check or a request already failed, so the Relay is retrying. */
  failed: boolean
  /** `dns`: its name doesn't resolve yet. */
  waitingFor: "certificate" | "dns"
}

/** What checking a hostname's certificate now found. */
export interface WebCertificateCheck {
  /** Whether its Relay had Traefik ask Let's Encrypt; its limits may not allow. */
  asked: boolean
  /** What it still waits for; null once it has a certificate. */
  certificate: WebHostnameCertificate | null
}

/** A game server's or app's web hostnames, for its network page. */
export interface ResourceWebHostnames {
  /** Whether the person may change its routes. */
  canChange: boolean
  /** Its web route hostnames still waiting on a certificate. */
  certificates: Array<WebHostnameCertificate & { hostname: string }>
  /** The DNS records Kiln keeps for them. */
  hostnames: Array<ResourceWebHostname>
}

/** A web hostname as a game server's or app's network page shows it. */
export interface ResourceWebHostname {
  /** Its existing record can be handed to Kiln by this person. */
  canAdopt: boolean
  canRelease: boolean
  /** The record `canAdopt` would hand over. */
  existingRecord: WebHostnameOverview["existingRecord"]
  /** An address of the instance's own, made for it or added. */
  generated: boolean
  hostname: string
  id: string
  lastError: string | null
  /** The record `canAdopt` would hand over already points at the Relay. */
  pointsAtRelay: boolean
  /** Its instance's main address, for one of its own (`generated`). */
  primary: boolean
  /** Through Cloudflare's proxy; null when Kiln doesn't know. */
  proxied: boolean | null
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

/** An instance's web routes, and whether its Relay's proxy serves them. */
export const getWebRoutes = createServerFn({ method: "GET" })
  .validator(resourceWebHostnamesInputSchema)
  .handler(async ({ data }) =>
    getWebRoutesHandler(await requireEligibleResourceUser(), data)
  )

export const updateWebRoutes = createServerFn({ method: "POST" })
  .validator(saveWebRoutesInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(saveWebRoutes, data, {
      user: await requireEligibleResourceUser(),
    })
  )

export const getResourceWebHostnames = createServerFn({ method: "GET" })
  .validator(resourceWebHostnamesInputSchema)
  .handler(({ data }) => getResourceWebHostnamesHandler(data))

/** Has the hostname's Relay check its name and certificate again now. */
export const checkWebCertificate = createServerFn({ method: "POST" })
  .validator(checkWebCertificateInputSchema)
  .handler(({ data }) => checkWebCertificateHandler(data))

export const releaseWebHostname = createServerFn({ method: "POST" })
  .validator(releaseWebHostnameInputSchema)
  .handler(({ data }) => releaseWebHostnameHandler(data))

/** Has Kiln take over the record Cloudflare already had for a hostname. */
export const adoptWebHostnameRecord = createServerFn({ method: "POST" })
  .validator(adoptWebHostnameRecordInputSchema)
  .handler(({ data }) => adoptWebHostnameRecordHandler(data))
