import { request as httpRequest } from "node:http"
import type { IncomingHttpHeaders } from "node:http"
import { request as httpsRequest } from "node:https"
import { pipeline, Readable } from "node:stream"

import { relayControlEndpoint } from "@/lib/relay-control-endpoint"
import { kilnPublicUrl } from "@/lib/environment"
import { loadPersistedRelay, loadRelayCredentials } from "@/lib/relay-registry"
import {
  openRelayTunnel,
  relayReachedThroughTunnel,
} from "@/lib/relay-tunnel.server"

// Browser transfers through Hearth: a Relay browsers can't reach directly
// (`hearth` proxy mode, such as one that dials Hearth from behind a home
// router) has its file transfers and backup downloads passed through Hearth
// unchanged, to the same `/v1/browser` routes. The Relay checks each
// request's capability and proof for itself, as it would one sent straight
// to it, so Hearth only carries bytes: it forwards no cookies, and only
// these routes. What it carries is served under Hearth's origin, so it's
// never run as a page there, whatever the Relay says it is.

// `route` is decoded: its name is encoded again for the Relay.
const ROUTE = /^(files|backups)\/([^/]+)$/u
const REQUEST_HEADERS = [
  "authorization",
  "content-length",
  "content-type",
  "if-range",
  "range",
  "x-kiln-nonce",
  "x-kiln-proof",
  "x-kiln-public-key",
  "x-kiln-requested-at",
]
const RESPONSE_HEADERS = [
  "accept-ranges",
  "cache-control",
  "content-disposition",
  "content-encoding",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
  // What a download will weigh, which the browser asks before starting one.
  "x-kiln-compressed-size-estimate",
  "x-kiln-download-max-size",
  "x-kiln-gzip-size-estimate",
  "x-kiln-zip-size-estimate",
]
const NULL_BODY_STATUSES = new Set([204, 205, 304])
const SANDBOX_HEADERS = {
  "content-security-policy": "default-src 'none'; sandbox",
  "x-content-type-options": "nosniff",
}

/**
 * Passes a browser's request for `/v1/browser/<route>` on to the Relay and
 * returns its answer: through a tunnel when the Relay dials Hearth, else
 * straight to the listener Hearth connects to.
 */
export async function passRelayBrowserRequest(
  relayId: string,
  route: string,
  request: Request
): Promise<Response> {
  const [, kind, name] = ROUTE.exec(route) ?? []
  if (!kind || !name || name === "." || name === "..") {
    return Response.json({ error: "Not a Relay transfer" }, { status: 404 })
  }
  const relay = await loadPersistedRelay(relayId)
  if (!relay) return Response.json({ error: "Unknown Relay" }, { status: 404 })
  const control = relayControlEndpoint(relay)
  const throughTunnel = relayReachedThroughTunnel(relay.id)
  const ca =
    !throughTunnel && control.useTls
      ? ((await loadRelayCredentials(relay.id)).caCertificatePem ?? undefined)
      : undefined
  // Opened last, so nothing can fail between here and the request taking it.
  const tunnel = throughTunnel ? await openRelayTunnel(relay) : null
  const url = new URL(request.url)
  const headers: Record<string, string> = {
    // The Relay accepts the origins of the Hearths paired with it.
    origin: kilnPublicUrl().origin,
  }
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value !== null) headers[name] = value
  }
  const send = tunnel || !control.useTls ? httpRequest : httpsRequest
  return new Promise<Response>((resolve, reject) => {
    const outgoing = send(
      {
        ...(tunnel
          ? { createConnection: () => tunnel }
          : {
              ca,
              host: control.hostname,
              port: control.port,
              rejectUnauthorized: control.useTls,
            }),
        headers,
        method: request.method,
        path: `/v1/browser/${kind}/${encodeURIComponent(name)}${url.search}`,
        signal: request.signal,
      },
      (incoming) => {
        const status = incoming.statusCode ?? 0
        // Only answers a Response can carry, so a Relay can't throw here.
        if (status < 200 || status > 599) {
          incoming.destroy()
          resolve(
            Response.json(
              { error: "The Relay answered with an invalid status" },
              { status: 502 }
            )
          )
          return
        }
        const bodyless =
          request.method === "HEAD" || NULL_BODY_STATUSES.has(status)
        if (bodyless) incoming.resume()
        resolve(
          new Response(
            bodyless
              ? null
              : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
            { headers: responseHeaders(incoming.headers), status }
          )
        )
      }
    )
    if (request.body && request.method !== "GET" && request.method !== "HEAD") {
      // An upload that breaks off ends the request to the Relay too.
      pipeline(
        Readable.fromWeb(
          request.body as import("node:stream/web").ReadableStream
        ),
        outgoing,
        (cause) => {
          if (cause) reject(cause)
        }
      )
    } else {
      outgoing.once("error", reject)
      outgoing.end()
    }
  })
}

function responseHeaders(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers(SANDBOX_HEADERS)
  for (const name of RESPONSE_HEADERS) {
    const value = incoming[name]
    if (typeof value === "string") headers.set(name, value)
  }
  return headers
}
