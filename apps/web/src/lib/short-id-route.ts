export type ShortIdRouteResolution<T> =
  | { status: "found"; resource: T }
  | { status: "ambiguous" }
  | { status: "not-found" }

const SHORT_ID_LENGTH = 8

// Databases, apps, and Relays route by their short ID, like servers. The full
// ID always works and becomes the canonical form only when two resources share
// a short ID.
export function resolveShortIdRoute<T extends { id: string }>(
  resources: ReadonlyArray<T>,
  routeId: string | null | undefined
): ShortIdRouteResolution<T> {
  if (!routeId) return { status: "not-found" }
  const exact = resources.find((resource) => resource.id === routeId)
  if (exact) return { status: "found", resource: exact }
  if (routeId.length !== SHORT_ID_LENGTH) return { status: "not-found" }
  const matches = resources.filter((resource) =>
    resource.id.startsWith(routeId)
  )
  if (matches.length > 1) return { status: "ambiguous" }
  return matches[0]
    ? { status: "found", resource: matches[0] }
    : { status: "not-found" }
}

export function shortIdRouteIdentifier(
  resources: ReadonlyArray<{ id: string }>,
  resource: { id: string }
): string {
  const shortId = resource.id.slice(0, SHORT_ID_LENGTH)
  const shared = resources.some(
    (candidate) =>
      candidate.id !== resource.id && candidate.id.startsWith(shortId)
  )
  return shared ? resource.id : shortId
}

// The sidebar remembers its selection in one cookie. Databases, apps, and
// Relays carry a prefix so server route resolution never matches them.
export function shortIdRouteSelection(prefix: "app" | "db" | "relay") {
  const marker = `${prefix}:`
  return {
    fromSelection(selection: string | null | undefined): string | null {
      return selection?.startsWith(marker)
        ? selection.slice(marker.length)
        : null
    },
    toSelection(routeId: string): string {
      return `${marker}${routeId}`
    },
  }
}
