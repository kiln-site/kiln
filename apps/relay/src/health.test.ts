import { connect, type AddressInfo } from "node:net"
import { Effect } from "effect"
import { describe, expect, it, onTestFinished } from "vite-plus/test"

import { listenRelayHealthServerEffect } from "./health.js"

async function listen(port = 0) {
  const server = await Effect.runPromise(listenRelayHealthServerEffect(port))
  onTestFinished(() => {
    server.close()
  })
  return { port: (server.address() as AddressInfo).port, server }
}

function connects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => resolve(false))
  })
}

describe("Relay health listener", () => {
  it("serves only GET and HEAD /health over plain HTTP", async () => {
    const { port } = await listen()
    const status = async (path: string, method = "GET") =>
      (await fetch(`http://127.0.0.1:${port}${path}`, { method })).status

    expect(await status("/health")).toBe(204)
    expect(await status("/health", "HEAD")).toBe(204)
    expect(await status("/health", "POST")).toBe(404)
    expect(await status("/")).toBe(404)
    expect(await status("/pair")).toBe(404)
    expect(await status("/backups/download")).toBe(404)
  })

  it("binds only to loopback", async () => {
    const { port, server } = await listen()

    expect((server.address() as AddressInfo).address).toBe("127.0.0.1")
    expect(await connects("127.0.0.1", port)).toBe(true)
  })
})
