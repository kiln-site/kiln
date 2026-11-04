import type { AddressInfo } from "node:net"

import { afterEach, expect, it, vi } from "vite-plus/test"
import { createWebSocketStream, WebSocket, WebSocketServer } from "ws"

import { requestRelayBackup } from "@/lib/relay-backup-request.server"
import type { PersistedRelay } from "@/lib/relay-registry"

// The tunnel is the boundary: a real WebSocket stream, as Hearth gets for a
// Relay whose listener speaks plain HTTP, which has no socket timeouts.
const tunnels = vi.hoisted(() => ({
  open: (): Promise<unknown> => Promise.reject(new Error("No tunnel")),
}))

vi.mock("@/lib/relay-tunnel.server", () => ({
  openRelayTunnel: () => tunnels.open(),
  relayReachedThroughTunnel: () => true,
}))

const relay = {
  hostname: "203.0.113.7",
  id: "r".repeat(43),
  port: 4100,
  useTls: true,
} as unknown as PersistedRelay

const servers: Array<WebSocketServer> = []

afterEach(() => {
  vi.useRealTimers()
  for (const server of servers.splice(0)) server.close()
})

// A Relay at the far end of a tunnel, answering each request with `answer`.
async function tunnelTo(answer: string): Promise<void> {
  const server = new WebSocketServer({ port: 0 })
  servers.push(server)
  server.on("connection", (socket) => {
    socket.once("message", () => {
      if (answer) socket.send(answer)
    })
  })
  await new Promise((resolve) => server.once("listening", resolve))
  const { port } = server.address() as AddressInfo
  tunnels.open = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise((resolve) => socket.once("open", resolve))
    return createWebSocketStream(socket)
  }
}

it("reads a backup through a tunnel with no socket timeouts", async () => {
  await tunnelTo("HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nbackup")

  const response = await requestRelayBackup(
    relay,
    null,
    "/v1/browser/backups/one?token=t",
    new AbortController().signal
  )

  const chunks: Array<Buffer> = []
  for await (const chunk of response) chunks.push(chunk as Buffer)
  expect(response.statusCode).toBe(200)
  expect(Buffer.concat(chunks).toString()).toBe("backup")
})

it("gives up on a tunnel that stops answering", async () => {
  await tunnelTo("")
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })

  let settled = false
  const failure = requestRelayBackup(
    relay,
    null,
    "/v1/browser/backups/one?token=t",
    new AbortController().signal
  ).catch((cause: unknown) => {
    settled = true
    return cause
  })
  // The tunnel connects in real time, while its idle time is virtual.
  while (!settled) {
    // oxlint-disable-next-line react-doctor/async-await-in-loop -- each step must observe the I/O of the previous one
    await vi.advanceTimersByTimeAsync(10_000)
    // oxlint-disable-next-line react-doctor/async-await-in-loop -- see above
    await new Promise((resolve) => setImmediate(resolve))
  }

  expect(await failure).toMatchObject({
    message: "The backup copy stopped making progress",
  })
})
