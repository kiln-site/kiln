import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import { Effect } from "effect"

import { requestUrl } from "./request-url.js"

// Docker's HEALTHCHECK runs inside the Relay's network namespace, so the
// probe listener never needs to leave loopback.
const healthHost = "127.0.0.1"

/** Answers `GET|HEAD /health` and reports whether the request was handled. */
export function handleHealthRequest(
  request: IncomingMessage,
  response: ServerResponse
): boolean {
  const method = request.method ?? "GET"
  if (method !== "GET" && method !== "HEAD") return false
  if (requestUrl(request)?.pathname !== "/health") return false
  response.writeHead(204, { "Cache-Control": "no-store" }).end()
  return true
}

/**
 * Starts the loopback-only, plain-HTTP listener used by the image's native
 * healthcheck binary, so the probe works regardless of the main listener's TLS
 * mode. It serves `/health` and nothing else.
 */
export function listenRelayHealthServerEffect(
  port: number
): Effect.Effect<Server, Error> {
  return Effect.callback<Server, Error>((resume) => {
    const server = createServer((request, response) => {
      if (handleHealthRequest(request, response)) return
      response.writeHead(404, { "Cache-Control": "no-store" }).end()
    })
    server.headersTimeout = 5_000
    server.requestTimeout = 5_000
    server.keepAliveTimeout = 1_000
    const failed = (cause: NodeJS.ErrnoException) => {
      resume(
        Effect.fail(
          new Error(
            cause.code === "EADDRINUSE"
              ? `Relay health listener could not bind ${healthHost}:${port} because it is already in use. Set KILN_RELAY_HEALTH_PORT to a free port.`
              : `Relay health listener could not bind ${healthHost}:${port}`,
            { cause }
          )
        )
      )
    }
    server.once("error", failed)
    server.listen(port, healthHost, () => {
      server.off("error", failed)
      server.unref()
      resume(Effect.succeed(server))
    })
    return Effect.sync(() => {
      server.off("error", failed)
      if (server.listening) server.close()
    })
  })
}
