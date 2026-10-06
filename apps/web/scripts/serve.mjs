import { fileURLToPath } from "node:url"

import { Cause, Effect } from "effect"
import { serve } from "srvx/node"
import { loggerMiddleware } from "srvx/log"
import { staticMiddleware } from "srvx/static"

const HEALTH_PATH = "/api/health"
const SERVER_FN_PATH = "/_serverFn/"
const QUIET_REQUEST_PURPOSE_HEADER = "x-kiln-request-purpose"
const RELAY_POLL_PURPOSE = "relay-poll"
const appModule = await import("../dist/server/server.js")
const app = appModule.default
const logRequest = loggerMiddleware()

if (!app || typeof app.fetch !== "function") {
  throw new Error("Kiln's production server handler could not be loaded")
}

const server = serve({
  ...app,
  error(error) {
    console.error(error)
    return new Response(
      "<!doctype html><html><head><title>Server Error</title></head><body><h1>Server Error</h1><p>Something went wrong while processing your request.</p></body></html>",
      {
        headers: { "Content-Type": "text/html; charset=utf-8" },
        status: 500,
      }
    )
  },
  gracefulShutdown: false,
  hostname: process.env.HOST || "0.0.0.0",
  middleware: [
    logUnlessSuccessfulQuietRequest,
    cacheImmutableAssets,
    staticMiddleware({
      dir: fileURLToPath(new URL("../dist/client", import.meta.url)),
    }),
    ...(app.middleware ?? []),
  ],
  port: process.env.PORT || 3000,
})

await server.ready()

const shutdownHearth = Effect.fn("hearth.shutdown")(function* () {
  yield* Effect.tryPromise(() => server.close(true))
  yield* Effect.tryPromise(async () => {
    await appModule.shutdownHearth?.()
  })
})

let shuttingDown = false
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    void shutdown(signal)
  })
}

function shutdown(signal) {
  const exitCode = shutdownHearth().pipe(
    Effect.timeout("10 seconds"),
    Effect.matchCause({
      onFailure(cause) {
        console.error(
          `Failed to shut Hearth down after ${signal}`,
          Cause.squash(cause)
        )
        return 1
      },
      onSuccess: () => 0,
    })
  )
  void Effect.runPromise(exitCode).then((code) => process.exit(code))
}

async function cacheImmutableAssets(request, next) {
  const pathname = new URL(request.url).pathname
  const response = await next()
  if (
    response.ok &&
    (request.method === "GET" || request.method === "HEAD") &&
    pathname.startsWith("/assets/")
  ) {
    response.headers.set("Cache-Control", "public, max-age=31536000, immutable")
  }
  return response
}

async function logUnlessSuccessfulQuietRequest(request, next) {
  const pathname = new URL(request.url).pathname
  const isHealthCheck = pathname === HEALTH_PATH
  const isRelayPoll =
    request.method === "GET" &&
    pathname.startsWith(SERVER_FN_PATH) &&
    request.headers.get(QUIET_REQUEST_PURPOSE_HEADER) === RELAY_POLL_PURPOSE

  if (!isHealthCheck && !isRelayPoll) {
    return logRequest(request, next)
  }

  const startedAt = performance.now()
  const response = await next()
  if (!response.ok) {
    const duration = (performance.now() - startedAt).toFixed(2)
    console.error(
      `[${new Date().toLocaleTimeString()}] ${request.method} ${request.url} [${response.status}] (${duration}ms)`
    )
  }
  return response
}
