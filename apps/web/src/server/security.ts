import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import {
  securityImageIdSchema,
  relayIdSchema,
  appIdSchema,
} from "@workspace/contracts"

import { securityScopeSchema } from "@/lib/security"
import {
  getResourceSecurityHandler,
  getSecurityPackagesHandler,
  getSecurityImageVersionsHandler,
  getSecurityOverviewHandler,
  getSecurityScanSettingsHandler,
  scanSecurityNowHandler,
  setSecurityScansPausedHandler,
} from "@/server/security.server"

const scopeInputSchema = z.strictObject({
  scope: securityScopeSchema.nullable(),
})

const overviewInputSchema = scopeInputSchema.extend({
  // A Relay's own host and services, rather than everything on it.
  own: z.boolean().optional(),
})

/** What Kiln found in everything the user can see, or in one scope. */
export const getSecurityOverview = createServerFn({ method: "GET" })
  .validator(overviewInputSchema)
  .handler(({ data }) => getSecurityOverviewHandler(data))

/** What one resource's page says about its vulnerabilities. */
export const getResourceSecurity = createServerFn({ method: "GET" })
  .validator(z.strictObject({ scope: securityScopeSchema }))
  .handler(({ data }) => getResourceSecurityHandler(data))

/** One image's or host's packages, asked for when someone opens it. */
export const getSecurityPackages = createServerFn({ method: "GET" })
  .validator(
    z.strictObject({
      relayId: relayIdSchema,
      sbomKey: z.union([z.literal("host"), securityImageIdSchema]),
    })
  )
  .handler(({ data }) => getSecurityPackagesHandler(data))

/** Newer versions of an image app's image, to move it to. */
export const getSecurityImageVersions = createServerFn({ method: "GET" })
  .validator(z.strictObject({ appId: appIdSchema, relayId: relayIdSchema }))
  .handler(({ data }) => getSecurityImageVersionsHandler(data))

export const scanSecurityNow = createServerFn({ method: "POST" })
  .validator(scopeInputSchema)
  .handler(({ data }) => scanSecurityNowHandler(data))

/** Whether scans are paused across Kiln, and whether the viewer may change it. */
export const getSecurityScanSettings = createServerFn({
  method: "GET",
}).handler(() => getSecurityScanSettingsHandler())

/** Pauses every scan on every Relay, stopping those running, or resumes them. */
export const setSecurityScansPaused = createServerFn({ method: "POST" })
  .validator(z.strictObject({ paused: z.boolean() }))
  .handler(({ data }) => setSecurityScansPausedHandler(data))
