import {
  relayAppWebRouteInputsSchema,
  type RelayInstanceWebRoute,
} from "@workspace/contracts"

import type { RelayStoredWebRoute } from "./effect/state.js"
import { appRouteOwner } from "./relay-resources.js"
import { assignRelayWebRouteIds, webRouteCollision } from "./web-route-ids.js"

// A new App's address serves nothing until a route sends it somewhere. When
// nothing said where its website answers, its first deployment can: the
// image says which ports it listens on, once it is pulled or built, and
// before its container is made, so the route is on that container from the
// start.

// Ports an image exposes that are never the website Kiln would route to:
// other protocols' well-known ports, and 443, since Kiln reaches a service
// over plain HTTP.
const notAWebsite = new Set([
  21, 22, 23, 25, 53, 110, 143, 389, 443, 465, 587, 636, 993, 995, 1433, 1521,
  1883, 2375, 2376, 3306, 5432, 5672, 6379, 9042, 9092, 11211, 27017,
])

/**
 * The port an image's website answers on, read from the ports it exposes:
 * the only TCP port among them that could be one. Null when it exposes
 * none, or several, since which of several it is can't be told from here.
 */
export function imageWebPort(
  exposed: Readonly<Record<string, unknown>> | null | undefined
): number | null {
  const ports = Object.keys(exposed ?? {}).flatMap((key) => {
    const [, number, protocol = "tcp"] =
      /^(\d{1,5})(?:\/([a-z]+))?$/u.exec(key) ?? []
    const port = Number(number)
    return protocol === "tcp" &&
      port >= 1 &&
      port <= 65_535 &&
      !notAWebsite.has(port)
      ? [port]
      : []
  })
  const [port, another] = [...new Set(ports)]
  return port !== undefined && another === undefined ? port : null
}

/** What routing an App's address needs of the Relay around it. */
export interface AppAddressRoutes {
  /** Applies every route on the Relay to its proxy. */
  readonly configure: (
    routes: ReadonlyArray<RelayStoredWebRoute>
  ) => Promise<void>
  /** Every route on the Relay. */
  readonly list: () => Promise<ReadonlyArray<RelayStoredWebRoute>>
  /** Runs a change to the Relay's routes holding them. */
  readonly locked: <T>(label: string, change: () => Promise<T>) => Promise<T>
  readonly replace: (
    owner: string,
    routes: ReadonlyArray<RelayInstanceWebRoute & { service?: string }>
  ) => Promise<void>
}

/**
 * Routes an App's own address to its website, as the first route it has.
 * It leaves an App that has any route alone: those are whatever its owner
 * gave it. Says whether it made the route.
 */
export const routeAppAddress =
  (routes: AppAddressRoutes) =>
  (
    appId: string,
    hostname: string,
    target: { readonly port: number; readonly service: string }
  ): Promise<boolean> =>
    routes.locked("app.deploy.address", async () => {
      const owner = appRouteOwner(appId)
      const configured = await routes.list()
      if (configured.some((route) => route.instanceId === owner)) return false
      const first = assignRelayWebRouteIds(
        owner,
        relayAppWebRouteInputsSchema.parse([
          {
            hostname,
            path: null,
            primary: true,
            service: target.service,
            targetPort: target.port,
          },
        ]),
        configured
      )
      // Another instance took the name meanwhile: theirs stays.
      if (webRouteCollision(owner, first, configured)) return false
      await routes.replace(owner, first)
      await routes.configure(await routes.list())
      return true
    })
