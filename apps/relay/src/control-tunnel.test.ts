import { once } from "node:events"
import { createServer as createHttpServer } from "node:http"
import type { IncomingMessage } from "node:http"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"

import {
  relayTunnelPath,
  relayTunnelProtocol,
  relayTunnelTokenHeader,
} from "@workspace/contracts"
import { createWebSocketStream, WebSocketServer } from "ws"
import type { WebSocket } from "ws"
import { expect, it, onTestFinished } from "vite-plus/test"

import { openControlTunnel } from "./control-tunnel.js"

it("opens a tunnel named by its token that carries a connection to the Relay's listener", async () => {
  // The Relay's listener, here one that echoes.
  const listener = createServer((socket) => socket.pipe(socket))
  listener.listen(0, "127.0.0.1")
  await once(listener, "listening")
  // Hearth, taking tunnels.
  const hearth = createHttpServer()
  const tunnels = new WebSocketServer({
    handleProtocols: (protocols) =>
      protocols.has(relayTunnelProtocol) ? relayTunnelProtocol : false,
    path: relayTunnelPath,
    server: hearth,
  })
  const arrived = once(tunnels, "connection") as Promise<
    [WebSocket, IncomingMessage]
  >
  hearth.listen(0, "127.0.0.1")
  await once(hearth, "listening")
  onTestFinished(async () => {
    for (const client of tunnels.clients) client.terminate()
    tunnels.close()
    await new Promise<void>((resolve) => hearth.close(() => resolve()))
    await new Promise<void>((resolve) => listener.close(() => resolve()))
  })

  const token = "t".repeat(43)
  await openControlTunnel({
    dialUrl: new URL(
      `ws://127.0.0.1:${(hearth.address() as AddressInfo).port}/api/relays/control`
    ),
    listener: {
      host: "0.0.0.0",
      port: (listener.address() as AddressInfo).port,
    },
    token,
  })
  const [socket, upgrade] = await arrived
  expect(upgrade.headers[relayTunnelTokenHeader]).toBe(token)

  const stream = createWebSocketStream(socket)
  stream.write("to the listener and back")
  const [echoed] = (await once(stream, "data")) as [Buffer]
  expect(echoed.toString()).toBe("to the listener and back")
  stream.destroy()
})
