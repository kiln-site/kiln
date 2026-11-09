import { connect, createServer, type Socket } from "node:net"
import type { AddressInfo, Server } from "node:net"
import { constants, deflateSync } from "node:zlib"

import { afterEach, describe, expect, it } from "vite-plus/test"
import { WebSocket, WebSocketServer } from "ws"

import { carryScaledScreen } from "./desktop-screen-scaling.js"

const ARD = 30

const VIEWER_INFO = 0x21
const SET_MODE = 0x0a
const AUTO_PASTEBOARD = 0x15
const FETCH_PASTEBOARD = 0x0b
const PASTEBOARD = 0x1f
const WATCHING = [VIEWER_INFO, SET_MODE, AUTO_PASTEBOARD]
const UTF8_TEXT = "public.utf8-plain-text"

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const counted = (bytes: Buffer) => {
  const size = Buffer.alloc(4)
  size.writeUInt32BE(bytes.length)
  return Buffer.concat([size, bytes])
}

// One item of a pasteboard archive, in the formats given.
function pasteboardArchive(formats: Record<string, string>) {
  const count = Buffer.alloc(4)
  count.writeUInt32BE(Object.keys(formats).length)
  return Buffer.concat([
    count,
    ...Object.entries(formats).flatMap(([name, data]) => [
      counted(Buffer.from(name)),
      Buffer.alloc(8),
      counted(Buffer.from(data)),
    ]),
  ])
}

const deflated = (bytes: Buffer) =>
  deflateSync(bytes, { finishFlush: constants.Z_SYNC_FLUSH })

// Bytes from a socket, read in the sizes a protocol calls for.
class Incoming {
  #bytes = Buffer.alloc(0)
  #wake: (() => void) | null = null

  push(data: Buffer) {
    this.#bytes = Buffer.concat([this.#bytes, data])
    this.#wake?.()
  }

  async read(size: number) {
    while (this.#bytes.length < size) {
      await new Promise<void>((wake) => {
        this.#wake = wake
      })
    }
    const read = this.#bytes.subarray(0, size)
    this.#bytes = this.#bytes.subarray(size)
    return read
  }
}

// Stands in for macOS's server: Apple's sign-in, then raw updates of one
// colour, with each pixel's unused byte empty, as a Mac leaves it.
function fakeMac(image: { height: number; width: number }) {
  // How far Apple's messages have come, in the order the Mac needs them.
  const watching: Array<number> = []
  let pasteboard: Buffer = Buffer.alloc(0)
  let socket: Socket | null = null
  const server = createServer((connection) => {
    socket = connection
    cleanups.push(() => connection.destroy())
    connection.on("error", () => undefined)
    const incoming = new Incoming()
    connection.on("data", (data) => incoming.push(data))
    const run = async () => {
      connection.write("RFB 003.889\n")
      await incoming.read(12)
      connection.write(Buffer.from([1, ARD]))
      await incoming.read(1)
      connection.write(Buffer.from([0, 2, 0, 4, 1, 2, 3, 4, 5, 6, 7, 8]))
      await incoming.read(128 + 4)
      connection.write(Buffer.alloc(4))
      await incoming.read(1)
      const init = Buffer.alloc(24 + 3)
      init.writeUInt16BE(image.width, 0)
      init.writeUInt16BE(image.height, 2)
      init.writeUInt32BE(3, 20)
      init.write("mac", 24)
      connection.write(init)
      for (;;) {
        const type = (await incoming.read(1))[0]
        if (type === 0) await incoming.read(19)
        else if (type === 2) {
          const count = (await incoming.read(3)).readUInt16BE(1)
          await incoming.read(count * 4)
        } else if (type === 3) await incoming.read(9)
        else if (type === 4) await incoming.read(7)
        else if (type === 5) await incoming.read(5)
        else if (type === VIEWER_INFO) {
          await incoming.read(65)
          watching.push(VIEWER_INFO)
        } else if (type === SET_MODE) {
          await incoming.read(3)
          watching.push(SET_MODE)
        } else if (type === AUTO_PASTEBOARD) {
          const body = await incoming.read(7)
          if (body[2] === 1) watching.push(AUTO_PASTEBOARD)
        } else if (type === FETCH_PASTEBOARD) {
          await incoming.read(7)
          const compressed = deflated(pasteboard)
          const reply = Buffer.alloc(16)
          reply[0] = PASTEBOARD
          reply.writeUInt32BE(pasteboard.length, 8)
          reply.writeUInt32BE(compressed.length, 12)
          connection.write(Buffer.concat([reply, compressed]))
        } else if (type === PASTEBOARD) {
          const header = await incoming.read(15)
          await incoming.read(header.readUInt32BE(11))
        }
      }
    }
    void run()
  })
  return {
    // A Mac only says so to a viewer that's asked in the right order.
    copy: (archive: Buffer) => {
      pasteboard = archive
      if (watching.join() !== WATCHING.join()) return
      socket?.write(Buffer.from([0x14, 0, 0, 4, 0, 1, 0, 2]))
    },
    sendRaw: (bytes: Buffer) => socket?.write(bytes),
    server,
  }
}

// Stands in for noVNC, signing in and reading what a VNC client would.
async function viewerOf(mac: ReturnType<typeof fakeMac>) {
  const listening = (server: Server | WebSocketServer) =>
    new Promise<number>((resolve) => {
      const onListening = () => resolve((server.address() as AddressInfo).port)
      if (server instanceof WebSocketServer) {
        server.once("listening", onListening)
      } else {
        server.listen(0, "127.0.0.1", onListening)
      }
    })
  const macPort = await listening(mac.server)
  const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  const relayPort = await listening(relay)
  relay.on("connection", (viewer) => {
    carryScaledScreen(connect(macPort, "127.0.0.1"), viewer)
  })
  const socket = new WebSocket(`ws://127.0.0.1:${relayPort}`)
  cleanups.push(() => {
    socket.terminate()
    relay.close()
    mac.server.close()
  })
  socket.binaryType = "nodebuffer"
  const incoming = new Incoming()
  const closed = new Promise<void>((resolve) => {
    socket.on("close", () => resolve())
  })
  socket.on("message", (data: Buffer) => incoming.push(data))
  socket.on("error", () => undefined)
  await new Promise((resolve) => socket.once("open", resolve))
  return { closed, incoming, socket }
}

type Viewer = Awaited<ReturnType<typeof viewerOf>>

async function signIn({ incoming, socket }: Viewer) {
  await incoming.read(12)
  socket.send("RFB 003.889\n")
  await incoming.read(2)
  socket.send(Buffer.from([ARD]))
  await incoming.read(4 + 8)
  socket.send(Buffer.alloc(128 + 4, 7))
}

async function enter(viewer: Viewer) {
  await viewer.incoming.read(4)
  viewer.socket.send(Buffer.from([1]))
  await viewer.incoming.read(24 + 3)
}

const readCutText = async ({ incoming }: Viewer) => {
  const header = await incoming.read(8)
  expect(header[0]).toBe(3)
  return Buffer.from(await incoming.read(header.readUInt32BE(4))).toString()
}

// What a Mac sends is bounded by what the Relay will hold in memory.
describe("what a Mac can ask of the Relay", () => {
  it("ends a stream whose image is too large to hold in memory", async () => {
    const viewer = await viewerOf(fakeMac({ height: 30_000, width: 30_000 }))
    await signIn(viewer)
    await viewer.incoming.read(4)
    viewer.socket.send(Buffer.from([1]))
    await viewer.closed
    expect(viewer.socket.readyState).toBe(WebSocket.CLOSED)
  })

  it("steps over a pasteboard too large to read", async () => {
    const mac = fakeMac({ height: 64, width: 64 })
    const viewer = await viewerOf(mac)
    await signIn(viewer)
    await enter(viewer)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const size = 65 * 1024 * 1024
    const huge = Buffer.alloc(16)
    huge[0] = PASTEBOARD
    huge.writeUInt32BE(size, 8)
    huge.writeUInt32BE(size, 12)
    mac.sendRaw(Buffer.concat([huge, Buffer.alloc(size)]))
    mac.copy(pasteboardArchive({ [UTF8_TEXT]: "after" }))
    expect(await readCutText(viewer)).toBe("after")
  })
})
