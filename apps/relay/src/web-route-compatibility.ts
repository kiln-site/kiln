import { relayWebRouteOptionsV1Feature } from "@workspace/contracts"
import type {
  RelayInstanceWebRoute,
  RelayInstanceWebRouteInput,
} from "@workspace/contracts"

type Route = RelayInstanceWebRoute & { readonly service?: string }
type RouteInput = RelayInstanceWebRouteInput & { readonly service?: string }

// A Hearth that predates route options reads routes in the shape it knows:
// each named, with a port, and without the options. It can't show a
// redirect, so it doesn't see one.
export function webRoutesForHearth<Shown extends Route>(
  hearthFeatures: ReadonlySet<string>,
  routes: ReadonlyArray<Shown>
): ReadonlyArray<unknown> {
  if (hearthFeatures.has(relayWebRouteOptionsV1Feature)) return routes
  return routes.flatMap(
    ({
      httpsRedirect: _httpsRedirect,
      primary: _primary,
      redirect,
      www: _www,
      ...route
    }) =>
      redirect ? [] : [{ ...route, name: route.name || legacyRouteName(route) }]
  )
}

// What a Hearth that predates route options saves: its routes keep the
// options it never saw, and the redirects it couldn't show stay.
export function webRoutesFromHearth<Input extends RouteInput>(
  hearthFeatures: ReadonlySet<string>,
  routes: ReadonlyArray<Input>,
  saved: ReadonlyArray<Route & { readonly instanceId?: string }>
): Array<RouteInput> {
  if (hearthFeatures.has(relayWebRouteOptionsV1Feature)) return [...routes]
  const byId = new Map(saved.map((route) => [route.id, route]))
  const kept = routes.map((route) => {
    const previous = route.id === undefined ? undefined : byId.get(route.id)
    if (!previous || previous.redirect) return route
    return {
      ...route,
      httpsRedirect: previous.httpsRedirect,
      // The name it was shown in place of no label is still no label.
      name:
        route.name === legacyRouteName(previous) && !previous.name
          ? ""
          : route.name,
      primary: previous.primary,
      www: previous.www,
    }
  })
  const listed = new Set(routes.map((route) => route.id))
  const redirects = saved.flatMap(({ instanceId: _instanceId, ...route }) =>
    route.redirect && !listed.has(route.id) ? [route] : []
  )
  return [...kept, ...redirects]
}

function legacyRouteName(route: { readonly hostname: string }): string {
  return route.hostname.slice(0, 32)
}
