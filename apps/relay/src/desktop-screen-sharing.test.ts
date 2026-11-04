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

// `plutil -convert binary1` of two arrangements, the second to the left of the
// first, as the window server keeps them.
const displaysPlist = binaryDisplays()
const macHost = [
  `displays=${displaysPlist}`,
  "accounts=.localized Guest Shared ada grace not/a/name",
  "",
].join("\n")

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
        { runScript: async () => macHost },
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

describe("a Mac's displays and accounts", () => {
  it("reports its displays' arrangements in the image's pixels", async () => {
    onMac()
    const vnc = await fakeVnc()
    const { desktop } = await harness(vnc.port)
    const shown = await desktop.read()
    expect(shown).toMatchObject({
      accounts: ["ada", "grace"],
      layouts: [
        [
          { height: 2100, width: 3360, x: 0, y: 0 },
          { height: 2880, width: 5120, x: 3360, y: 0 },
        ],
        [
          { height: 2100, width: 3360, x: 5120, y: 0 },
          { height: 2880, width: 5120, x: 0, y: 0 },
        ],
        [
          { height: 1200, width: 1920, x: 0, y: 0 },
          { height: 2880, width: 5120, x: 1920, y: 0 },
        ],
      ],
      status: "screen-sharing",
    })
  })

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
  it("shows Screen Sharing once the Mac's owner turns it on", async () => {
    onMac()
    const vnc = await fakeVnc()
    const { desktop } = await harness(vnc.port)
    expect((await desktop.read()).status).toBe("screen-sharing")
    await new Promise((resolve) => vnc.server.close(resolve))
    for (const socket of sockets) socket.destroy()
    expect((await desktop.read()).status).toBe("screen-sharing-off")
    await expect(desktop.attach()).rejects.toBeInstanceOf(
      DesktopUnavailableError
    )
  })

  it("doesn't take another service on that port for Screen Sharing", async () => {
    onMac()
    const other = await fakeVnc("HTTP/1.1 400 Bad Request\r\n\r\n")
    const { desktop } = await harness(other.port)
    expect((await desktop.read()).status).toBe("screen-sharing-off")
  })

  it("carries the Mac's greeting to the viewer, to sign in", async () => {
    onMac()
    const vnc = await fakeVnc()
    const { desktop, port } = await harness(vnc.port)
    const { desktop: shown, ticket } = await desktop.attach()
    expect(shown.status).toBe("screen-sharing")
    expect(await firstMessage(port, ticket)).toContain("RFB 003.889")
  })

  it("doesn't make anyone wait for the desktop image", async () => {
    onMac()
    const vnc = await fakeVnc()
    const { desktop } = await harness(vnc.port)
    fakeDocker.addContainer({ name: hostname(), running: true })
    const pulling = fakeDocker.hold({ command: "pull" })
    const { desktop: shown } = await desktop.attach()
    expect(shown.status).toBe("screen-sharing")
    expect(fakeDocker.containers.size).toBe(1)
    await pulling.reached
    pulling.release()
  })

  it("opens all the same when the desktop image can't download", async () => {
    onMac()
    const vnc = await fakeVnc()
    const { desktop } = await harness(vnc.port)
    fakeDocker.addContainer({ name: hostname(), running: true })
    fakeDocker.failNext({ command: "pull" }, "no such image")
    const { desktop: shown } = await desktop.attach()
    expect(shown.status).toBe("screen-sharing")
    await vi.waitFor(() => expect(fakeDocker.pulls.size).toBe(0))
  })

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

  it("ends a ticket once Screen Sharing goes away, so the page attaches again", async () => {
    onMac()
    const vnc = await fakeVnc()
    const { desktop, port } = await harness(vnc.port)
    const { ticket } = await desktop.attach()
    await new Promise((resolve) => vnc.server.close(resolve))
    await firstMessage(port, ticket)
    await vi.waitFor(() =>
      expect(desktop.heartbeat([ticket]).tickets).toEqual([])
    )
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

  it("leaves everything but Docker on a Mac to the other backends", async () => {
    const vnc = await fakeVnc()
    for (const info of [
      { OperatingSystem: "Debian GNU/Linux 13 (trixie)" },
      {
        Labels: ["com.docker.desktop.address=npipe://\\\\.\\pipe\\docker"],
        OperatingSystem: "Docker Desktop",
      },
    ]) {
      fakeDocker.info = info
      const { desktop } = await harness(vnc.port, async () => "")
      expect((await desktop.read()).status).toBe("none")
    }
    fakeDocker.info = {
      Labels: [
        "com.docker.desktop.address=unix:///Users/ada/Library/Containers/com.docker.docker/Data/docker-cli.sock",
      ],
      OperatingSystem: "Docker Desktop",
    }
    const { desktop } = await harness(vnc.port)
    expect((await desktop.read()).status).toBe("screen-sharing")
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

function binaryDisplays() {
  const objects: Array<Buffer> = []
  const add = (object: Buffer) => objects.push(object) - 1
  const references = (values: ReadonlyArray<number>) => {
    const bytes = Buffer.alloc(values.length * 2)
    values.forEach((value, index) => bytes.writeUInt16BE(value, index * 2))
    return bytes
  }
  const string = (text: string) =>
    add(
      Buffer.concat([
        Buffer.from(
          text.length < 15 ? [0x50 | text.length] : [0x5f, 0x10, text.length]
        ),
        Buffer.from(text),
      ])
    )
  // Eight bytes, as Apple writes a negative integer.
  const integer = (value: number) => {
    const bytes = Buffer.alloc(9)
    bytes.writeUInt8(0x13, 0)
    bytes.writeBigInt64BE(BigInt(value), 1)
    return add(bytes)
  }
  const array = (items: ReadonlyArray<number>) =>
    add(Buffer.concat([Buffer.from([0xa0 | items.length]), references(items)]))
  const dictionary = (fields: Record<string, number>) => {
    const keys = Object.keys(fields).map(string)
    const size = keys.length
    return add(
      Buffer.concat([
        Buffer.from([0xd0 | size]),
        references([...keys, ...Object.values(fields)]),
      ])
    )
  }
  const display = (x: number, wide: number, high: number, scale = 2) =>
    dictionary({
      CurrentInfo: dictionary({
        High: integer(high),
        OriginX: integer(x),
        OriginY: integer(0),
        Scale: integer(scale),
        Wide: integer(wide),
      }),
    })
  const config = (displays: ReadonlyArray<number>) =>
    dictionary({ DisplayConfig: array(displays) })
  const top = dictionary({
    DisplayAnyUserSets: dictionary({
      Configs: array([
        config([display(0, 1680, 1050), display(1680, 2560, 1440)]),
        config([display(0, 1680, 1050), display(-2560, 2560, 1440)]),
        config([display(0, 1920, 1200, 1), display(1920, 2560, 1440)]),
      ]),
    }),
  })
  return binaryPlist(objects, top)
}

function selfReferencingPlist() {
  // An array whose only item is itself.
  return binaryPlist([Buffer.from([0xa1, 0x00, 0x00])], 0)
}
