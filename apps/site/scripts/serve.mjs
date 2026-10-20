import { fileURLToPath } from "node:url"

import { serve } from "srvx/node"
import { staticMiddleware } from "srvx/static"

const { default: app } = await import("../dist/server/server.js")

if (!app || typeof app.fetch !== "function") {
  throw new Error("The Kiln site's server handler could not be loaded")
}

// Built assets carry a content hash in their name, so they never change.
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

const server = serve({
  ...app,
  hostname: process.env.HOST || "0.0.0.0",
  middleware: [
    cacheImmutableAssets,
    staticMiddleware({
      dir: fileURLToPath(new URL("../dist/client", import.meta.url)),
    }),
  ],
  port: process.env.PORT || 3000,
})

await server.ready()
