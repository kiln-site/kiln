import { spawn } from "node:child_process"
import http from "node:http"
import { createServer } from "node:net"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"
import { afterEach, describe, expect, it } from "vite-plus/test"

const script = fileURLToPath(new URL("dev-share-proxy.mjs", import.meta.url))
const module = "export const value = 1;\n".repeat(200)
const running = []

afterEach(() => {
  for (const close of running.splice(0)) close()
})

// Stands in for the dev server Hearth runs.
async function hearth() {
  const server = http.createServer((request, response) => {
    if (request.url === "/sign-in") {
      response.writeHead(200, {
        "set-cookie": [
          "__Secure-kiln.session_token=signed-in; Path=/; HttpOnly; Secure",
          "sidebar_state=true; Path=/",
        ],
      })
      response.end()
      return
    }
    if (request.url === "/sign-out") {
      response.writeHead(200, {
        "set-cookie": ["__Secure-kiln.session_token=; Max-Age=0; Path=/"],
      })
      response.end()
      return
    }
    if (request.url === "/whoami") {
      response.end(request.headers.cookie ?? "")
      return
    }
    if (request.url.startsWith("/stream")) {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write("data: hello\n\n")
      // Hearth restarting mid-stream.
      if (request.url === "/stream?drop")
        setTimeout(() => request.socket.destroy(), 50)
      return
    }
    const headers = {
      // Vite's own hop: it closes idle connections after 5 seconds.
      connection: "keep-alive",
      "content-type": "text/javascript",
      etag: '"v1"',
      "keep-alive": "timeout=5",
    }
    if (request.headers["if-none-match"] === '"v1"') {
      response.writeHead(304, headers)
      response.end()
      return
    }
    response.writeHead(200, headers)
    response.end(module)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  running.push(() => {
    server.closeAllConnections()
    server.close()
  })
  return server.address().port
}

async function freePort() {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

async function share(upstreamPort, publicPort = 8600) {
  const port = await freePort()
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      KILN_DEV_SHARE_LISTEN_PORT: String(port),
      KILN_DEV_SHARE_ORIGIN: `https://box.example.ts.net:${publicPort}`,
      KILN_DEV_SHARE_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      KILN_URL: "https://kiln-test.orb.local",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  running.push(() => child.kill())
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve)
    child.once("exit", (code) => reject(new Error(`proxy exited ${code}`)))
  })
  return { child, port }
}

function get(port, path, headers, agent) {
  return new Promise((resolve, reject) => {
    http
      .get({ agent, headers, host: "127.0.0.1", path, port }, (response) => {
        const chunks = []
        response.on("data", (chunk) => chunks.push(chunk))
        response.on("end", () =>
          resolve({ body: Buffer.concat(chunks), response })
        )
      })
      .on("error", reject)
  })
}

describe("dev share proxy", () => {
  it("compresses modules without breaking caching or connection reuse", async () => {
    const { port } = await share(await hearth())
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
    running.push(() => agent.destroy())
    const gzip = { "accept-encoding": "gzip" }

    const first = await get(port, "/app.js", gzip, agent)
    expect(gunzipSync(first.body).toString()).toBe(module)
    expect(first.response.headers["keep-alive"]).not.toBe("timeout=5")

    const unchanged = await get(
      port,
      "/app.js",
      { ...gzip, "if-none-match": '"v1"' },
      agent
    )
    expect(unchanged.response.statusCode).toBe(304)
    expect(unchanged.response.headers["content-encoding"]).toBeUndefined()
    expect(unchanged.body.length).toBe(0)

    const next = await get(port, "/next.js", gzip, agent)
    expect(next.response.statusCode).toBe(200)
    expect(gunzipSync(next.body).toString()).toBe(module)
  })

  it("keeps each shared stack's session to itself", async () => {
    const upstream = await hearth()
    const first = await share(upstream, 8600)
    const second = await share(upstream, 8601)

    // The browser keeps one cookie jar for the box's host name.
    const signedIn = await get(first.port, "/sign-in", {})
    const jar = signedIn.response.headers["set-cookie"].map(
      (cookie) => cookie.split(";")[0]
    )
    expect(jar).toContain("sidebar_state=true")

    const cookie = { cookie: jar.join("; ") }
    const asFirst = await get(first.port, "/whoami", cookie)
    expect(asFirst.body.toString()).toContain(
      "__Secure-kiln.session_token=signed-in"
    )
    const asSecond = await get(second.port, "/whoami", cookie)
    expect(asSecond.body.toString()).not.toContain("session_token")
    expect(asSecond.body.toString()).toContain("sidebar_state=true")

    // Signing out clears the name the browser actually holds.
    const signedOut = await get(first.port, "/sign-out", cookie)
    const cleared = signedOut.response.headers["set-cookie"].map(
      (header) => header.split("=")[0]
    )
    const session = jar
      .map((entry) => entry.split("=")[0])
      .find((name) => name.includes("session_token"))
    expect(cleared).toContain(session)
  })

  it("keeps serving after a stream ends early at either end", async () => {
    const { child, port } = await share(await hearth())

    // The visitor leaves.
    await new Promise((resolve, reject) => {
      const request = http.get(
        { host: "127.0.0.1", path: "/stream", port },
        (response) => {
          response.once("data", () => {
            request.destroy()
            resolve()
          })
        }
      )
      request.on("error", reject)
    })
    // Hearth goes away.
    await new Promise((resolve) => {
      http
        .get({ host: "127.0.0.1", path: "/stream?drop", port }, (response) => {
          response.resume()
          response.on("close", resolve)
        })
        .on("error", resolve)
    })

    const after = await get(port, "/app.js", {})
    expect(after.body.toString()).toBe(module)
    expect(child.exitCode).toBeNull()
  })
})
