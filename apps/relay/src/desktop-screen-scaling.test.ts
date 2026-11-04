import { connect, createServer, type Socket } from "node:net"
import type { AddressInfo, Server } from "node:net"

import sharp from "sharp"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { WebSocket, WebSocketServer } from "ws"

import { carryScaledScreen } from "./desktop-screen-scaling.js"

const TIGHT = 7
const TIGHT_PNG = -260
const DESKTOP_SIZE = -223
const DESKTOP_NAME = -307
const ARD = 30

const cleanups: Array<() => void> = []

afterEach(() => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

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

interface Request {
  readonly height: number
  readonly incremental: boolean
  readonly width: number
  readonly x: number
  readonly y: number
}

// Stands in for macOS's server: Apple's sign-in, then raw updates of one
// colour, with each pixel's unused byte empty, as a Mac leaves it.
function fakeMac(
  image: { height: number; width: number },
  refuse = false,
  colour: (x: number, y: number) => readonly [number, number, number] = () => [
    200, 0, 0,
  ]
) {
  const requests: Array<Request> = []
  const pointers: Array<{ x: number; y: number }> = []
  const signIn = { keys: Buffer.alloc(0) }
  let answering = true
  let socket: Socket | null = null
  const paint = ({ height, width, x, y }: Omit<Request, "incremental">) => {
    const header = Buffer.alloc(16)
    header.writeUInt16BE(1, 2)
    header.writeUInt16BE(x, 4)
    header.writeUInt16BE(y, 6)
    header.writeUInt16BE(width, 8)
    header.writeUInt16BE(height, 10)
    const pixels = Buffer.alloc(width * height * 4)
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        pixels.set(colour(x + column, y + row), (row * width + column) * 4)
      }
    }
    socket?.write(Buffer.concat([header, pixels]))
  }
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
      const keys = Buffer.from([0, 2, 0, 4, 1, 2, 3, 4, 5, 6, 7, 8])
      connection.write(keys)
      signIn.keys = Buffer.from(await incoming.read(128 + 4))
      if (refuse) {
        connection.write(Buffer.from([0, 0, 0, 1, 0, 0, 0, 2, 0x6e, 0x6f]))
        return
      }
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
        } else if (type === 3) {
          const body = await incoming.read(9)
          const request = {
            height: body.readUInt16BE(7),
            incremental: body[0] === 1,
            width: body.readUInt16BE(5),
            x: body.readUInt16BE(1),
            y: body.readUInt16BE(3),
          }
          requests.push(request)
          if (answering && !request.incremental) paint(request)
        } else if (type === 5) {
          const body = await incoming.read(5)
          pointers.push({ x: body.readUInt16BE(1), y: body.readUInt16BE(3) })
        }
      }
    }
    void run()
  })
  return {
    changeImage: (width: number, height: number) => {
      const header = Buffer.alloc(16)
      header.writeUInt16BE(1, 2)
      header.writeUInt16BE(width, 8)
      header.writeUInt16BE(height, 10)
      header.writeInt32BE(DESKTOP_SIZE, 12)
      socket?.write(header)
    },
    goQuiet: () => {
      answering = false
    },
    paint,
    pointers,
    requests,
    server,
    signIn,
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
  const version = await incoming.read(12)
  socket.send("RFB 003.889\n")
  const offered = await incoming.read(2)
  socket.send(Buffer.from([ARD]))
  const keys = await incoming.read(4 + 8)
  socket.send(Buffer.alloc(128 + 4, 7))
  return { keys, offered, version }
}

async function enter(viewer: Viewer) {
  await viewer.incoming.read(4)
  viewer.socket.send(Buffer.from([1]))
  return Buffer.from(await viewer.incoming.read(24 + 3))
}

function askToShow(
  { socket }: Viewer,
  area: { height: number; width: number; x: number; y: number },
  size: { height: number; width: number },
  lossless = false
) {
  const message = Buffer.alloc(14)
  message[0] = 0xfa
  message.writeUInt16BE(area.x, 1)
  message.writeUInt16BE(area.y, 3)
  message.writeUInt16BE(area.width, 5)
  message.writeUInt16BE(area.height, 7)
  message.writeUInt16BE(size.width, 9)
  message.writeUInt16BE(size.height, 11)
  message[13] = lossless ? 1 : 0
  socket.send(message)
}

const askForUpdate = ({ socket }: Viewer) => {
  socket.send(Buffer.concat([Buffer.from([3]), Buffer.alloc(9)]))
}

const compactLength = async (incoming: Incoming) => {
  let length = 0
  for (let shift = 0; shift <= 14; shift += 7) {
    const byte = (await incoming.read(1))[0] ?? 0
    if (shift === 14) return length | (byte << 14)
    length |= (byte & 0x7f) << shift
    if (byte < 0x80) break
  }
  return length
}

interface Rectangle {
  readonly data: Buffer
  readonly encoding: number
  readonly height: number
  readonly width: number
  readonly x: number
  readonly y: number
}

async function readUpdate({ incoming }: Viewer) {
  const header = await incoming.read(4)
  expect(header[0]).toBe(0)
  const rectangles: Array<Rectangle> = []
  for (let index = 0; index < header.readUInt16BE(2); index += 1) {
    const rectangle = Buffer.from(await incoming.read(12))
    const encoding = rectangle.readInt32BE(8)
    let data = Buffer.alloc(0)
    if (encoding === TIGHT || encoding === TIGHT_PNG) {
      await incoming.read(1)
      data = Buffer.from(await incoming.read(await compactLength(incoming)))
    } else if (encoding === DESKTOP_NAME) {
      const length = (await incoming.read(4)).readUInt32BE(0)
      data = Buffer.from(await incoming.read(length))
    }
    rectangles.push({
      data,
      encoding,
      height: rectangle.readUInt16BE(6),
      width: rectangle.readUInt16BE(4),
      x: rectangle.readUInt16BE(0),
      y: rectangle.readUInt16BE(2),
    })
  }
  return rectangles
}

const until = async (done: () => boolean) => {
  while (!done()) await new Promise((resolve) => setImmediate(resolve))
}

describe("a Mac's sign-in", () => {
  it("passes through unread, both ways", async () => {
    const mac = fakeMac({ height: 40, width: 80 })
    const viewer = await viewerOf(mac)
    const { keys, offered, version } = await signIn(viewer)
    expect(version.toString()).toBe("RFB 003.889\n")
    expect([...offered]).toEqual([1, ARD])
    expect([...keys]).toEqual([0, 2, 0, 4, 1, 2, 3, 4, 5, 6, 7, 8])
    const init = await enter(viewer)
    expect(mac.signIn.keys).toEqual(Buffer.alloc(128 + 4, 7))
    expect(init.readUInt16BE(0)).toBe(80)
    expect(init.readUInt16BE(2)).toBe(40)
    expect(init.subarray(24).toString()).toBe("mac")
  })

  it("gives the viewer the Mac's reason for refusing it", async () => {
    const viewer = await viewerOf(fakeMac({ height: 40, width: 80 }, true))
    await signIn(viewer)
    const refusal = await viewer.incoming.read(4 + 4 + 2)
    expect(refusal.readUInt32BE(0)).toBe(1)
    expect(refusal.subarray(8).toString()).toBe("no")
  })
})

describe("what a Mac can ask of the Relay", () => {
  it("ends a stream whose image is too large to hold in memory", async () => {
    const viewer = await viewerOf(fakeMac({ height: 30_000, width: 30_000 }))
    await signIn(viewer)
    await viewer.incoming.read(4)
    viewer.socket.send(Buffer.from([1]))
    await viewer.closed
    expect(viewer.socket.readyState).toBe(WebSocket.CLOSED)
  })
})

describe("a Mac's picture", () => {
  const area = { height: 200, width: 400, x: 100, y: 50 }
  const started = async (lossless = false) => {
    const mac = fakeMac({ height: 400, width: 800 })
    const viewer = await viewerOf(mac)
    await signIn(viewer)
    await enter(viewer)
    askForUpdate(viewer)
    askToShow(viewer, area, { height: 100, width: 200 }, lossless)
    const [size] = await readUpdate(viewer)
    return { mac, size, viewer }
  }

  it("shows the area asked for at about the size asked for, in its colours", async () => {
    const { size, viewer } = await started()
    expect(size).toMatchObject({
      encoding: DESKTOP_SIZE,
      height: 104,
      width: 200,
    })
    const [picture] = await readUpdate(viewer)
    expect(picture).toMatchObject({ encoding: TIGHT, x: 0, y: 0 })
    const { channels } = await sharp(picture?.data).stats()
    // Not black, as the Mac's empty unused bytes would make it if they were
    // ever read as transparent.
    expect(channels[0]?.mean).toBeGreaterThan(150)
    expect(channels[1]?.mean).toBeLessThan(60)
    expect(channels[2]?.mean).toBeLessThan(60)
  })

  it("draws what's around a small change exactly where it was", async () => {
    const stripes = (x: number) => [128 + 100 * Math.sin(x / 5), 0, 0] as const
    const mac = fakeMac({ height: 400, width: 800 }, false, stripes)
    const viewer = await viewerOf(mac)
    await signIn(viewer)
    await enter(viewer)
    askForUpdate(viewer)
    askToShow(
      viewer,
      { height: 256, width: 512, x: 0, y: 0 },
      { height: 140, width: 281 }
    )
    await readUpdate(viewer)
    const [whole] = await readUpdate(viewer)
    askForUpdate(viewer)
    mac.paint({ height: 8, width: 8, x: 300, y: 100 })
    const [change] = await readUpdate(viewer)
    expect(change?.x).toBeGreaterThan(0)
    const region = {
      height: change?.height ?? 0,
      left: change?.x ?? 0,
      top: change?.y ?? 0,
      width: change?.width ?? 0,
    }
    const before = await sharp(whole?.data).extract(region).raw().toBuffer()
    const after = await sharp(change?.data).raw().toBuffer()
    let difference = 0
    for (let index = 0; index < after.length; index += 3) {
      difference += Math.abs((after[index] ?? 0) - (before[index] ?? 0))
    }
    expect(difference / (after.length / 3)).toBeLessThan(4)
  })

  it("splits a picture too large for one Tight rectangle", async () => {
    const noise = () =>
      [Math.random() * 255, Math.random() * 255, Math.random() * 255] as const
    const mac = fakeMac({ height: 2400, width: 4096 }, false, noise)
    const viewer = await viewerOf(mac)
    await signIn(viewer)
    await enter(viewer)
    askForUpdate(viewer)
    const everything = { height: 2400, width: 4096, x: 0, y: 0 }
    askToShow(viewer, everything, { height: 2400, width: 4096 })
    await readUpdate(viewer)
    const parts = await readUpdate(viewer)
    expect(parts.length).toBeGreaterThan(1)
    let top = 0
    for (const { data, height, y } of parts) {
      expect(y).toBe(top)
      expect((await sharp(data).metadata()).height).toBe(height)
      top += height
    }
    expect(top).toBe(2400)
  })

  it("puts the pointer where the viewer sees it on the Mac", async () => {
    const { mac, viewer } = await started()
    const pointer = Buffer.alloc(6)
    pointer[0] = 5
    pointer.writeUInt16BE(50, 2)
    pointer.writeUInt16BE(25, 4)
    viewer.socket.send(pointer)
    await until(() => mac.pointers.length > 0)
    expect(mac.pointers).toEqual([{ x: 200, y: 100 }])
  })

  it("sends every pixel, exactly, when lossless", async () => {
    const { size, viewer } = await started(true)
    expect(size).toMatchObject({ height: 200, width: 400 })
    const strips = await readUpdate(viewer)
    expect(strips.every(({ encoding }) => encoding === TIGHT_PNG)).toBe(true)
    expect(strips.reduce((sum, { height }) => sum + height, 0)).toBe(200)
    const [strip] = strips
    const { data, info } = await sharp(strip?.data)
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect(info.width).toBe(400)
    expect([...data.subarray(0, 3)]).toEqual([200, 0, 0])
  })

  it("tells the viewer when the Mac's displays change, without ending", async () => {
    const { mac, viewer } = await started()
    await readUpdate(viewer)
    askForUpdate(viewer)
    mac.changeImage(1000, 500)
    const [notice] = await readUpdate(viewer)
    expect(notice?.data.toString()).toBe("kiln-image:1000x500")
    askToShow(
      viewer,
      { height: 500, width: 1000, x: 0, y: 0 },
      { height: 250, width: 500 }
    )
    expect((await readUpdate(viewer))[0]).toMatchObject({
      encoding: DESKTOP_SIZE,
      width: 504,
    })
  })

  it("asks again when the Mac sits on a request, so the picture can't stop", async () => {
    vi.useFakeTimers({
      toFake: ["clearInterval", "Date", "performance", "setInterval"],
    })
    const { mac, viewer } = await started()
    await readUpdate(viewer)
    mac.goQuiet()
    askForUpdate(viewer)
    await until(() => mac.requests.at(-1)?.incremental === true)
    const asked = mac.requests.length
    await vi.advanceTimersByTimeAsync(800)
    await until(() => mac.requests.length > asked)
    expect(mac.requests.at(-1)).toMatchObject({ ...area, incremental: true })
  })
})
