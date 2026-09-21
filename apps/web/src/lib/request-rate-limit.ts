/**
 * Small in-process limiter for unauthenticated server functions that would
 * otherwise let a client probe for account existence or trigger email sends
 * without bound. One Hearth replica runs today; Better Auth's own limiter only
 * covers its routes, not TanStack server functions.
 */
const windows = new Map<string, Array<number>>()
const maximumTrackedKeys = 10_000

export function assertRequestRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now()
): void {
  const cutoff = now - windowMs
  const hits = (windows.get(key) ?? []).filter((at) => at > cutoff)
  if (hits.length >= limit) {
    throw new Error("Too many attempts. Try again in a few minutes.")
  }
  hits.push(now)
  windows.set(key, hits)
  if (windows.size > maximumTrackedKeys) {
    for (const [tracked, stamps] of windows) {
      if (stamps.every((at) => at <= cutoff)) windows.delete(tracked)
      if (windows.size <= maximumTrackedKeys / 2) break
    }
  }
}

/** Client address from the current request, honouring the first proxy hop. */
export async function requestClientAddress(): Promise<string> {
  const { getRequestHeaders } = await import("@tanstack/react-start/server")
  const headers = getRequestHeaders()
  const forwarded = headers.get("x-forwarded-for")
  return (
    forwarded?.split(",")[0]?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    "unknown"
  )
}
