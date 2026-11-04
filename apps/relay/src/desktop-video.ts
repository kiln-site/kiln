import { randomBytes } from "node:crypto"
import { connect, type Socket } from "node:net"

import { Effect } from "effect"

import type { RelayConfig } from "./config.js"
import { Bytes } from "./desktop-bytes.js"
import { DesktopHelper } from "./desktop-helper.js"
import { ensuringPromise, forkPromise } from "./effect/promise.js"
import { exclusive, laneKeys, type OperationLanes } from "./operation-lanes.js"
import { operation, runOperation } from "./operations/operation.js"

// H.264 for a Mac's picture. x264 can't go in the Relay's image, so an encoder
// from the desktop image (apps/desktop/encoder.c) runs beside it, with nothing
// but the Relay's loopback to reach it. It only ever sees pixels: sign-in is
// over before a stream gets here. A Mac still shows its desktop without it, as
// JPEG, so nothing here may stand in the way of that: the image downloads in the
// background, for whoever opens the desktop next.

const ENCODER_HOST = "127.0.0.1"
const ENCODER_PORT = 47902
const ENCODER_PATH = "/usr/local/bin/kiln-desktop-encoder"
// Raised whenever how the encoder runs changes, so older ones are replaced.
const ENCODER_REVISION = "1"
const TOKEN_VARIABLE = "KILN_ENCODER_TOKEN"
const MESSAGE_SIZE = 0x01
const MESSAGE_FRAME = 0x02
const MESSAGE_PING = 0x03
const FLAG_SHARPEN = 0x01
const PING_TIMEOUT_MS = 1_000
// Far past any frame. An encoder this slow has stopped, and the picture with it.
const FRAME_TIMEOUT_MS = 5_000
const PULL_TIMEOUT_MS = 300_000
// A process for each viewer, and a few to spare.
const MAX_ENCODER_PROCESSES = 64
const READY_TIMEOUT_MS = 15_000
const READY_POLL_MS = 150

type VideoConfig = Pick<
  RelayConfig,
  "desktopImage" | "dockerSocket" | "resourceNamespace"
>

interface Area {
  readonly height: number
  readonly width: number
  readonly x: number
  readonly y: number
}

/** One viewer's connection to the encoder. */
export class ScreenVideo {
  readonly #socket: Socket
  readonly #replies: Bytes
  readonly #closed: Promise<null>

  constructor(socket: Socket, token: string) {
    this.#socket = socket
    this.#replies = new Bytes(socket)
    this.#closed = new Promise((closed) => {
      socket.once("close", () => closed(null))
      socket.once("error", () => socket.destroy())
    })
    socket.on("data", (chunk: Buffer) => this.#replies.push(chunk))
    socket.write(token)
  }

  /** Starts a picture of `source` pixels, encoded at `frame`. */
  size(
    source: { readonly height: number; readonly width: number },
    frame: { readonly height: number; readonly width: number }
  ) {
    const message = Buffer.alloc(9)
    message[0] = MESSAGE_SIZE
    message.writeUInt16BE(source.width, 1)
    message.writeUInt16BE(source.height, 3)
    message.writeUInt16BE(frame.width, 5)
    message.writeUInt16BE(frame.height, 7)
    this.#socket.write(message)
  }

  /**
   * Encodes what's changed in `area` of `image`, which is `stride` pixels wide,
   * and resolves with H.264 once it has. An empty `area` encodes the same
   * picture again, sharper. Null means the encoder has gone.
   */
  async encode(
    image: Buffer,
    stride: number,
    area: Area,
    sharpen: boolean
  ): Promise<Buffer | null> {
    const header = Buffer.alloc(10)
    header[0] = MESSAGE_FRAME
    header[1] = sharpen ? FLAG_SHARPEN : 0
    header.writeUInt16BE(area.x, 2)
    header.writeUInt16BE(area.y, 4)
    header.writeUInt16BE(area.width, 6)
    header.writeUInt16BE(area.height, 8)
    // Closing is what gives up: an answer that came later would otherwise be
    // taken for the next frame's.
    const stalled = setTimeout(() => this.close(), FRAME_TIMEOUT_MS)
    return ensuringPromise(
      () =>
        Promise.race([this.#closed, this.#send(header, image, stride, area)]),
      () => clearTimeout(stalled)
    )
  }

  close() {
    this.#socket.destroy()
  }

  async #send(header: Buffer, image: Buffer, stride: number, area: Area) {
    this.#socket.write(header)
    await this.#write(pixelsOf(image, stride, area))
    const length = (await this.#replies.read(4)).readUInt32BE(0)
    return length === 0
      ? Buffer.alloc(0)
      : Buffer.from(await this.#replies.read(length))
  }

  // Resolves once it's gone, so a slow encoder holds back the next frame. The
  // Mac may write over these pixels meanwhile: its next change covers them.
  #write(pixels: Buffer) {
    return new Promise<void>((written) => {
      this.#socket.write(pixels, () => written())
    })
  }
}

function pixelsOf(image: Buffer, stride: number, area: Area) {
  const start = (area.y * stride + area.x) * 4
  if (area.width === stride) {
    return image.subarray(start, start + area.height * stride * 4)
  }
  const rowBytes = area.width * 4
  const pixels = Buffer.allocUnsafe(rowBytes * area.height)
  for (let row = 0; row < area.height; row += 1) {
    const from = start + row * stride * 4
    image.copy(pixels, row * rowBytes, from, from + rowBytes)
  }
  return pixels
}

/** The encoder's container, started on the way to a Mac's desktop. */
export class DesktopVideo {
  readonly #helper: DesktopHelper
  readonly #image: string
  readonly #lanes: OperationLanes
  // In a lane of its own: it can take minutes, which nobody attaching waits for.
  readonly #pull = operation<void>()({
    name: "relay.desktop.image.pull",
    locks: () => [exclusive(laneKeys.desktopImage)],
    onlyIfFree: true,
    run: () =>
      this.#helper.engine
        .pullImage(this.#image, { timeout: PULL_TIMEOUT_MS })
        .pipe(Effect.asVoid),
  })
  #token: string | null = null

  constructor(config: VideoConfig, lanes: OperationLanes) {
    this.#helper = new DesktopHelper(config, "kiln-desktop-encoder")
    this.#image = config.desktopImage
    this.#lanes = lanes
  }

  /** Runs in the desktop's lane, with `relay.desktop.attach`. */
  async prepare(): Promise<void> {
    this.#token = null
    const relay = await this.#helper.relayContainer()
    const signature = JSON.stringify({
      image: this.#image,
      relay: relay.Id,
      revision: ENCODER_REVISION,
    })
    const existing = await this.#helper.existing()
    if (existing) {
      const token = existing.Config.Env?.find((entry) =>
        entry.startsWith(`${TOKEN_VARIABLE}=`)
      )
      // A restarted Relay has a new network namespace, stranding one that
      // still runs: only one that answers is kept.
      if (token && this.#helper.matches(existing, signature)) {
        const value = token.slice(TOKEN_VARIABLE.length + 1)
        if (await answers(value)) {
          this.#token = value
          return
        }
      }
      await this.#helper.remove(existing.Id)
    }
    if (!(await this.#imageIsHere())) {
      this.#pullImage()
      return
    }
    const token = randomBytes(32).toString("base64url")
    const created = await Effect.runPromise(
      this.#helper.engine.createContainer(this.#helper.name, {
        Cmd: [String(ENCODER_PORT)],
        Entrypoint: [ENCODER_PATH],
        Env: [`${TOKEN_VARIABLE}=${token}`],
        HostConfig: {
          CapDrop: ["ALL"],
          Init: true,
          NetworkMode: `container:${relay.Id}`,
          PidsLimit: MAX_ENCODER_PROCESSES,
          ReadonlyRootfs: true,
          RestartPolicy: { Name: "no" },
          SecurityOpt: ["no-new-privileges"],
        },
        Image: this.#image,
        Labels: this.#helper.labels(signature),
        // nobody: it needs no one's files.
        User: "65534:65534",
      })
    )
    await Effect.runPromise(this.#helper.engine.startContainer(created.Id))
    await this.#ready(created.Id, token)
    this.#token = token
  }

  /** A connection for a viewer, if the encoder's running. */
  open(): ScreenVideo | null {
    if (!this.#token) return null
    const socket = connect(ENCODER_PORT, ENCODER_HOST)
    socket.setNoDelay(true)
    return new ScreenVideo(socket, this.#token)
  }

  async release(): Promise<void> {
    await this.#helper.release()
    this.#token = null
  }

  #imageIsHere() {
    return Effect.runPromise(
      this.#helper.engine.inspectImage(this.#image).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false))
      )
    )
  }

  #pullImage() {
    forkPromise(
      () =>
        Effect.runPromise(
          runOperation(this.#lanes, this.#pull, undefined, { kind: "worker" })
        ),
      (cause) =>
        forkPromise(() =>
          Effect.runPromise(
            Effect.logWarning("The desktop image didn't download", { cause })
          )
        )
    )
  }

  async #ready(id: string, token: string) {
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await answers(token)) return
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
    }
    await this.#helper.remove(id)
    throw new Error("The desktop's video encoder didn't start")
  }
}

function answers(token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(ENCODER_PORT, ENCODER_HOST)
    const finish = (answered: boolean) => {
      socket.destroy()
      resolve(answered)
    }
    socket.setTimeout(PING_TIMEOUT_MS, () => finish(false))
    socket.once("error", () => finish(false))
    socket.once("close", () => finish(false))
    socket.once("data", (reply) => finish(reply[0] === MESSAGE_PING))
    socket.write(Buffer.concat([Buffer.from(token), Buffer.from([MESSAGE_PING])]))
  })
}
