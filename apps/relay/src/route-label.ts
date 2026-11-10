const COLLECTION_ROUTES = new Set([
  "/v1/snapshot",
  "/v1/bricks",
  "/v1/networking",
  "/v1/instances",
])

export function normalizedRoute(pathname: string): string {
  if (COLLECTION_ROUTES.has(pathname)) {
    return pathname.slice(1).replaceAll("/", ".")
  }

  const match = pathname.match(
    /^\/v1\/instances\/[^/]+(?:\/(tree|file|actions|resources|console|console-completions|console-stream|ports|web-routes|startup))?$/u
  )
  if (!match) return "unknown"
  return match[1] ? `v1.instances.${match[1]}` : "v1.instances.instance"
}
