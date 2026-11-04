import { createHash } from "node:crypto"
import type { Socket } from "node:net"

import sharp from "sharp"
import type { WebSocket } from "ws"

import { Bytes } from "./desktop-bytes.js"
import {
  CLIPBOARD_IMAGE,
  clipboardImage,
  fetchPasteboard,
  MAX_PASTEBOARD_ARCHIVE_BYTES,
  MAX_PASTEBOARD_IMAGE_BYTES,
  MAX_PASTEBOARD_TEXT_BYTES,
  MISC_STATUS,
  PASTEBOARD,
  PASTEBOARD_CHANGED,
  pasteboardContents,
  pasteboardMessage,
  startPasteboard,
} from "./desktop-mac-pasteboard.js"
import type { ScreenVideo } from "./desktop-video.js"
import { forkPromise } from "./effect/promise.js"

// Shrinks a Mac's picture before it leaves the node. macOS's server sends only
// lossless pixels at the display's full size, whatever it's asked, which is
// megabytes per update for a Retina desktop, and neither it nor VNC can scale.
// So the Relay, next to it, takes Raw updates, which cost the Mac almost
// nothing to send, and passes the viewer JPEG at the size on the viewer's
// screen. noVNC stays a plain VNC client: it sees a server that happens to have
// a small framebuffer and offers Tight. Sign-in passes through unread, so the
// viewer's login still only reaches the Mac.
//
// Where there's an encoder (desktop-video.ts) and the viewer can decode it, the
// picture goes out as H.264 instead, which suits motion and costs a fraction of
// the bytes. JPEG stays for everyone else, and takes over if the encoder goes.

const VIEW_MESSAGE = 0xfa
const RAW = 0
const TIGHT = 7
const TIGHT_PNG = -260
const H264 = 50
const DESKTOP_SIZE = -223
const CURSOR = -239
const DESKTOP_NAME = -307
const TIGHT_JPEG = 0x90
const TIGHT_PNG_DATA = 0xa0
const SECURITY_NONE = 1
const SECURITY_VNC = 2
const SECURITY_ARD = 30
// That decoding should start over for this rectangle's picture.
const H264_RESET = 1
// H.264 level 5.1, which browsers can decode: a larger picture is scaled to fit.
const MAX_VIDEO_PIXELS = 9_437_184

const ARCHIVE_CHUNK_BYTES = 1024 * 1024
const MAX_VIEWER_CUT_BYTES = CLIPBOARD_IMAGE.length + MAX_PASTEBOARD_IMAGE_BYTES
const MAX_CURSOR_SIZE = 1024
// Four 5K displays. A stream holds the image, and a copy of it, in memory.
const MAX_IMAGE_PIXELS = 60_000_000
const MAX_DESKTOP_NAME_BYTES = 1024
const MAX_REFUSAL_BYTES = 64 * 1024
// All that Tight's length can say.
const MAX_TIGHT_BYTES = 0x3f_ffff

// The Mac can sit on a request for part of its image, so a quiet stream asks
// again, and after recent input, when something should have changed, asks for
// all of it.
const ASK_AGAIN_MS = 750
const REFRESH_AFTER_MS = 2_000
const RECENT_INPUT_MS = 3_000
const TICK_MS = 100

// Moving pictures go out rough and small, and sharpen once they stop. A small
// change, like typing, goes out sharp at once: it's little to send.
const ROUGH = { chromaSubsampling: "4:2:0", quality: 75 }
const SHARP = { chromaSubsampling: "4:4:4", quality: 90 }
const SHARPEN_AFTER_MS = 250
const SMALL_CHANGE = 0.08
// Tight lengths stop at 4 MB, which this many pixels can't pass even if PNG
// saves nothing.
const MAX_PNG_PIXELS = 1_000_000
const PNG = { adaptiveFiltering: false, compressionLevel: 2 }
const LOSSLESS = 1
const FAST_MOTION = 2
// The page says so here, not in the encodings noVNC offers, as noVNC's own check
// fails in Chrome on a Mac (relay-desktop-video-check.ts).
const DECODES_VIDEO = 4
// A change is scaled apart from the rest of the picture, so it has to land on
// the same pixels it would if everything were scaled together, or what's around
// it shifts by a fraction of a pixel with each update. So scales are sixteenths,
// where 16 of the Mac's pixels are always a whole number of the viewer's, and
// changes are sent in whole tiles, whose JPEG blocks line up too.
const SCALE_STEPS = 16
const JPEG_BLOCK = 16
const TILE = 256
const MARGIN = SCALE_STEPS

type JpegQuality = typeof ROUGH | typeof SHARP

interface Raw {
  readonly channels: 4
  readonly height: number
  readonly width: number
}

interface Rectangle {
  readonly height: number
  readonly width: number
  readonly x: number
  readonly y: number
}

interface View {
  readonly area: Rectangle
  readonly frame: Buffer
  readonly height: number
  readonly lossless: boolean
  // Whether it goes out as H.264.
  readonly video: boolean
  // The frame's size: the area, rounded up to whole steps unless lossless.
  readonly frameHeight: number
  readonly frameWidth: number
  // Sixteenths, as a fraction: the viewer's pixels for each of the Mac's.
  readonly scale: number
  readonly width: number
  // What's changed since the viewer last got it, and what it has only roughly.
  changed: Rectangle | null
  rough: Rectangle | null
}

const holdable = (width: number, height: number) =>
  width > 0 && height > 0 && width * height <= MAX_IMAGE_PIXELS

const union = (a: Rectangle | null, b: Rectangle): Rectangle => {
  if (!a) return b
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    height: Math.max(a.y + a.height, b.y + b.height) - y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    x,
    y,
  }
}

function rectangleHeader({ height, width, x, y }: Rectangle, encoding: number) {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(x, 0)
  header.writeUInt16BE(y, 2)
  header.writeUInt16BE(width, 4)
  header.writeUInt16BE(height, 6)
  header.writeInt32BE(encoding, 8)
  return header
}

function update(rectangles: ReadonlyArray<Buffer>) {
  const header = Buffer.alloc(4)
  header.writeUInt16BE(rectangles.length, 2)
  return Buffer.concat([header, ...rectangles])
}

function tightRectangle(
  rectangle: Rectangle,
  encoding: number,
  compression: number,
  image: Buffer
) {
  return Buffer.concat([
    rectangleHeader(rectangle, encoding),
    Buffer.from([compression]),
    compactLength(image.length),
    image,
  ])
}

// noVNC has no way to hear what the image behind the small picture became, so
// it comes as the desktop's name, which fires an event on the page.
function imageSizeNotice(width: number, height: number) {
  const name = Buffer.from(`kiln-image:${width}x${height}`)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(name.length)
  return update([
    Buffer.concat([
      rectangleHeader({ height: 0, width: 0, x: 0, y: 0 }, DESKTOP_NAME),
      length,
      name,
    ]),
  ])
}

// So is whether a viewer's getting video, for the toolbar.
function videoNotice(on: boolean) {
  const name = Buffer.from(`kiln-video:${on ? "on" : "off"}`)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(name.length)
  return update([
    Buffer.concat([
      rectangleHeader({ height: 0, width: 0, x: 0, y: 0 }, DESKTOP_NAME),
      length,
      name,
    ]),
  ])
}

function videoRectangle(view: View, encoded: Buffer, flags: number) {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(encoded.length, 0)
  header.writeUInt32BE(flags, 4)
  return Buffer.concat([
    rectangleHeader(
      { height: view.height, width: view.width, x: 0, y: 0 },
      H264
    ),
    header,
    encoded,
  ])
}

// Tight's length: seven bits a byte, up to three bytes.
function compactLength(length: number) {
  if (length > MAX_TIGHT_BYTES) throw new RangeError("Too much for Tight")
  if (length < 0x80) return Buffer.from([length])
  if (length < 0x4000) {
    return Buffer.from([(length & 0x7f) | 0x80, length >> 7])
  }
  return Buffer.from([
    (length & 0x7f) | 0x80,
    ((length >> 7) & 0x7f) | 0x80,
    length >> 14,
  ])
}

/** Carries one viewer's stream to the Mac until either end closes. */
export function carryScaledScreen(
  mac: Socket,
  viewer: WebSocket,
  openVideo: () => ScreenVideo | null = () => null
): void {
  new ScaledScreen(mac, viewer, openVideo).start()
}

const imageId = (image: Buffer) =>
  createHash("sha256").update(image).digest("base64")

class ScaledScreen {
  readonly #mac: Socket
  readonly #viewer: WebSocket
  readonly #fromMac: Bytes
  readonly #fromViewer: Bytes
  readonly #openVideo: () => ScreenVideo | null
  #image = { height: 0, width: 0 }
  #view: View | null = null
  #viewerReady = false
  #asked = false
  #encoding = false
  #closed = false
  #askedAt = 0
  #updatedAt = 0
  #sentAt = 0
  #inputAt = 0
  #timer: ReturnType<typeof setInterval> | null = null
  #snapshot = Buffer.alloc(0)
  #fastMotion = false
  #video: ScreenVideo | null = null
  #videoGone = false
  #videoView: View | null = null
  #videoReset = false
  #videoShown = false
  // What the viewer last asked for, to show again without the encoder.
  #wanted: Buffer | null = null
  #pastedImage: string | null = null

  constructor(
    mac: Socket,
    viewer: WebSocket,
    openVideo: () => ScreenVideo | null
  ) {
    this.#mac = mac
    this.#viewer = viewer
    this.#openVideo = openVideo
    this.#fromMac = new Bytes(mac)
    this.#fromViewer = new Bytes({
      pause: () => viewer.pause(),
      resume: () => viewer.resume(),
    })
  }

  start() {
    const close = () => this.#close()
    this.#mac.on("data", (chunk: Buffer) => {
      this.#fromMac.push(chunk)
    })
    this.#mac.once("close", close)
    this.#mac.once("error", close)
    this.#viewer.on("message", (data: Buffer) => this.#fromViewer.push(data))
    this.#viewer.once("close", close)
    this.#viewer.once("error", close)
    forkPromise(async () => {
      if (!(await this.#signIn())) return
      this.#timer = setInterval(() => this.#tick(), TICK_MS)
      this.#timer.unref()
      forkPromise(
        () => this.#readViewer(),
        () => this.#close()
      )
      await this.#readMac()
    }, close)
  }

  #close() {
    if (this.#closed) return
    this.#closed = true
    if (this.#timer) clearInterval(this.#timer)
    this.#video?.close()
    this.#mac.destroy()
    this.#viewer.terminate()
  }

  // Each resolves once the bytes have gone, so that whoever's sending them
  // waits for a slow reader instead of queueing without end.
  #send(data: Buffer | ReadonlyArray<Buffer>) {
    return new Promise<void>((sent) => {
      if (this.#closed) return sent()
      const bytes = Buffer.isBuffer(data) ? data : Buffer.concat(data)
      this.#viewer.send(bytes, () => sent())
    })
  }

  #write(data: Buffer) {
    return new Promise<void>((written) => {
      if (this.#closed) return written()
      this.#mac.write(data, () => written())
    })
  }

  async #passFromMac(size: number) {
    const bytes = Buffer.from(await this.#fromMac.read(size))
    await this.#send(bytes)
    return bytes
  }

  async #passFromViewer(size: number) {
    const bytes = Buffer.from(await this.#fromViewer.read(size))
    await this.#write(bytes)
    return bytes
  }

  // The Mac's reason for refusing, which is all that follows.
  #passRefusal() {
    let left = MAX_REFUSAL_BYTES
    this.#fromMac.drainTo((chunk) => {
      left -= chunk.length
      if (left < 0) this.#close()
      else void this.#send(chunk)
    })
  }

  // Everything up to the desktop is between the viewer and the Mac. It's
  // followed only to know where it ends. Once sign-in has failed, the Mac's
  // reason goes straight through.
  async #signIn(): Promise<boolean> {
    await this.#passFromMac(12)
    await this.#passFromViewer(12)
    const offered = (await this.#passFromMac(1))[0] ?? 0
    if (offered === 0) {
      this.#passRefusal()
      return false
    }
    await this.#passFromMac(offered)
    const chosen = (await this.#passFromViewer(1))[0]
    if (chosen === SECURITY_ARD) {
      const header = await this.#passFromMac(4)
      const keyLength = header.readUInt16BE(2)
      await this.#passFromMac(keyLength * 2)
      await this.#passFromViewer(128 + keyLength)
    } else if (chosen === SECURITY_VNC) {
      await this.#passFromMac(16)
      await this.#passFromViewer(16)
    } else if (chosen !== SECURITY_NONE) {
      this.#close()
      return false
    }
    const result = await this.#passFromMac(4)
    if (result.readUInt32BE(0) !== 0) {
      this.#passRefusal()
      return false
    }
    await this.#passFromViewer(1)
    const init = Buffer.from(await this.#fromMac.read(24))
    const width = init.readUInt16BE(0)
    const height = init.readUInt16BE(2)
    const nameBytes = init.readUInt32BE(20)
    if (!holdable(width, height) || nameBytes > MAX_DESKTOP_NAME_BYTES) {
      this.#close()
      return false
    }
    this.#image = { height, width }
    await this.#send(init)
    await this.#passFromMac(nameBytes)
    await this.#write(startPasteboard())

    const format = Buffer.alloc(20)
    format[4] = 32 // bits per pixel
    format[5] = 24 // depth
    format[7] = 1 // true colour, little-endian: R, G, B, unused in memory
    format.writeUInt16BE(255, 8)
    format.writeUInt16BE(255, 10)
    format.writeUInt16BE(255, 12)
    format[15] = 8
    format[16] = 16
    await this.#write(format)
    const encodings = [RAW, DESKTOP_SIZE, CURSOR]
    const message = Buffer.alloc(4 + encodings.length * 4)
    message[0] = 2
    message.writeUInt16BE(encodings.length, 2)
    encodings.forEach((encoding, index) =>
      message.writeInt32BE(encoding, 4 + index * 4)
    )
    await this.#write(message)
    return true
  }

  async #readMac() {
    for (;;) {
      const type = (await this.#fromMac.read(1))[0]
      if (type === 0) {
        await this.#readUpdate()
      } else if (type === 2) {
        await this.#send(Buffer.from([2]))
      } else if (type === 3) {
        const header = Buffer.from(await this.#fromMac.read(7))
        const length = header.readUInt32BE(3)
        if (length > MAX_PASTEBOARD_TEXT_BYTES) return this.#close()
        const text = await this.#fromMac.read(length)
        await this.#send([Buffer.from([3]), header, text])
      } else if (type === MISC_STATUS) {
        const status = await this.#fromMac.read(7)
        if (status.readUInt16BE(5) === PASTEBOARD_CHANGED) {
          await this.#write(fetchPasteboard())
        }
      } else if (type === PASTEBOARD) {
        await this.#readPasteboard()
      } else {
        return this.#close()
      }
    }
  }

  // In pieces, as a large one would overflow what's held of the connection.
  async #readPasteboard() {
    // The Mac's report of an image the viewer gave it comes next, or not at all.
    const pastedImage = this.#pastedImage
    this.#pastedImage = null
    const header = await this.#fromMac.read(15)
    const size = header.readUInt32BE(11)
    const keep = size <= MAX_PASTEBOARD_ARCHIVE_BYTES
    const pieces: Array<Buffer> = []
    for (let left = size; left > 0; left -= ARCHIVE_CHUNK_BYTES) {
      const piece = await this.#fromMac.read(
        Math.min(left, ARCHIVE_CHUNK_BYTES)
      )
      if (keep) pieces.push(Buffer.from(piece))
    }
    if (!keep) return
    const contents = await pasteboardContents(Buffer.concat(pieces))
    if (!contents) return
    if ("text" in contents) return this.#sendCutText([contents.text])
    if (imageId(contents.image) === pastedImage) return
    await this.#sendCutText([CLIPBOARD_IMAGE, contents.image])
  }

  // Which the page reads as UTF-8, rather than VNC's Latin-1.
  #sendCutText(parts: ReadonlyArray<Buffer>) {
    const header = Buffer.alloc(8)
    header[0] = 3
    header.writeUInt32BE(
      parts.reduce((total, part) => total + part.length, 0),
      4
    )
    return this.#send([header, ...parts])
  }

  async #readUpdate() {
    const count = (await this.#fromMac.read(3)).readUInt16BE(1)
    for (let index = 0; index < count; index += 1) {
      const header = await this.#fromMac.read(12)
      const x = header.readUInt16BE(0)
      const y = header.readUInt16BE(2)
      const width = header.readUInt16BE(4)
      const height = header.readUInt16BE(6)
      const encoding = header.readInt32BE(8)
      if (encoding === RAW) {
        await this.#readPixels({ height, width, x, y })
      } else if (encoding === CURSOR) {
        if (width > MAX_CURSOR_SIZE || height > MAX_CURSOR_SIZE) {
          return this.#close()
        }
        const size = width * height * 4 + Math.ceil(width / 8) * height
        const shape = await this.#fromMac.read(size)
        await this.#send(
          update([
            Buffer.concat([
              rectangleHeader({ height, width, x, y }, CURSOR),
              shape,
            ]),
          ])
        )
      } else if (encoding === DESKTOP_SIZE) {
        if (!holdable(width, height)) return this.#close()
        if (width !== this.#image.width || height !== this.#image.height) {
          this.#image = { height, width }
          this.#view = null
          await this.#send(imageSizeNotice(width, height))
        }
      } else {
        return this.#close()
      }
    }
    this.#asked = false
    this.#updatedAt = Date.now()
    this.#step()
  }

  async #readPixels(rectangle: Rectangle) {
    const { height, width, x, y } = rectangle
    const view = this.#view
    const rowBytes = width * 4
    const area = view?.area
    const left = area ? Math.max(x, area.x) : 0
    const right = area ? Math.min(x + width, area.x + area.width) : 0
    const top = area ? Math.max(y, area.y) : 0
    const bottom = area ? Math.min(y + height, area.y + area.height) : 0
    for (let row = y; row < y + height; row += 1) {
      const pixels =
        this.#fromMac.take(rowBytes) ?? (await this.#fromMac.read(rowBytes))
      if (view && area && row >= top && row < bottom && left < right) {
        pixels.copy(
          view.frame,
          ((row - area.y) * view.frameWidth + (left - area.x)) * 4,
          (left - x) * 4,
          (right - x) * 4
        )
      }
    }
    if (view && area && left < right && top < bottom) {
      view.changed = union(view.changed, {
        height: bottom - top,
        width: right - left,
        x: left - area.x,
        y: top - area.y,
      })
    }
  }

  async #readViewer() {
    for (;;) {
      const type = (await this.#fromViewer.read(1))[0]
      if (type === 0) {
        await this.#fromViewer.read(19)
      } else if (type === 2) {
        const count = (await this.#fromViewer.read(3)).readUInt16BE(1)
        await this.#fromViewer.read(count * 4)
      } else if (type === 3) {
        await this.#fromViewer.read(9)
        this.#viewerReady = true
        this.#step()
      } else if (type === 4) {
        const key = await this.#fromViewer.read(7)
        await this.#write(Buffer.concat([Buffer.from([4]), key]))
      } else if (type === 5) {
        await this.#pointer(await this.#fromViewer.read(5))
      } else if (type === 6) {
        const header = Buffer.from(await this.#fromViewer.read(7))
        const length = header.readUInt32BE(3)
        if (length > MAX_VIEWER_CUT_BYTES) return this.#close()
        const cut = Buffer.from(await this.#fromViewer.read(length))
        const image = clipboardImage(cut)
        this.#pastedImage = image && imageId(image)
        // Waited for here, so a paste that follows finds it there.
        await this.#write(await pasteboardMessage(cut))
      } else if (type === VIEW_MESSAGE) {
        const view = Buffer.from(await this.#fromViewer.read(13))
        this.#wanted = view
        await this.#show(view)
      } else {
        return this.#close()
      }
    }
  }

  // The viewer points at its small picture: this is where that is on the Mac.
  async #pointer(event: Buffer) {
    const view = this.#view
    if (!view) return
    this.#inputAt = Date.now()
    const { area } = view
    const message = Buffer.alloc(6)
    message[0] = 5
    message[1] = event[0] ?? 0
    const onMac = (position: number, start: number, size: number) =>
      start + Math.min(Math.round(position / view.scale), size - 1)
    message.writeUInt16BE(onMac(event.readUInt16BE(1), area.x, area.width), 2)
    message.writeUInt16BE(onMac(event.readUInt16BE(3), area.y, area.height), 4)
    await this.#write(message)
  }

  // Which part of the Mac's image the viewer wants, and at what size.
  async #show(message: Buffer) {
    const image = this.#image
    const x = Math.min(message.readUInt16BE(0), image.width - 1)
    const y = Math.min(message.readUInt16BE(2), image.height - 1)
    const area = {
      height: Math.min(Math.max(message.readUInt16BE(6), 1), image.height - y),
      width: Math.min(Math.max(message.readUInt16BE(4), 1), image.width - x),
      x,
      y,
    }
    // Lossless is every pixel, exactly: nothing to scale.
    const lossless = ((message[12] ?? 0) & LOSSLESS) !== 0
    this.#fastMotion = ((message[12] ?? 0) & FAST_MOTION) !== 0
    if (((message[12] ?? 0) & DECODES_VIDEO) !== 0 && !this.#videoGone) {
      this.#video ??= this.#openVideo()
    }
    const hasVideo = this.#video !== null
    if (hasVideo !== this.#videoShown) {
      this.#videoShown = hasVideo
      await this.#send(videoNotice(hasVideo))
    }
    const video = hasVideo && !lossless
    const steps = Math.ceil(
      Math.max(
        message.readUInt16BE(8) / area.width,
        message.readUInt16BE(10) / area.height
      ) * SCALE_STEPS
    )
    const whole = (size: number) =>
      lossless ? size : Math.ceil(size / SCALE_STEPS) * SCALE_STEPS
    const frameWidth = whole(area.width)
    const frameHeight = whole(area.height)
    const mostSteps = video
      ? Math.floor(
          Math.sqrt(MAX_VIDEO_PIXELS / (frameWidth * frameHeight)) * SCALE_STEPS
        )
      : SCALE_STEPS
    const scale = lossless
      ? 1
      : Math.min(Math.max(steps, 1), mostSteps, SCALE_STEPS) / SCALE_STEPS
    // Video's sizes are even, as 4:2:0 needs.
    const fitted = (size: number) => (video ? size - (size % 2) : size)
    const width = fitted(frameWidth * scale)
    const height = fitted(frameHeight * scale)
    const shown = this.#view
    if (
      shown &&
      shown.lossless === lossless &&
      shown.video === video &&
      shown.width === width &&
      shown.height === height &&
      shown.area.x === x &&
      shown.area.y === y &&
      shown.area.width === area.width &&
      shown.area.height === area.height
    ) {
      return
    }
    this.#view = {
      area,
      changed: null,
      frame: Buffer.alloc(frameWidth * frameHeight * 4),
      frameHeight,
      frameWidth,
      height,
      lossless,
      rough: null,
      scale,
      video,
      width,
    }
    this.#ask(false)
    await this.#send(
      update([rectangleHeader({ height, width, x: 0, y: 0 }, DESKTOP_SIZE)])
    )
  }

  #ask(incremental: boolean) {
    const area = this.#view?.area
    if (!area) return
    const request = Buffer.alloc(10)
    request[0] = 3
    request[1] = incremental ? 1 : 0
    request.writeUInt16BE(area.x, 2)
    request.writeUInt16BE(area.y, 4)
    request.writeUInt16BE(area.width, 6)
    request.writeUInt16BE(area.height, 8)
    this.#asked = true
    this.#askedAt = performance.now()
    this.#mac.write(request)
  }

  // Fetching from the Mac and preparing for the viewer overlap, so each stage
  // only has to keep up with itself, and at most one update waits between
  // them, so nothing old queues up on the way.
  #step() {
    const view = this.#view
    if (!view) return
    if (view.changed && this.#viewerReady && !this.#encoding) {
      const changed = view.changed
      view.changed = null
      if (view.video) {
        view.rough = union(view.rough, changed)
        this.#encodeVideo(view, changed, false)
      } else {
        const small =
          changed.width * changed.height <
          view.area.width * view.area.height * SMALL_CHANGE
        if (!small && !view.lossless) view.rough = union(view.rough, changed)
        this.#encode(view, changed, small ? SHARP : ROUGH)
      }
    }
    if (!view.changed && !this.#asked) this.#ask(true)
  }

  #tick() {
    const view = this.#view
    if (!view) return
    const now = Date.now()
    if (
      view.rough &&
      !view.changed &&
      this.#viewerReady &&
      !this.#encoding &&
      now - this.#sentAt > SHARPEN_AFTER_MS
    ) {
      const rough = view.rough
      view.rough = null
      if (view.video) this.#encodeVideo(view, null, true)
      else this.#encode(view, rough, SHARP)
    }
    if (!this.#asked) return
    const asking = performance.now() - this.#askedAt
    if (asking < ASK_AGAIN_MS) return
    const stuck =
      now - this.#updatedAt > REFRESH_AFTER_MS &&
      now - this.#inputAt < RECENT_INPUT_MS
    this.#ask(!stuck)
  }

  // What's changed goes to the encoder, which keeps the whole picture. No
  // change is the same picture again, sharper.
  #encodeVideo(view: View, changed: Rectangle | null, sharpen: boolean) {
    const video = this.#video
    if (!video) return
    this.#encoding = true
    this.#viewerReady = false
    if (this.#videoView !== view) {
      this.#videoView = view
      this.#videoReset = true
      video.size(
        { height: view.frameHeight, width: view.frameWidth },
        { height: view.height, width: view.width }
      )
    }
    const area = changed ?? { height: 0, width: 0, x: 0, y: 0 }
    forkPromise(
      async () => {
        const encoded = await video.encode(
          view.frame,
          view.frameWidth,
          area,
          sharpen
        )
        if (encoded === null) {
          await this.#loseVideo()
          return
        }
        if (this.#view === view && encoded.length > 0) {
          const flags = this.#videoReset ? H264_RESET : 0
          this.#videoReset = false
          this.#sentAt = Date.now()
          await this.#send(update([videoRectangle(view, encoded, flags)]))
        } else {
          this.#viewerReady = true
        }
        this.#encoding = false
        this.#step()
      },
      () => this.#close()
    )
  }

  // JPEG takes over, at a size it can scale to, and the stream carries on.
  async #loseVideo() {
    this.#video?.close()
    this.#video = null
    this.#videoGone = true
    this.#videoView = null
    this.#viewerReady = true
    this.#encoding = false
    if (this.#closed || !this.#wanted) return
    await this.#show(this.#wanted)
    this.#step()
  }

  #encode(view: View, changed: Rectangle, jpeg: JpegQuality) {
    this.#encoding = true
    this.#viewerReady = false
    const { frameHeight, frameWidth, scale } = view
    const tiled = (position: number) => Math.floor(position / TILE) * TILE
    const left = tiled(changed.x)
    const top = tiled(changed.y)
    const right = Math.min(
      Math.ceil((changed.x + changed.width) / TILE) * TILE,
      frameWidth
    )
    const bottom = Math.min(
      Math.ceil((changed.y + changed.height) / TILE) * TILE,
      frameHeight
    )
    // Scaling blends neighbours, so it reads a little past the tiles and that
    // margin is cut off again after.
    const margin = view.lossless ? 0 : MARGIN
    const source = {
      left: Math.max(left - margin, 0),
      top: Math.max(top - margin, 0),
      width: 0,
      height: 0,
    }
    source.width = Math.min(right + margin, frameWidth) - source.left
    source.height = Math.min(bottom + margin, frameHeight) - source.top
    // A copy, since the next update is already arriving in the frame. The Mac
    // leaves each pixel's unused byte empty, which the scaler would read as
    // transparent. A moving picture in fast motion keeps every second pixel
    // and row, for a quarter of the scaling: too few only when it's scaled
    // down less than that.
    const skipped =
      this.#fastMotion && jpeg === ROUGH && !view.lossless && scale <= 0.5
    const stride = skipped ? 2 : 1
    const copied = {
      height: source.height / stride,
      width: source.width / stride,
    }
    const rowBytes = copied.width * 4
    const bytes = rowBytes * copied.height
    if (this.#snapshot.length < bytes) {
      this.#snapshot = Buffer.allocUnsafeSlow(bytes)
    }
    const snapshot = this.#snapshot
    const pixels = new Uint32Array(
      snapshot.buffer,
      snapshot.byteOffset,
      bytes / 4
    )
    if (skipped) {
      const frame = new Uint32Array(
        view.frame.buffer,
        view.frame.byteOffset,
        view.frame.length / 4
      )
      let next = 0
      for (let row = 0; row < copied.height; row += 1) {
        const start = (source.top + row * 2) * frameWidth + source.left
        for (let column = 0; column < copied.width; column += 1) {
          pixels[next] = (frame[start + column * 2] ?? 0) | 0xff000000
          next += 1
        }
      }
    } else {
      for (let row = 0; row < copied.height; row += 1) {
        const start = ((row + source.top) * frameWidth + source.left) * 4
        view.frame.copy(snapshot, row * rowBytes, start, start + rowBytes)
      }
      for (let index = 0; index < pixels.length; index += 1) {
        pixels[index] = (pixels[index] ?? 0) | 0xff000000
      }
    }
    const shown = {
      height: (bottom - top) * scale,
      width: (right - left) * scale,
      x: left * scale,
      y: top * scale,
    }
    const raw = {
      raw: { channels: 4 as const, height: copied.height, width: copied.width },
    }
    const image = snapshot.subarray(0, bytes)
    forkPromise(
      async () => {
        const rectangles = view.lossless
          ? await pngRectangles(image, shown)
          : await jpegRectangles(image, raw, jpeg, {
              height: source.height * scale,
              marginLeft: (left - source.left) * scale,
              marginTop: (top - source.top) * scale,
              shown,
              width: source.width * scale,
            })
        // A view that's gone was all this was for. Otherwise this stage stays
        // busy until the viewer's taken it, so a slow one holds back the next.
        if (this.#view === view) {
          this.#sentAt = Date.now()
          await this.#send(update(rectangles))
        } else {
          this.#viewerReady = true
        }
        this.#encoding = false
        this.#step()
      },
      () => this.#close()
    )
  }
}

interface Scaled {
  readonly height: number
  readonly marginLeft: number
  readonly marginTop: number
  readonly shown: Rectangle
  readonly width: number
}

// One JPEG, or, if it's more than Tight can carry, as pictures only noise
// makes it, two halves that stay on JPEG's blocks.
async function jpegRectangles(
  image: Buffer,
  raw: { readonly raw: Raw },
  jpeg: JpegQuality,
  scaled: Scaled
): Promise<Array<Buffer>> {
  const { height, marginLeft, marginTop, shown, width } = scaled
  const encoded = await sharp(image, raw)
    .resize(width, height, { fit: "fill", kernel: "cubic" })
    .extract({
      height: shown.height,
      left: marginLeft,
      top: marginTop,
      width: shown.width,
    })
    .removeAlpha()
    .jpeg(jpeg)
    .toBuffer()
  if (encoded.length <= MAX_TIGHT_BYTES || shown.height <= JPEG_BLOCK) {
    return [tightRectangle(shown, TIGHT, TIGHT_JPEG, encoded)]
  }
  const half = Math.ceil(shown.height / (JPEG_BLOCK * 2)) * JPEG_BLOCK
  const [above, below] = await Promise.all([
    jpegRectangles(image, raw, jpeg, {
      ...scaled,
      shown: { ...shown, height: half },
    }),
    jpegRectangles(image, raw, jpeg, {
      ...scaled,
      marginTop: marginTop + half,
      shown: { ...shown, height: shown.height - half, y: shown.y + half },
    }),
  ])
  return [...above, ...below]
}

// Whatever fits, as strips the small length Tight allows can carry.
function pngRectangles(image: Buffer, shown: Rectangle) {
  const stripHeight = Math.max(Math.floor(MAX_PNG_PIXELS / shown.width), 1)
  const strips: Array<number> = []
  for (let top = 0; top < shown.height; top += stripHeight) strips.push(top)
  return Promise.all(
    strips.map(async (top) => {
      const height = Math.min(stripHeight, shown.height - top)
      const png: Buffer = await sharp(image, {
        raw: { channels: 4, height: shown.height, width: shown.width },
      })
        .extract({ height, left: 0, top, width: shown.width })
        .removeAlpha()
        .png(PNG)
        .toBuffer()
      return tightRectangle(
        { ...shown, height, y: shown.y + top },
        TIGHT_PNG,
        TIGHT_PNG_DATA,
        png
      )
    })
  )
}
