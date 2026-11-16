// Serves a development Hearth to the tailnet for `pnpm dev:docker:share`.
// Tailscale Serve terminates TLS and hands this the raw connection. It asks
// Hearth as KILN_URL, the one host Vite and Hearth's origin checks accept,
// and points redirects back at the tailnet link.
//
// A first dev load fetches about 1,300 uncompressed modules, and one failed
// module keeps the page from hydrating. So responses are compressed, and each
// request to Hearth gets its own connection, so none can land on one Vite has
// just closed.
import http from "node:http"
import net from "node:net"
import zlib from "node:zlib"

const listenPort = Number(process.env.KILN_DEV_SHARE_LISTEN_PORT ?? "3000")
const upstream = new URL(required("KILN_DEV_SHARE_UPSTREAM"))
const hearthOrigin = new URL(required("KILN_URL")).origin
const hearthHost = new URL(hearthOrigin).host
const publicOrigin = new URL(required("KILN_DEV_SHARE_ORIGIN")).origin
// Every stack shared from a box has the box's host name, and cookies ignore
// ports, so the session cookies get this link's own name. Page scripts never
// read those (they're HttpOnly); the preference cookies they do read stay
// shared between stacks.
const cookieTag = `share${new URL(publicOrigin).port || "443"}-`
const anyCookieTag = /^share\d+-/u
const cookiePrefix = /^(__Secure-|__Host-)?(.*)$/u

const agent = new http.Agent({ keepAlive: false })
const compressible =
  /javascript|typescript|css|json|html|svg|xml|text\/plain|wasm/u

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    console.error(`${name} is required.`)
    process.exit(1)
  }
  return value
}

// Each side's connection headers describe that hop only. Hearth's would
// tell the browser to drop its connection after every module.
const hopHeaders = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]

function withoutHopHeaders(headers) {
  const out = { ...headers }
  const named = String(headers.connection ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
  for (const name of [...hopHeaders, ...named]) delete out[name]
  return out
}

// Hearth sees its own cookie names, and none of another link's.
function cookiesToHearth(header) {
  const cookies = []
  for (const cookie of header.split(/;\s*/u)) {
    const [, prefix = "", rest] = cookiePrefix.exec(cookie)
    if (rest.startsWith(cookieTag))
      cookies.push(prefix + rest.slice(cookieTag.length))
    else if (!anyCookieTag.test(rest)) cookies.push(cookie)
  }
  return cookies.join("; ")
}

function cookiesToVisitor(setCookie) {
  const [, prefix = "", rest] = cookiePrefix.exec(setCookie)
  const tagged = prefix + cookieTag + rest
  if (/;\s*httponly\s*(;|$)/iu.test(setCookie)) return [tagged]
  // A deletion needn't repeat HttpOnly, so it clears both names.
  if (/;\s*max-age=0\s*(;|$)/iu.test(setCookie)) return [setCookie, tagged]
  return [setCookie]
}

function toHearth(headers) {
  const out = { ...headers, host: hearthHost }
  if (typeof out.cookie === "string") out.cookie = cookiesToHearth(out.cookie)
  if (out.origin === publicOrigin) out.origin = hearthOrigin
  if (typeof out.referer === "string" && out.referer.startsWith(publicOrigin))
    out.referer = hearthOrigin + out.referer.slice(publicOrigin.length)
  delete out["x-forwarded-host"]
  return out
}

function toVisitor(headers) {
  const out = withoutHopHeaders(headers)
  if (typeof out.location === "string" && out.location.startsWith(hearthOrigin))
    out.location = publicOrigin + out.location.slice(hearthOrigin.length)
  if (out["set-cookie"])
    out["set-cookie"] = out["set-cookie"].flatMap(cookiesToVisitor)
  return out
}

function shouldCompress(request, response) {
  return (
    request.method !== "HEAD" &&
    // A 304's headers refresh the browser's cached copy, which isn't
    // compressed; neither it nor a 204 has a body to encode.
    response.statusCode !== 204 &&
    response.statusCode !== 304 &&
    !response.headers["content-encoding"] &&
    /\bgzip\b/u.test(String(request.headers["accept-encoding"] ?? "")) &&
    compressible.test(String(response.headers["content-type"] ?? "")) &&
    !/event-stream/u.test(String(response.headers["content-type"] ?? ""))
  )
}

const server = http.createServer((request, response) => {
  const forwarded = http.request(
    {
      agent,
      headers: withoutHopHeaders(toHearth(request.headers)),
      host: upstream.hostname,
      method: request.method,
      path: request.url,
      port: upstream.port || 80,
    },
    (answer) => {
      // Hearth restarting mid-response ends that response, not the proxy.
      answer.on("error", () => response.destroy())
      const headers = toVisitor(answer.headers)
      if (!shouldCompress(request, answer)) {
        response.writeHead(answer.statusCode ?? 502, headers)
        answer.pipe(response)
        return
      }
      delete headers["content-length"]
      headers["content-encoding"] = "gzip"
      headers.vary = headers.vary
        ? `${headers.vary}, Accept-Encoding`
        : "Accept-Encoding"
      response.writeHead(answer.statusCode ?? 502, headers)
      // Flushing keeps streamed server rendering streaming.
      const gzip = zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH })
      gzip.on("error", () => response.destroy())
      answer.pipe(gzip).pipe(response)
    }
  )
  forwarded.on("error", (error) => {
    // Ended because the visitor left; there's no one to answer.
    if (response.destroyed) return
    if (response.headersSent) {
      response.destroy()
      return
    }
    console.error(`${request.method} ${request.url}: ${error.message}`)
    response.writeHead(502, { "content-type": "text/plain" })
    response.end("Hearth isn't answering. Is the stack running?\n")
  })
  // A visitor who leaves mid-response ends the request to Hearth too.
  response.on("close", () => forwarded.destroy())
  request.pipe(forwarded)
})

// The console, terminal and realtime sockets.
server.on("upgrade", (request, socket, head) => {
  const forwarded = net.connect(
    Number(upstream.port || 80),
    upstream.hostname,
    () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`]
      for (const [name, value] of Object.entries(toHearth(request.headers))) {
        for (const item of Array.isArray(value) ? value : [value])
          lines.push(`${name}: ${item}`)
      }
      forwarded.write(`${lines.join("\r\n")}\r\n\r\n`)
      if (head.length > 0) forwarded.write(head)
      socket.pipe(forwarded).pipe(socket)
    }
  )
  forwarded.on("error", () => socket.destroy())
  socket.on("error", () => forwarded.destroy())
})

// Browsers reuse idle connections for a while; outlive that.
server.keepAliveTimeout = 120_000
server.headersTimeout = 125_000
// Realtime responses stay open.
server.requestTimeout = 0
server.on("clientError", (_error, socket) => socket.destroy())

server.listen(listenPort, () => {
  console.log(`Sharing ${hearthOrigin} at ${publicOrigin}`)
})

// Realtime responses never finish, so don't wait for them.
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => process.exit(0))
