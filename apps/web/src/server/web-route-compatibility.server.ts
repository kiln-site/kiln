import { relayWebRouteOptionsV1Feature } from "@workspace/contracts"
import type { RelayInstanceWebRouteInput } from "@workspace/contracts"

import { relayConnectionFeatures } from "@/lib/relay-connection"

// Routes as the Relay accepts them. One that predates route options takes
// neither the options nor a route without a name, so it gets the name of
// the hostname and loses only which route is primary.
export function webRoutesForRelay<Route extends RelayInstanceWebRouteInput>(
  relayId: string,
  routes: ReadonlyArray<Route>
): ReadonlyArray<unknown> {
  if (relayConnectionFeatures(relayId).has(relayWebRouteOptionsV1Feature)) {
    return routes
  }
  if (
    routes.some(
      (route) => route.redirect || route.www !== "none" || !route.httpsRedirect
    )
  ) {
    throw new Error(
      "Update this Relay to use www, redirects, or plain HTTP on its routes."
    )
  }
  return routes.map(
    ({
      httpsRedirect: _httpsRedirect,
      primary: _primary,
      redirect: _redirect,
      www: _www,
      ...route
    }) => ({ ...route, name: route.name || route.hostname.slice(0, 32) })
  )
}
