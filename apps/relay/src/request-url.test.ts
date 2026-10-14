import { once } from "node:events"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { Duplex } from "node:stream"
import { describe, expect, it, onTestFinished } from "vite-plus/test"

import { rejectMalformedUpgrades } from "./request-url.js"
import { sendRawRequest } from "./test/raw-http.js"

describe("rejectMalformedUpgrades", () => {
  it("answers 400 and closes the connection even if the client stays half-open", async () => {
    const server = createServer()
    rejectMalformedUpgrades(server)
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    onTestFinished(() => {
      server.close()
    })
    const upgraded = once(server, "upgrade")

    const client = sendRawRequest(
      (server.address() as AddressInfo).port,
      "//%",
      { allowHalfOpen: true, upgrade: true }
    )
    onTestFinished(() => {
      client.destroy()
    })
    let received = ""
    client.on("data", (chunk: Buffer) => {
      received += chunk.toString("latin1")
    })
    const [, serverSocket] = (await upgraded) as [unknown, Duplex]

    // The client never ends its side, so only the server can close it.
    await Promise.all([once(serverSocket, "close"), once(client, "end")])
    expect(received).toMatch(/^HTTP\/1\.1 400 /u)
  })
})
