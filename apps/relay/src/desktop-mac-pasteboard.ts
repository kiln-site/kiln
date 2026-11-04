import { promisify } from "node:util"
import { constants, deflate, inflate } from "node:zlib"

import sharp from "sharp"

import { recoverPromise } from "./effect/promise.js"

// A Mac's clipboard, in Apple's own messages. macOS ignores VNC's cut text, in
// both directions, so a viewer's clipboard has to go the way Apple's own viewer
// sends it. None of this is documented: it's as measured against a Mac, and
// https://github.com/andrewtheguy/remotex has the protocol written up.
//
// Those messages work on the plain RFB 3.8 session noVNC opens, so nothing about
// sign-in or the picture changes. Apple's ViewerInfo, SetMode(control) and
// AutoPasteboard(start), in that order, make the Mac say when its pasteboard
// changes. Each change is then fetched, as a zlib archive of every format of
// every item on it: a line of text can come with megabytes of rich text and
// images, so only the one part the viewer can use is kept. That's text if there
// is any, as copying from a document brings a picture of it too, and otherwise an
// image, as PNG, the one kind a browser's clipboard takes.
//
// Both go on over VNC's cut text, one way and the other. An image starts with
// `CLIPBOARD_IMAGE`, and the page's relay-desktop-clipboard.tsx knows it too.

export const MISC_STATUS = 0x14
export const PASTEBOARD = 0x1f
export const PASTEBOARD_CHANGED = 2
/** What's kept of a clipboard, either way. */
export const MAX_PASTEBOARD_TEXT_BYTES = 1024 * 1024
/** What's kept of an image, either way: it fits one of a viewer's messages. */
export const MAX_PASTEBOARD_IMAGE_BYTES = 15 * 1024 * 1024
/** What's read of an archive. A larger one is skipped. */
export const MAX_PASTEBOARD_ARCHIVE_BYTES = 64 * 1024 * 1024
/** Marks cut text as an image: text doesn't start with a NUL. */
export const CLIPBOARD_IMAGE = Buffer.from("\0kiln-image\0")

// A 5K display's picture, uncompressed, with room for what comes with it.
const MAX_INFLATED_BYTES = 128 * 1024 * 1024
// As many as a stream's picture can have, before decoding one.
const MAX_TIFF_PIXELS = 60_000_000
const TEXT_FLAVOR = Buffer.from("public.utf8-plain-text")
const PNG_FLAVOR = Buffer.from("public.png")
const TIFF_FLAVOR = Buffer.from("public.tiff")
const SET_MODE_CONTROL = Buffer.from([0x0a, 0, 0, 1])
const AUTO_PASTEBOARD_START = Buffer.from([0x15, 0, 0, 1, 0, 0, 0, 0])
// Apple's viewer's version, which the Mac uses to choose how to read keys.
const VIEWER_VERSION = [6, 1, 0] as const
const VIEWER_OS_VERSION = [26, 6, 2] as const

const deflated = promisify<Buffer, { finishFlush: number }, Buffer>(deflate)
const inflated = promisify<
  Buffer,
  { finishFlush: number; maxOutputLength: number },
  Buffer
>(inflate)

function u32(value: number) {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(value)
  return bytes
}

// 66 bytes, or the Mac takes the next message for its end. The bitmap lists the
// server messages this reader follows, as anything else ends the stream: a bit
// for each type, highest first: FramebufferUpdate, Bell, ServerCutText,
// MiscStatus and the pasteboard.
function viewerInfo() {
  const message = Buffer.alloc(66)
  message[0] = 0x21
  message.writeUInt16BE(62, 2)
  message.writeUInt16BE(1, 4) // A generic viewer,
  message.writeUInt32BE(2, 6) // and Screen Sharing.
  VIEWER_VERSION.forEach((part, index) =>
    message.writeUInt32BE(part, 10 + index * 4)
  )
  VIEWER_OS_VERSION.forEach((part, index) =>
    message.writeUInt32BE(part, 22 + index * 4)
  )
  message[34] = 0b1011_0000
  message[36] = 0b0000_1000
  message[37] = 0b0000_0001
  return message
}

/** What makes a Mac say when its pasteboard changes. */
export const startPasteboard = () =>
  Buffer.concat([viewerInfo(), SET_MODE_CONTROL, AUTO_PASTEBOARD_START])

/** Asks a Mac for all that's on its pasteboard. */
export const fetchPasteboard = () => Buffer.from([0x0b, 0, 0, 0, 0, 0, 0, 0])

/** The image in cut text from a viewer, if that's what it is. */
export const clipboardImage = (cutText: Buffer) =>
  cutText.subarray(0, CLIPBOARD_IMAGE.length).equals(CLIPBOARD_IMAGE)
    ? cutText.subarray(CLIPBOARD_IMAGE.length)
    : null

/** Puts a viewer's cut text, words or an image, on a Mac's pasteboard. */
export async function pasteboardMessage(cutText: Buffer) {
  const image = clipboardImage(cutText)
  const flavor = image ? PNG_FLAVOR : TEXT_FLAVOR
  const data = image ?? cutText
  const archive = Buffer.concat([
    u32(1), // One item, in one format,
    u32(flavor.length),
    flavor,
    u32(0), // reserved,
    u32(0), // with no tags,
    u32(data.length),
    data,
  ])
  const compressed = await deflated(archive, {
    finishFlush: constants.Z_SYNC_FLUSH,
  })
  return Buffer.concat([
    Buffer.from([PASTEBOARD, 0, 0, 0, 0, 0, 0, 0]),
    u32(archive.length),
    u32(compressed.length),
    compressed,
  ])
}

export type PasteboardContents =
  | { readonly image: Buffer }
  | { readonly text: Buffer }

/**
 * What a viewer can use of a pasteboard archive, or null when there's nothing
 * that fits. It comes from the Mac's clipboard, which any app there can fill, so
 * a bad one is only a clipboard not mirrored: nothing here should end the stream.
 */
export async function pasteboardContents(
  compressed: Buffer
): Promise<PasteboardContents | null> {
  return recoverPromise(
    async () => {
      const archive = await inflated(compressed, {
        finishFlush: constants.Z_SYNC_FLUSH,
        maxOutputLength: MAX_INFLATED_BYTES,
      })
      const { png, text, tiff } = usefulFormats(archive)
      if (text) {
        return text.length <= MAX_PASTEBOARD_TEXT_BYTES
          ? { text: Buffer.from(text) }
          : null
      }
      const image =
        png ??
        (tiff &&
          (await sharp(tiff, { limitInputPixels: MAX_TIFF_PIXELS })
            .png({ compressionLevel: 3 })
            .toBuffer()))
      return image && image.length <= MAX_PASTEBOARD_IMAGE_BYTES
        ? { image: Buffer.from(image) }
        : null
    },
    () => null
  )
}

// A run of items, each a count of formats. A format is a counted name, a reserved
// word, a count of counted tags, and counted data. Reads past the end throw. A
// format with no data is a promise of something the Mac hasn't made yet.
function usefulFormats(archive: Buffer) {
  const found: { png?: Buffer; text?: Buffer; tiff?: Buffer } = {}
  let at = 0
  const number = () => {
    const value = archive.readUInt32BE(at)
    at += 4
    return value
  }
  const counted = () => {
    const size = number()
    if (size > archive.length - at) throw new RangeError("Past the archive")
    at += size
    return archive.subarray(at - size, at)
  }
  while (at < archive.length) {
    const formats = number()
    for (let format = 0; format < formats; format += 1) {
      const name = counted()
      number()
      const tags = number()
      for (let tag = 0; tag < tags; tag += 1) {
        counted()
        counted()
      }
      const data = counted()
      if (data.length === 0) continue
      if (name.equals(TEXT_FLAVOR)) found.text ??= data
      else if (name.equals(PNG_FLAVOR)) found.png ??= data
      else if (name.equals(TIFF_FLAVOR)) found.tiff ??= data
    }
  }
  return found
}
