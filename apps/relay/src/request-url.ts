import type { IncomingMessage, Server } from "node:http"

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

/**
 * Answers WebSocket upgrades whose target cannot be parsed, which the socket
 * upgrade listeners ignore, with 400 and closes the connection.
 */
export function rejectMalformedUpgrades(server: Server): void {
  server.on("upgrade", (request: IncomingMessage, socket) => {
    if (requestUrl(request)) return
    // Upgraded sockets have no server error listener and allow half-open
    // connections, so destroy once the response is flushed.
    socket.on("error", () => socket.destroy())
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n", () =>
      socket.destroy()
    )
  })
}
