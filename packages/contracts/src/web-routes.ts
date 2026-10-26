// What a web route answers to and where it sends people, shared by the
// Relay's Traefik configuration and Hearth's tables and headers.

export type WebRouteWww = "none" | "redirect" | "serve"

export interface WebRouteRedirect {
  readonly permanent: boolean
  readonly preservePath: boolean
  readonly to: string
}

interface WebRouteShape {
  readonly hostname: string
  readonly path: string | null
  readonly primary?: boolean
  readonly redirect?: WebRouteRedirect | null
  readonly www?: WebRouteWww
}

// A hostname's www counterpart: www.example.com for example.com, and
// example.com for www.example.com. Null when dropping "www." would leave a
// bare top-level domain.
export function wwwCounterpart(hostname: string): string | null {
  if (hostname.startsWith("www.")) {
    const bare = hostname.slice(4)
    return bare.includes(".") ? bare : null
  }
  return `www.${hostname}`
}

// The hostnames a route serves and the ones it only redirects from. A
// redirect route sends all of them to its destination.
export function webRouteHosts(route: WebRouteShape): {
  readonly aliases: ReadonlyArray<string>
  readonly served: ReadonlyArray<string>
} {
  const counterpart =
    route.www && route.www !== "none" ? wwwCounterpart(route.hostname) : null
  if (!counterpart) return { aliases: [], served: [route.hostname] }
  return route.www === "serve"
    ? { aliases: [], served: [route.hostname, counterpart] }
    : { aliases: [counterpart], served: [route.hostname] }
}

// Every hostname a route answers on.
export function webRouteHostnames(route: WebRouteShape): Array<string> {
  const { aliases, served } = webRouteHosts(route)
  return [...served, ...aliases]
}

// The hostname-and-path pairs a route claims, unique on a Relay.
export function webRouteEndpoints(route: WebRouteShape): Array<string> {
  return webRouteHostnames(route).map(
    (hostname) => `${hostname}${route.path ?? ""}`
  )
}

export function webRouteUrl(route: WebRouteShape): string {
  return `https://${route.hostname}${route.path ?? ""}`
}

// The route people reach a server or app at: the one marked primary, or
// the first that serves it when none is.
export function primaryWebRoute<
  Route extends { readonly primary?: boolean; readonly redirect?: unknown },
>(routes: ReadonlyArray<Route>): Route | undefined {
  const serving = routes.filter((route) => !route.redirect)
  return serving.find((route) => route.primary) ?? serving[0]
}
