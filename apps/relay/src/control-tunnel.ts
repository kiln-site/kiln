import { connect } from "node:net"
import { pipeline } from "node:stream"

import {
  relayTunnelPath,
  relayTunnelProtocol,
  relayTunnelTokenHeader,
} from "@workspace/contracts"
import { createWebSocketStream, WebSocket } from "ws"

// Tunnels: Hearth reaches a Relay that dials it through tunnels the Relay
// opens on request (`relay.tunnel.open`). Each one carries a single
// connection to the Relay's own listener, as if Hearth had dialed it, so
// everything there checks what it carries for itself: the console's
// capabilities, a transfer's proof. The tunnel only stands in for the
// network between them, which is why any paired Hearth may ask for one, and
// only to the Hearth the Relay already dials.

const MAX_TUNNELS = 64
const OPEN_TIMEOUT_MS = 10_000
const MAX_FRAME_BYTES = 1024 * 1024

let openTunnels = 0

/**
 * Opens a tunnel named by `token` to the Hearth whose control address is
 * `dialUrl`, carrying a connection to this Relay's listener. Resolves once
 * both ends are open.
 */
export function openControlTunnel(input: {
  readonly dialUrl: URL
  readonly listener: { readonly host: string; readonly port: number }
  readonly token: string
}): Promise<void> {
  if (openTunnels >= MAX_TUNNELS) {
    return Promise.reject(new Error("Too many tunnels to Hearth are open"))
  }
  openTunnels += 1
  return new Promise<void>((resolve, reject) => {
    let released = false
    const release = () => {
      if (released) return
      released = true
      openTunnels -= 1
    }
    const socket = new WebSocket(
      new URL(relayTunnelPath, input.dialUrl),
      relayTunnelProtocol,
      {
        handshakeTimeout: OPEN_TIMEOUT_MS,
        headers: { [relayTunnelTokenHeader]: input.token },
        maxPayload: MAX_FRAME_BYTES,
        perMessageDeflate: false,
      }
    )
    const fail = (cause: Error) => {
      release()
      socket.terminate()
      reject(cause)
    }
    socket.once("error", fail)
    socket.once("close", release)
    socket.once("open", () => {
      // Held until the listener connects, so nothing Hearth sends is lost.
      const remote = createWebSocketStream(socket)
      remote.pause()
      // Its socket's errors end the tunnel through `fail`.
      remote.on("error", () => undefined)
      const local = connect(input.listener.port, loopback(input.listener.host))
      local.once("error", fail)
      local.once("connect", () => {
        socket.off("error", fail)
        local.off("error", fail)
        // Either end closing closes the other; errors only end the tunnel.
        pipeline(remote, local, remote, () => {
          local.destroy()
          socket.terminate()
          release()
        })
        resolve()
      })
    })
  })
}

// The listener's own address, or loopback when it listens on all of them.
function loopback(host: string): string {
  return host === "0.0.0.0" || host === "::" || host === "" ? "127.0.0.1" : host
}
