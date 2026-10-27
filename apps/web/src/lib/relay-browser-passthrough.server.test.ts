import { generateKeyPairSync, sign } from "node:crypto"
import { once } from "node:events"
import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

import { beforeEach, expect, it, onTestFinished, vi } from "vite-plus/test"

vi.mock("@/lib/relay-registry", () => ({
  loadPersistedRelay: vi.fn(),
  loadRelayCredentials: vi.fn(),
}))
vi.mock("@/lib/relay-tunnel.server", () => ({
  openRelayTunnel: vi.fn(),
  relayReachedThroughTunnel: () => false,
}))

import { passRelayBrowserRequest } from "@/lib/relay-browser-passthrough.server"
import { relayPassthroughUsage } from "@/lib/relay-passthrough-limits.server"
import { loadPersistedRelay, loadRelayCredentials } from "@/lib/relay-registry"

const relayId = "relay-passthrough-test"
const clientId = "hearth-client"
const hearthKeys = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
})

// The Relay's listener, answering each request with `handle`.
async function relayListener(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
  id = relayId
) {
  const server = createServer(handle)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  onTestFinished(() => {
    server.closeAllConnections()
    return new Promise<void>((resolve) => server.close(() => resolve()))
  })
  vi.mocked(loadPersistedRelay).mockResolvedValue({
    hostname: "127.0.0.1",
    id,
    port: (server.address() as AddressInfo).port,
    useTls: false,
  } as Awaited<ReturnType<typeof loadPersistedRelay>>)
}

// A credential as Hearth signs them for the Relay: `<payload>.<signature>`.
function signed(
  payload: Record<string, unknown>,
  privateKey = hearthKeys.privateKey
): string {
  const encoded = Buffer.from(
    JSON.stringify({
      audience: relayId,
      expiresAt: Date.now() + 60_000,
      issuer: clientId,
      ...payload,
    })
  ).toString("base64url")
  return `${encoded}.${sign(null, Buffer.from(encoded), privateKey).toString("base64url")}`
}

// A browser's request for a file root's transfer, with a capability for it.
function fileRequest(
  instanceId: string,
  init: RequestInit = {},
  capability = signed({ instanceId })
): Request {
  return new Request("https://kiln.example/api", {
    ...init,
    headers: { authorization: `Kiln ${capability}`, ...init.headers },
  })
}

beforeEach(() => {
  vi.stubEnv("KILN_URL", "https://kiln.example")
  vi.mocked(loadRelayCredentials).mockResolvedValue({
    caCertificatePem: null,
    clientId,
    clientPublicKeyPem: hearthKeys.publicKey,
  } as Awaited<ReturnType<typeof loadRelayCredentials>>)
  return () => vi.unstubAllEnvs()
})

it("never lets what a Relay sends run as a page under Hearth's origin", async () => {
  await relayListener((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" })
    response.end("<script>fetch('/api/me')</script>")
  })
  const response = await passRelayBrowserRequest(
    relayId,
    "files/root",
    fileRequest("root")
  )
  expect(response.headers.get("content-security-policy")).toBe(
    "default-src 'none'; sandbox"
  )
  expect(response.headers.get("x-content-type-options")).toBe("nosniff")
})

it("passes only a transfer's own route, its name encoded again", async () => {
  const paths: Array<string | undefined> = []
  await relayListener((request, response) => {
    paths.push(request.url)
    response.end()
  })
  const name = "..\\..\\v1\\trust"
  await passRelayBrowserRequest(relayId, `files/${name}`, fileRequest(name))
  const backup = "a b?c"
  await passRelayBrowserRequest(
    relayId,
    `backups/${backup}`,
    new Request(
      `https://kiln.example/api?token=${signed({ backupId: backup })}`
    )
  )
  expect(paths[0]).toBe("/v1/browser/files/..%5C..%5Cv1%5Ctrust")
  expect(paths[1]?.startsWith("/v1/browser/backups/a%20b%3Fc?token=")).toBe(
    true
  )
  for (const route of ["files/..", "files/.", "trust", "files/a/b"]) {
    const response = await passRelayBrowserRequest(
      relayId,
      route,
      fileRequest(route)
    )
    expect(response.status).toBe(404)
  }
})

it("spends nothing on a request without a credential Hearth signed for it", async () => {
  let reached = 0
  await relayListener((_request, response) => {
    reached += 1
    response.end()
  })
  const stranger = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  })
  const refused = [
    new Request("https://kiln.example/api"),
    fileRequest("root", {}, "made.up"),
    fileRequest(
      "root",
      {},
      signed({ instanceId: "root" }, stranger.privateKey)
    ),
    fileRequest("root", {}, signed({ instanceId: "elsewhere" })),
    fileRequest(
      "root",
      {},
      signed({ expiresAt: Date.now() - 1, instanceId: "root" })
    ),
    fileRequest(
      "root",
      {},
      signed({ audience: "another-relay", instanceId: "root" })
    ),
  ]
  for (const request of refused) {
    const response = await passRelayBrowserRequest(
      relayId,
      "files/root",
      request
    )
    expect(response.status).toBe(401)
  }
  const backup = await passRelayBrowserRequest(
    relayId,
    "backups/b1",
    new Request(`https://kiln.example/api?token=${signed({ backupId: "b2" })}`)
  )
  expect(backup.status).toBe(401)
  expect(reached).toBe(0)
})

it("finds a native download's credential in its form, and passes the form on", async () => {
  const bodies: Array<string> = []
  await relayListener((request, response) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString())
      response.end()
    })
  })
  const form = new URLSearchParams({
    authorization: `Kiln ${signed({ instanceId: "root" })}`,
    path: "world",
  }).toString()
  const response = await passRelayBrowserRequest(
    relayId,
    "files/root",
    new Request("https://kiln.example/api", {
      body: form,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    })
  )
  expect(response.status).toBe(200)
  expect(bodies).toEqual([form])
})

it("fails the request, not Hearth, when an upload breaks off", async () => {
  await relayListener((request) => {
    request.resume()
  })
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("The browser went away"))
    },
  })
  await expect(
    passRelayBrowserRequest(
      relayId,
      "files/root",
      fileRequest("root", {
        body,
        duplex: "half",
        method: "PUT",
      } as RequestInit)
    )
  ).rejects.toThrow("The browser went away")
})

it("answers for a Relay whose status no response can carry", async () => {
  let status = 205
  await relayListener((_request, response) => {
    response.writeHead(status, { "content-length": "4" })
    response.end(status === 205 ? undefined : "body")
  })
  const reset = await passRelayBrowserRequest(
    relayId,
    "files/root",
    fileRequest("root")
  )
  expect(reset.status).toBe(205)
  expect(reset.body).toBeNull()

  status = 600
  const invalid = await passRelayBrowserRequest(
    relayId,
    "files/root",
    fileRequest("root")
  )
  expect(invalid.status).toBe(502)
})

it("keeps what a download will weigh, which browsers ask before one", async () => {
  const sizes = {
    "x-kiln-compressed-size-estimate": "10",
    "x-kiln-download-max-size": "30",
    "x-kiln-gzip-size-estimate": "10",
    "x-kiln-zip-size-estimate": "20",
  }
  await relayListener((_request, response) => {
    response.writeHead(200, sizes).end()
  })
  const response = await passRelayBrowserRequest(
    relayId,
    "files/root",
    fileRequest("root", { method: "HEAD" })
  )
  for (const [name, value] of Object.entries(sizes)) {
    expect(response.headers.get(name)).toBe(value)
  }
})

it("carries a few transfers to a Relay at once, and counts what it carries", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  onTestFinished(() => {
    vi.useRealTimers()
  })
  // A Relay of its own, whose slots no other test holds.
  const busyRelay = "relay-passthrough-busy"
  const request = () =>
    fileRequest("root", {}, signed({ audience: busyRelay, instanceId: "root" }))
  const held: Array<ServerResponse> = []
  await relayListener((_request, response) => {
    response.writeHead(200)
    response.write("a".repeat(100))
    held.push(response)
  }, busyRelay)
  const before = relayPassthroughUsage(busyRelay)
  const open = await Promise.all(
    Array.from({ length: 8 }, () =>
      passRelayBrowserRequest(busyRelay, "files/root", request())
    )
  )
  const reader = open[0]!.body!.getReader()
  await reader.read()
  expect(relayPassthroughUsage(busyRelay).open).toBe(before.open + 8)

  // A ninth waits for a slot, then is turned away.
  const ninth = passRelayBrowserRequest(busyRelay, "files/root", request())
  await vi.advanceTimersByTimeAsync(5_000)
  const busy = await ninth
  expect(busy.status).toBe(503)
  expect(busy.headers.get("retry-after")).toBe("5")

  // One ending frees its slot for the next.
  const next = passRelayBrowserRequest(busyRelay, "files/root", request())
  held[0]!.end()
  await reader.read()
  await expect(next).resolves.toMatchObject({ status: 200 })
  expect(relayPassthroughUsage(busyRelay).bytesFromRelay).toBeGreaterThan(
    before.bytesFromRelay
  )
  for (const response of [...open.slice(1), await next]) {
    await response.body?.cancel()
  }
})

it("ends a transfer through Hearth that stalls", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const stalling = "relay-passthrough-stalling"
  await relayListener((_request, response) => {
    response.writeHead(200)
    response.write("first")
  }, stalling)
  const response = await passRelayBrowserRequest(
    stalling,
    "files/root",
    fileRequest("root", {}, signed({ audience: stalling, instanceId: "root" }))
  )
  const reader = response.body!.getReader()
  await reader.read()
  await vi.advanceTimersByTimeAsync(60_000)
  await expect(reader.read()).rejects.toThrow()
  expect(relayPassthroughUsage(stalling).open).toBe(0)
})

// Lets virtual time pass, with real I/O between, until `promise` settles.
async function advanceUntil<T>(promise: Promise<T>): Promise<T> {
  let settled = false
  const settle = () => {
    settled = true
  }
  promise.then(settle, settle)
  while (!settled) {
    // oxlint-disable-next-line react-doctor/async-await-in-loop -- each step must observe the I/O of the previous one
    await vi.advanceTimersByTimeAsync(100)
    // oxlint-disable-next-line react-doctor/async-await-in-loop -- see above
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return promise
}

async function readAll(response: Response): Promise<number> {
  let size = 0
  const reader = response.body!.getReader()
  for (;;) {
    // oxlint-disable-next-line react-doctor/async-await-in-loop -- a stream is read in order
    const { done, value } = await advanceUntil(reader.read())
    if (done) return size
    size += value.byteLength
  }
}

it("holds a transfer's slot until the browser has its bytes, and keeps to a rate without stalling", async () => {
  // The rate is kept by the clock as well as by timers.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  vi.stubEnv("KILN_RELAY_PASSTHROUGH_BYTES_PER_SECOND", "1024")
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const paced = "relay-passthrough-paced"
  const ticket = signed({ audience: paced, instanceId: "root" })
  let uploaded = 0
  await relayListener((request, response) => {
    request.on("data", (chunk: Buffer) => {
      uploaded += chunk.length
    })
    request.on("end", () => response.end("b".repeat(4 * 1024)))
  }, paced)

  // The Relay sent it all at once; Hearth passes it on at the rate.
  const response = await advanceUntil(
    passRelayBrowserRequest(
      paced,
      "files/root",
      fileRequest("root", {}, ticket)
    )
  )
  expect(relayPassthroughUsage(paced).open).toBe(1)
  expect(await readAll(response)).toBe(4 * 1024)
  await advanceUntil(Promise.resolve())
  expect(relayPassthroughUsage(paced).open).toBe(0)

  // An upload slower than the stall timeout, only because of the rate.
  const upload = await advanceUntil(
    passRelayBrowserRequest(
      paced,
      "files/root",
      fileRequest(
        "root",
        { body: "u".repeat(80 * 1024), method: "PUT" },
        ticket
      )
    )
  )
  expect(upload.status).toBe(200)
  expect(uploaded).toBe(80 * 1024)
  await readAll(upload)
})

it("charges the rate only for what it passed on", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  vi.stubEnv("KILN_RELAY_PASSTHROUGH_BYTES_PER_SECOND", "1024")
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const sharing = "relay-passthrough-sharing"
  const ticket = signed({ audience: sharing, instanceId: "root" })
  let size = 64 * 1024
  await relayListener((_request, response) => {
    response.end("c".repeat(size))
  }, sharing)
  const abandoned = await advanceUntil(
    passRelayBrowserRequest(
      sharing,
      "files/root",
      fileRequest("root", {}, ticket)
    )
  )
  await abandoned.body!.cancel()

  // What the abandoned one never passed on doesn't hold the next back.
  size = 1024
  const next = await advanceUntil(
    passRelayBrowserRequest(
      sharing,
      "files/root",
      fileRequest("root", {}, ticket)
    )
  )
  const started = Date.now()
  expect(await readAll(next)).toBe(1024)
  expect(Date.now() - started).toBeLessThan(5_000)
})

it("reads only a few forms at once, each for a short while", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  onTestFinished(() => {
    vi.useRealTimers()
  })
  await relayListener((_request, response) => {
    response.end()
  })
  const unfinished = () =>
    new Request("https://kiln.example/api", {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("path=world&"))
        },
      }),
      duplex: "half",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    } as RequestInit)
  const waiting = Array.from({ length: 16 }, () =>
    passRelayBrowserRequest(relayId, "files/root", unfinished())
  )
  await vi.advanceTimersByTimeAsync(0)
  const busy = await passRelayBrowserRequest(
    relayId,
    "files/root",
    unfinished()
  )
  expect(busy.status).toBe(503)
  // Each gives up on its form after a while.
  await vi.advanceTimersByTimeAsync(10_000)
  for (const response of await Promise.all(waiting)) {
    expect(response.status).toBe(401)
  }
})

it("keeps an answer's slot when the upload breaks off after the Relay answered", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  vi.stubEnv("KILN_RELAY_PASSTHROUGH_BYTES_PER_SECOND", "1024")
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const early = "relay-passthrough-early"
  await relayListener((_request, response) => {
    response.end("e".repeat(4 * 1024))
  }, early)
  let breakOff: () => void = () => undefined
  const brokenOff = new Promise<void>((resolve) => {
    breakOff = resolve
  })
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial"))
    },
    async pull(controller) {
      await brokenOff
      controller.error(new Error("The browser went away"))
    },
  })
  const response = await advanceUntil(
    passRelayBrowserRequest(
      early,
      "files/root",
      fileRequest(
        "root",
        { body, duplex: "half", method: "PUT" } as RequestInit,
        signed({ audience: early, instanceId: "root" })
      )
    )
  )
  // The upload breaks off once Hearth has the Relay's answer.
  breakOff()
  await vi.advanceTimersByTimeAsync(100)
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(relayPassthroughUsage(early).open).toBe(1)
  expect(await readAll(response)).toBe(4 * 1024)
  await advanceUntil(Promise.resolve())
  expect(relayPassthroughUsage(early).open).toBe(0)
})

it("shares the rate between transfers in turn", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  vi.stubEnv("KILN_RELAY_PASSTHROUGH_BYTES_PER_SECOND", "1024")
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const shared = "relay-passthrough-shared"
  await relayListener((_request, response) => {
    response.end("s".repeat(64 * 1024))
  }, shared)
  const ticket = signed({ audience: shared, instanceId: "root" })
  const [first, second] = await advanceUntil(
    Promise.all([
      passRelayBrowserRequest(
        shared,
        "files/root",
        fileRequest("root", {}, ticket)
      ),
      passRelayBrowserRequest(
        shared,
        "files/root",
        fileRequest("root", {}, ticket)
      ),
    ])
  )
  const received = [0, 0]
  const drain = async (response: Response, index: number) => {
    const reader = response.body!.getReader()
    for (;;) {
      // oxlint-disable-next-line react-doctor/async-await-in-loop -- a stream is read in order
      const { done, value } = await reader.read()
      if (done) return
      received[index]! += value.byteLength
    }
  }
  void drain(first!, 0)
  void drain(second!, 1)
  for (let step = 0; step < 100; step += 1) {
    // oxlint-disable-next-line react-doctor/async-await-in-loop -- each step must observe the I/O of the previous one
    await vi.advanceTimersByTimeAsync(100)
    // oxlint-disable-next-line react-doctor/async-await-in-loop -- see above
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  // Ten seconds at 1 KiB/s, taken in turn.
  expect(received[0]).toBeGreaterThanOrEqual(4 * 1024)
  expect(received[1]).toBeGreaterThanOrEqual(4 * 1024)
})

it("holds the slot until an upload the Relay answered early is done", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  vi.stubEnv("KILN_RELAY_PASSTHROUGH_BYTES_PER_SECOND", "1024")
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const answering = "relay-passthrough-answering"
  let received = 0
  let uploaded: () => void = () => undefined
  const upload = new Promise<void>((resolve) => {
    uploaded = resolve
  })
  await relayListener((request, response) => {
    response.end("ok")
    request.on("data", (chunk: Buffer) => {
      received += chunk.length
    })
    request.on("end", uploaded)
  }, answering)
  const response = await advanceUntil(
    passRelayBrowserRequest(
      answering,
      "files/root",
      fileRequest(
        "root",
        { body: "u".repeat(8 * 1024), method: "PUT" },
        signed({ audience: answering, instanceId: "root" })
      )
    )
  )
  expect(await readAll(response)).toBe(2)
  await advanceUntil(Promise.resolve())
  // The answer is done, the upload isn't.
  expect(received).toBeLessThan(8 * 1024)
  expect(relayPassthroughUsage(answering).open).toBe(1)
  await advanceUntil(upload)
  await advanceUntil(Promise.resolve())
  expect(received).toBe(8 * 1024)
  expect(relayPassthroughUsage(answering).open).toBe(0)
})

it("reads from the Relay only as fast as the browser does, and ends a transfer it stopped reading", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  vi.stubEnv("KILN_RELAY_PASSTHROUGH_BYTES_PER_SECOND", "16384")
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const unread = "relay-passthrough-unread"
  await relayListener((_request, response) => {
    response.end("r".repeat(2 * 1024 * 1024))
  }, unread)
  await advanceUntil(
    passRelayBrowserRequest(
      unread,
      "files/root",
      fileRequest("root", {}, signed({ audience: unread, instanceId: "root" }))
    )
  )
  // Nobody reads it: Hearth takes no more than it holds for the browser,
  // its own buffer and the response's, then ends it as stalled.
  for (let step = 0; step < 900; step += 1) {
    // oxlint-disable-next-line react-doctor/async-await-in-loop -- each step must observe the I/O of the previous one
    await vi.advanceTimersByTimeAsync(100)
    // oxlint-disable-next-line react-doctor/async-await-in-loop -- see above
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  const usage = relayPassthroughUsage(unread)
  expect(usage.bytesFromRelay).toBeLessThanOrEqual(160 * 1024)
  expect(usage.open).toBe(0)
})

it("lets waiting transfers go once the rate is lifted", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  vi.stubEnv("KILN_RELAY_PASSTHROUGH_BYTES_PER_SECOND", "1")
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const lifted = "relay-passthrough-lifted"
  await relayListener((_request, response) => {
    response.end("l".repeat(1024))
  }, lifted)
  const response = await advanceUntil(
    passRelayBrowserRequest(
      lifted,
      "files/root",
      fileRequest("root", {}, signed({ audience: lifted, instanceId: "root" }))
    )
  )
  const read = readAll(response)
  await vi.advanceTimersByTimeAsync(2_000)
  vi.stubEnv("KILN_RELAY_PASSTHROUGH_BYTES_PER_SECOND", "")
  const started = Date.now()
  expect(await read).toBe(1024)
  expect(Date.now() - started).toBeLessThan(3_000)
})

it("lets go of the Relay's answer when the browser stops, even while it's idle", async () => {
  const idle = "relay-passthrough-idle"
  let hungUp: () => void = () => undefined
  const hangUp = new Promise<void>((resolve) => {
    hungUp = resolve
  })
  await relayListener((_request, response) => {
    response.writeHead(200)
    response.write("first")
    // Then sends nothing more, until Hearth hangs up.
    response.once("close", hungUp)
  }, idle)
  const response = await passRelayBrowserRequest(
    idle,
    "files/root",
    fileRequest("root", {}, signed({ audience: idle, instanceId: "root" }))
  )
  const reader = response.body!.getReader()
  await reader.read()
  await reader.cancel()
  await hangUp
  expect(relayPassthroughUsage(idle).open).toBe(0)
})

it("takes no body a Relay sends with an answer that has none", async () => {
  const bodyless = "relay-passthrough-bodyless"
  let finished: boolean | null = null
  await relayListener((_request, response) => {
    response.writeHead(205, { "content-length": String(64 * 1024 * 1024) })
    response.once("close", () => {
      finished = response.writableFinished
    })
    response.end(Buffer.alloc(64 * 1024 * 1024))
  }, bodyless)
  const response = await passRelayBrowserRequest(
    bodyless,
    "files/root",
    fileRequest("root", {}, signed({ audience: bodyless, instanceId: "root" }))
  )
  expect(response.status).toBe(205)
  await vi.waitFor(() => expect(finished).toBe(false))
  expect(relayPassthroughUsage(bodyless).bytesFromRelay).toBe(0)
})
