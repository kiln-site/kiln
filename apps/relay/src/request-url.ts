import type { IncomingMessage } from "node:http"

const requestBase = "http://relay"

/**
 * Parses a request target without throwing. Node accepts targets such as
 * `//%` that `new URL()` rejects; a synchronous throw from a request or
 * upgrade listener would take the whole Relay down.
 */
export function requestUrl(request: IncomingMessage): URL | null {
  const target = request.url ?? "/"
  return URL.canParse(target, requestBase) ? new URL(target, requestBase) : null
}
