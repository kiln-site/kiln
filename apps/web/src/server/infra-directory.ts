import { createServerFn } from "@tanstack/react-start"
import { getRequest, setResponseHeader } from "@tanstack/react-start/server"
import { Schema } from "effect"

import { runAppEffect } from "@/effect/runtime"
import { resolveServerNavigation } from "@/lib/server-navigation"
import { requireEligibleResourceUser } from "@/server/auth"
import {
  readInfraRelayOptions,
  readInfraServerDirectory,
} from "@/server/infra-directory.server"

export const getInfraServerDirectory = createServerFn({
  method: "GET",
}).handler(async () => {
  const user = await requireEligibleResourceUser()
  setResponseHeader("Cache-Control", "no-store")
  return runAppEffect(
    "Infra.directory.servers",
    readInfraServerDirectory(user),
    { signal: getRequest().signal }
  )
})

const serverNavigationInput = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.Struct({ serverId: Schema.String }),
    Schema.Struct({ selectedRouteId: Schema.NullOr(Schema.String) }),
  ])
)

/**
 * The game server the sidebar opens and how many the user can reach. Pages
 * load this instead of the whole directory, so their HTML does not grow with
 * every game server the user can see.
 */
export const getServerNavigation = createServerFn({ method: "GET" })
  .validator(serverNavigationInput)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    setResponseHeader("Cache-Control", "no-store")
    const instances = await runAppEffect(
      "Infra.directory.servers",
      readInfraServerDirectory(user),
      { signal: getRequest().signal }
    )
    return resolveServerNavigation(instances, data)
  })

export const getInfraRelayOptions = createServerFn({ method: "GET" })
  .validator(Schema.decodeUnknownSync(Schema.Literals(["app", "database"])))
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    setResponseHeader("Cache-Control", "no-store")
    return runAppEffect("Infra.directory", readInfraRelayOptions(user, data), {
      signal: getRequest().signal,
    })
  })
