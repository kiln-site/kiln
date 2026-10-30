import { connect, type Socket } from "node:net"

/**
 * Sends one raw HTTP/1.1 request to 127.0.0.1. HTTP clients normalize request
 * targets, so this is how tests send malformed ones such as `//%`. The caller
 * owns the returned socket.
 */
export function sendRawRequest(
  port: number,
  target: string,
  options: { readonly allowHalfOpen?: boolean; readonly upgrade?: boolean } = {}
): Socket {
  const headers = [
    `GET ${target} HTTP/1.1`,
    "Host: 127.0.0.1",
    ...(options.upgrade
      ? [
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        ]
      : ["Connection: close"]),
  ]
  const socket = connect({
    allowHalfOpen: options.allowHalfOpen ?? false,
    host: "127.0.0.1",
    port,
  })
  socket.once("connect", () => {
    socket.write(`${headers.join("\r\n")}\r\n\r\n`)
  })
  return socket
}
