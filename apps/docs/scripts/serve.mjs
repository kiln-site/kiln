import { fileURLToPath } from "node:url"

import { serve } from "srvx/node"
import { staticMiddleware } from "srvx/static"

import { docsRedirect } from "./redirects.mjs"

const { default: app } = await import("../dist/server/server.js")

if (!app || typeof app.fetch !== "function") {
  throw new Error("The Kiln docs' server handler could not be loaded")
}

// The base path the docs were built for (KILN_DOCS_BASE_PATH), like "/docs".
// Built files sit at the root of dist/client, so a request's base comes off
// before looking for one.
const trimmedBase = (process.env.KILN_DOCS_BASE_PATH ?? "/docs").replace(
  /^\/+|\/+$/g,
  ""
)
const basePath = trimmedBase ? `/${trimmedBase}` : ""
const serveStatic = staticMiddleware({
  dir: fileURLToPath(new URL("../dist/client", import.meta.url)),
})

function redirects(request, next) {
  const location = docsRedirect(new URL(request.url), basePath)
  return location
    ? new Response(null, { status: 308, headers: { Location: location } })
    : next()
}

async function staticFiles(request, next) {
  const url = new URL(request.url)
  if (basePath && !url.pathname.startsWith(`${basePath}/`)) return next()
  url.pathname = url.pathname.slice(basePath.length)
  const response = await serveStatic(new Request(url, request), next)
  // Built assets carry a content hash in their name, so they never change.
  if (
    response.ok &&
    (request.method === "GET" || request.method === "HEAD") &&
    url.pathname.startsWith("/assets/")
  ) {
    response.headers.set("Cache-Control", "public, max-age=31536000, immutable")
  }
  return response
}

const server = serve({
  ...app,
  hostname: process.env.HOST || "0.0.0.0",
  middleware: [redirects, staticFiles],
  port: process.env.PORT || 3000,
})

await server.ready()
