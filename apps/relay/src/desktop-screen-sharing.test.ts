import { createServer, type Server } from "node:http"
import { hostname } from "node:os"
import { createServer as createTcpServer } from "node:net"
import type { AddressInfo, Server as TcpServer, Socket } from "node:net"

import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { WebSocket } from "ws"

vi.mock("./command.js", () => import("./test/docker.js"))

import { ScreenSharingDesktop } from "./desktop-screen-sharing.js"
import { DesktopUnavailableError } from "./desktop-backend.js"
import { VoxlDesktop } from "./desktop-voxl.js"
import { Desktop } from "./desktop.js"
import { parseMacHost } from "./mac-host.js"
import { OperationLanes } from "./operation-lanes.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness } from "./test/relay.js"

const servers: Array<Server | TcpServer> = []
const sockets: Array<Socket> = []

afterEach(async () => {
  fakeDocker.info = {}
  for (const socket of sockets.splice(0)) socket.destroy()
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          if (!server.listening) return resolve(undefined)
          if ("closeAllConnections" in server) server.closeAllConnections()
          server.close(resolve)
        })
    )
  )
})

const listen = (server: Server | TcpServer) =>
  new Promise<number>((resolve) => {
    servers.push(server)
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port)
    )
  })

// Stands in for the encoder, where the Relay looks for it, answering pings.
async function fakeEncoder() {
  const server = createTcpServer((socket) => {
    sockets.push(socket)
    socket.on("error", () => undefined)
    socket.on("data", (data) => {
      if (data.at(-1) === 3) socket.write(Buffer.from([3]))
    })
  })
  await new Promise<void>((resolve) =>
    server.listen(47902, "127.0.0.1", () => resolve())
  )
  return { close: () => server.close() }
}

// Stands in for Screen Sharing: greets as a VNC server does, and echoes.
async function fakeVnc(greeting = "RFB 003.889\n") {
  const received: Array<string> = []
  const server = createTcpServer((socket) => {
    sockets.push(socket)
    socket.on("error", () => undefined)
    socket.write(greeting)
    socket.on("data", (data) => {
      received.push(data.toString())
      socket.write(data)
    })
  })
  return { port: await listen(server), received, server }
}

async function harness(
  port: number,
  voxlScript: () => Promise<string> = async () => {
    throw new Error("A Mac has no X11 session to find")
  }
) {
  const { config: relay } = await relayHarness()
  const config = {
    ...relay,
    desktopImage: "example/voxl:test",
    screenSharingAddress: { host: "127.0.0.1", port },
  }
  const lanes = new OperationLanes()
  const desktop = new Desktop(
    [
      new ScreenSharingDesktop(
        config,
        { runScript: async () => "" },
        lanes
      ),
      new VoxlDesktop(config, { runScript: voxlScript }),
    ],
    config,
    lanes
  )
  const server = createServer()
  desktop.attachServer(server)
  return { desktop, lanes, port: await listen(server) }
}

const onMac = () => {
  fakeDocker.info = { OperatingSystem: "OrbStack" }
}

// The first thing a stream sends, or null once it's turned away.
const firstMessage = (port: number, ticket: string, send?: string) =>
  new Promise<string | null>((resolve) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/v1/desktop/${ticket}/ws`
    )
    socket.binaryType = "nodebuffer"
    let seen = ""
    socket.on("open", () => send && socket.send(Buffer.from(send)))
    socket.on("message", (data) => {
      seen += (data as Buffer).toString()
      if (!send || seen.includes(send)) {
        resolve(seen)
        socket.close()
      }
    })
    socket.on("error", () => resolve(null))
    socket.on("close", () => resolve(seen || null))
  })

describe("a Mac's display files", () => {
  it("still shows the desktop when the Mac's files can't be read", async () => {
    for (const output of [
      "",
      "displays=bm90IGEgcGxpc3Q=\naccounts=",
      `displays=${Buffer.alloc(64, 0xff).toString("base64")}`,
    ]) {
      expect(parseMacHost(output)).toEqual({ accounts: [], layouts: [] })
    }
    // A property list that refers to itself ends rather than spinning.
    const claimsTooMuch = binaryPlist(
      [Buffer.from([0xaf, 0x12, 0x80, 0x00, 0x00, 0x00])],
      0
    )
    expect(parseMacHost(`displays=${claimsTooMuch}`).layouts).toEqual([])
    expect(parseMacHost(`displays=${oneStringManyTimes()}`).layouts).toEqual([])
    expect(parseMacHost(`displays=${manyNamesForOneString()}`).layouts).toEqual(
      []
    )
    expect(parseMacHost(`displays=${selfReferencingPlist()}`).layouts).toEqual(
      []
    )
  })
})

describe("a Mac's desktop", () => {
  it("runs its encoder with nothing but the Relay's loopback", async () => {
    onMac()
    const vnc = await fakeVnc()
    const encoder = await fakeEncoder()
    const { desktop } = await harness(vnc.port)
    fakeDocker.addContainer({ name: hostname(), running: true })
    fakeDocker.images.set("example/voxl:test", {})
    await desktop.attach()
    const named = () =>
      [...fakeDocker.containers.values()].find((container) =>
        container.name.endsWith("kiln-desktop-encoder")
      )
    expect(named()?.state.running).toBe(true)
    expect(named()?.mounts).toEqual([])
    expect(fakeDocker.pulls.size).toBe(0)
    await desktop.remove()
    expect(named()).toBeUndefined()
    encoder.close()
  })

  it("turns away a stream without a live ticket, or while paused", async () => {
    onMac()
    const vnc = await fakeVnc()
    const { desktop, lanes, port } = await harness(vnc.port)
    expect(await firstMessage(port, "a".repeat(43))).toBeNull()
    const { ticket } = await desktop.attach()
    lanes.setPaused(true)
    expect(await firstMessage(port, ticket)).toBeNull()
    expect(vnc.received).toEqual([])
    expect((await desktop.read()).status).toBe("paused")
  })

  it("respects a Relay with host access turned off", async () => {
    onMac()
    const vnc = await fakeVnc()
    const { config } = await relayHarness()
    const desktop = new Desktop(
      [
        new ScreenSharingDesktop(
          {
            ...config,
            screenSharingAddress: { host: "127.0.0.1", port: vnc.port },
          },
          { runScript: async () => "" },
          new OperationLanes()
        ),
      ],
      { hostAccess: false },
      new OperationLanes()
    )
    expect((await desktop.read()).status).toBe("disabled")
    await expect(desktop.attach()).rejects.toBeInstanceOf(
      DesktopUnavailableError
    )
  })
})

// Writes the small part of Apple's format the window server's file uses.
function binaryPlist(
  objects: ReadonlyArray<Buffer>,
  top: number,
  referenceSize = 2,
  offsetsOverride?: ReadonlyArray<number>
): string {
  const header = Buffer.from("bplist00", "latin1")
  const offsets: Array<number> = []
  let body = header
  for (const object of objects) {
    offsets.push(body.length)
    body = Buffer.concat([body, object])
  }
  const entries = offsetsOverride ?? offsets
  const table = Buffer.alloc(entries.length * 4)
  entries.forEach((offset, index) => table.writeUInt32BE(offset, index * 4))
  const trailer = Buffer.alloc(32)
  trailer.writeUInt8(4, 6)
  trailer.writeUInt8(referenceSize, 7)
  trailer.writeBigUInt64BE(BigInt(entries.length), 8)
  trailer.writeBigUInt64BE(BigInt(top), 16)
  trailer.writeBigUInt64BE(BigInt(body.length), 24)
  return Buffer.concat([body, table, trailer]).toString("base64")
}

// Small to store, and tens of gigabytes if each reference were decoded anew.
function oneStringManyTimes() {
  const references = 30_000
  const list = Buffer.alloc(4 + references * 2, 0)
  list.set([0xaf, 0x11, references >> 8, references & 0xff])
  for (let index = 0; index < references; index += 1) {
    list.writeUInt16BE(1, 4 + index * 2)
  }
  const text = Buffer.alloc(6 + 900_000, 0x61)
  text.set([0x5f, 0x12])
  text.writeUInt32BE(900_000, 2)
  return binaryPlist([list, text], 0)
}

// The same, through thousands of objects whose offsets all point to one string.
function manyNamesForOneString() {
  const aliases = 20_000
  const list = Buffer.alloc(4 + aliases * 2)
  list.set([0xaf, 0x11, aliases >> 8, aliases & 0xff])
  for (let index = 0; index < aliases; index += 1) {
    list.writeUInt16BE(index + 1, 4 + index * 2)
  }
  const text = Buffer.alloc(6 + 900_000, 0x61)
  text.set([0x5f, 0x12])
  text.writeUInt32BE(900_000, 2)
  const header = 8
  return binaryPlist([list, text], 0, 2, [
    header,
    ...Array.from({ length: aliases }, () => header + list.length),
  ])
}

function selfReferencingPlist() {
  // An array whose only item is itself.
  return binaryPlist([Buffer.from([0xa1, 0x00, 0x00])], 0)
}
