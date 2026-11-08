import { once } from "node:events"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { expect, it, onTestFinished, vi } from "vite-plus/test"

// Hearth's signing is the one thing replaced; the read goes to a real HTTP
// server, as it goes to the Relay.
let relayOrigin = ""
vi.mock("@/server/relay-capability", () => ({
  issueFileCapability: () =>
    Promise.resolve({
      browserOrigin: relayOrigin,
      capability: `${Buffer.from(
        JSON.stringify({
          capabilityId: "read-1",
          expiresAt: Date.now() + 60_000,
        })
      ).toString("base64url")}.signature`,
      expiresAt: Date.now() + 60_000,
      proxyMode: "none",
      relayId: "relay",
      version: 2,
    }),
  issueFilePreviewCapability: () => Promise.reject(new Error("unused")),
}))
vi.mock("@/server/relay", () => ({ saveRelayFile: () => undefined }))

import { readRelayFile } from "@/lib/relay-file-transfer"

const input = { instanceId: "server", path: "shots/map.png", relayId: "relay" }

// A Relay that sends a file's headers and first bytes, then waits.
async function slowRelay(size: number) {
  let started!: () => void
  const sending = new Promise<void>((resolve) => (started = resolve))
  let closed!: () => void
  const ended = new Promise<void>((resolve) => (closed = resolve))
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Length": String(size),
    })
    response.write(Buffer.alloc(1024))
    response.once("close", closed)
    started()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  onTestFinished(() => {
    server.closeAllConnections()
    return new Promise<void>((resolve) => server.close(() => resolve()))
  })
  relayOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { ended, sending }
}

it("reads a file's bytes", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Access-Control-Allow-Origin": "*" })
    response.end("pixels")
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  onTestFinished(
    () => new Promise<void>((resolve) => server.close(() => resolve()))
  )
  relayOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const blob = await readRelayFile({ ...input, maxBytes: 1024 })

  expect(await blob.text()).toBe("pixels")
})

it("ends the download when a read is stopped after its headers arrive", async () => {
  const relay = await slowRelay(16 * 1024 * 1024)
  // Stop the read once its body is being read, past the headers.
  const reading = new Promise<void>((resolve) => {
    const blob = Response.prototype.blob
    vi.spyOn(Response.prototype, "blob").mockImplementation(function (
      this: Response
    ) {
      resolve()
      return blob.call(this)
    })
  })
  onTestFinished(() => {
    vi.restoreAllMocks()
  })
  const controller = new AbortController()
  const read = readRelayFile({
    ...input,
    maxBytes: 32 * 1024 * 1024,
    signal: controller.signal,
  }).catch(() => undefined)
  await relay.sending
  await reading

  controller.abort()

  // The Relay sees the connection close; a download left running hangs here.
  await relay.ended
  await read
})
