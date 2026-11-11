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

// Ports a container listens on that are never the website Kiln would route
// to: other protocols' well-known ports, and 443, since Kiln reaches a
// service over plain HTTP.
const notAWebsite = new Set([
  21, 22, 23, 25, 53, 110, 143, 389, 443, 465, 587, 636, 993, 995, 1433, 1521,
  1883, 2375, 2376, 3306, 5432, 5672, 6379, 9042, 9092, 11211, 27017,
])

/**
 * The ports among those a container listens on, over TCP, that could be a
 * website's, lowest first. They are only ever offered, one or several: a
 * port a container listens on isn't known to be a website, or meant to be
 * public, until someone picks it.
 */
export function webPortCandidates(ports: Iterable<number>): Array<number> {
  return [...new Set(ports)]
    .filter(
      (port) =>
        Number.isInteger(port) &&
        port >= 1 &&
        port <= 65_535 &&
        !notAWebsite.has(port)
    )
    .sort((left, right) => left - right)
}
