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

// kiln.site/docs is the docs app (apps/docs), a separate image built to live
// under /docs. With KILN_DOCS_ORIGIN set, like http://docs:3000, this server
// passes /docs through to it; without it, something in front routes /docs.
const docsOrigin = process.env.KILN_DOCS_ORIGIN?.trim()

async function proxyDocs(request, next) {
  const url = new URL(request.url)
  if (
    !docsOrigin ||
    (url.pathname !== "/docs" && !url.pathname.startsWith("/docs/"))
  ) {
    return next()
  }
  const headers = new Headers(request.headers)
  headers.set("x-forwarded-host", url.host)
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""))
  headers.delete("host")
  const response = await fetch(new URL(url.pathname + url.search, docsOrigin), {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
    duplex: "half",
    redirect: "manual",
  })
  // fetch has already decompressed the body.
  const responseHeaders = new Headers(response.headers)
  responseHeaders.delete("content-encoding")
  responseHeaders.delete("content-length")
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  })
}

const server = serve({
  ...app,
  hostname: process.env.HOST || "0.0.0.0",
  middleware: [
    proxyDocs,
    cacheImmutableAssets,
    staticMiddleware({
      dir: fileURLToPath(new URL("../dist/client", import.meta.url)),
    }),
  ],
  port: process.env.PORT || 3000,
})

await server.ready()
