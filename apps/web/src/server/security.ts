import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import { securityScopeSchema } from "@/lib/security"
import {
  getResourceSecurityHandler,
  getSecurityOverviewHandler,
  scanSecurityNowHandler,
} from "@/server/security.server"

const scopeInputSchema = z.strictObject({
  scope: securityScopeSchema.nullable(),
})

/** What Kiln found in everything the user can see, or in one scope. */
export const getSecurityOverview = createServerFn({ method: "GET" })
  .validator(scopeInputSchema)
  .handler(({ data }) => getSecurityOverviewHandler(data))

/** What one resource's page says about its vulnerabilities. */
export const getResourceSecurity = createServerFn({ method: "GET" })
  .validator(z.strictObject({ scope: securityScopeSchema }))
  .handler(({ data }) => getResourceSecurityHandler(data))

export const scanSecurityNow = createServerFn({ method: "POST" })
  .validator(scopeInputSchema)
  .handler(({ data }) => scanSecurityNowHandler(data))
