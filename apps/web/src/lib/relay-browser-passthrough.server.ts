import { request as httpRequest } from "node:http"
import type { IncomingHttpHeaders } from "node:http"
import { request as httpsRequest } from "node:https"
import { pipeline, Readable } from "node:stream"

import { tapPromiseError } from "@/effect/promise"
import { relayControlEndpoint } from "@/lib/relay-control-endpoint"
import { kilnPublicUrl } from "@/lib/environment"
import { acquirePassthroughSlot } from "@/lib/relay-passthrough-limits.server"
import { checkBrowserTicket } from "@/lib/relay-passthrough-tickets.server"
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
//
// Before Hearth spends anything on a request, it checks the credential it
// carries is one Hearth signed for this Relay
// (relay-passthrough-tickets.server.ts), then waits its turn among the
// transfers it carries (relay-passthrough-limits.server.ts).

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
  const credentials = await loadRelayCredentials(relay.id)
  const ticket = await checkBrowserTicket({
    kind: kind as "backups" | "files",
    name,
    relayId: relay.id,
    request,
    signer: credentials,
  })
  if (!ticket.allowed) {
    return ticket.busy
      ? Response.json(
          { error: "Hearth is busy. Try again." },
          { headers: { "retry-after": "5" }, status: 503 }
        )
      : Response.json(
          { error: "Not a transfer Hearth allowed" },
          { status: 401 }
        )
  }
  const slot = await acquirePassthroughSlot(relay.id)
  if (!slot) {
    return Response.json(
      { error: "Hearth is carrying as many transfers as it can. Try again." },
      { headers: { "retry-after": "5" }, status: 503 }
    )
  }
  const control = relayControlEndpoint(relay)
  const throughTunnel = relayReachedThroughTunnel(relay.id)
  const ca =
    !throughTunnel && control.useTls
      ? (credentials.caCertificatePem ?? undefined)
      : undefined
  // Opened last, so nothing can fail between here and the request taking it.
  const tunnel = throughTunnel
    ? await tapPromiseError(() => openRelayTunnel(relay), slot.release)
    : null
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
  // Whatever fails before an answer, even in setting the request up, lets
  // go of the slot.
  return tapPromiseError(
    () =>
      new Promise<Response>((resolve, reject) => {
        // The slot is held until both ways are done: sending the request, with
        // any upload, and passing the answer on.
        const pending = new Set(["sending", "answering"])
        const done = (part: "answering" | "sending") => {
          if (pending.delete(part) && pending.size === 0) slot.release()
        }
        let responded = false
        const fail = (cause: Error) => {
          if (!responded) reject(cause)
        }
        const parts: Array<{ destroy: () => unknown }> = []
        slot.onStall(() => {
          for (const part of parts) part.destroy()
        })
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
            responded = true
            parts.push(incoming)
            const status = incoming.statusCode ?? 0
            // Only answers a Response can carry, so a Relay can't throw here.
            if (status < 200 || status > 599) {
              incoming.once("close", () => done("answering"))
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
            if (bodyless) {
              // Nothing's passed on, and nothing more's read: a Relay sending a
              // body anyway can't have Hearth take it unmetered.
              incoming.once("close", () => done("answering"))
              incoming.destroy()
              resolve(
                new Response(null, {
                  headers: responseHeaders(incoming.headers),
                  status,
                })
              )
              return
            }
            // Done once the browser has it all, or stops: bytes can still be
            // on their way through Hearth after the Relay finished sending.
            const body = slot.meter("fromRelay", incoming)
            parts.push(body)
            body.once("close", () => done("answering"))
            resolve(
              new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, {
                headers: responseHeaders(incoming.headers),
                status,
              })
            )
          }
        )
        parts.push(outgoing)
        // Every error the request has, however late, ends here.
        outgoing.on("error", fail)
        // Without an answer, nothing's left to pass on once the request ends.
        outgoing.once("close", () => {
          done("sending")
          if (!responded) done("answering")
        })
        const upload =
          ticket.body ??
          (request.body && request.method !== "GET" && request.method !== "HEAD"
            ? request.body
            : null)
        if (upload) {
          const sent = slot.meter(
            "toRelay",
            Buffer.isBuffer(upload)
              ? Readable.from([upload])
              : Readable.fromWeb(
                  upload as import("node:stream/web").ReadableStream
                )
          )
          parts.push(sent)
          // An upload that breaks off ends the request to the Relay too.
          pipeline(sent, outgoing, (cause) => {
            done("sending")
            if (cause) fail(cause)
          })
        } else {
          outgoing.end()
        }
      }),
    slot.release
  )
}

function responseHeaders(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers(SANDBOX_HEADERS)
  for (const name of RESPONSE_HEADERS) {
    const value = incoming[name]
    if (typeof value === "string") headers.set(name, value)
  }
  return headers
}
