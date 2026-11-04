import { constants, deflateSync, inflateSync } from "node:zlib"

import sharp from "sharp"
import { describe, expect, it } from "vite-plus/test"

import {
  CLIPBOARD_IMAGE,
  MAX_PASTEBOARD_IMAGE_BYTES,
  MAX_PASTEBOARD_TEXT_BYTES,
  pasteboardContents,
  pasteboardMessage,
} from "./desktop-mac-pasteboard.js"

const TEXT = "public.utf8-plain-text"
const PNG = "public.png"
const TIFF = "public.tiff"

const picture = () =>
  sharp({
    create: {
      background: { b: 0, g: 0, r: 200 },
      channels: 3,
      height: 4,
      width: 6,
    },
  })

const number = (value: number) => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(value)
  return bytes
}

const counted = (bytes: Buffer) => Buffer.concat([number(bytes.length), bytes])

const format = (
  name: string,
  data: Buffer,
  tags: ReadonlyArray<readonly [string, string]> = []
) =>
  Buffer.concat([
    counted(Buffer.from(name)),
    number(0),
    number(tags.length),
    ...tags.flatMap(([key, value]) => [
      counted(Buffer.from(key)),
      counted(Buffer.from(value)),
    ]),
    counted(data),
  ])

const item = (...formats: ReadonlyArray<Buffer>) =>
  Buffer.concat([number(formats.length), ...formats])

const packed = (...items: ReadonlyArray<Buffer>) =>
  deflateSync(Buffer.concat(items), { finishFlush: constants.Z_SYNC_FLUSH })

describe("a pasteboard from a Mac", () => {
  it("finds the text behind other formats, tags, and items", async () => {
    const archive = packed(
      item(format("public.png", Buffer.alloc(1024, 9))),
      item(
        format("public.rtf", Buffer.from("{\\rtf1}"), [["key", "value"]]),
        format(TEXT, Buffer.from("héllo → 🙂"), [["key", "value"]])
      )
    )
    expect(await pasteboardContents(archive)).toEqual({
      text: Buffer.from("héllo → 🙂"),
    })
  })

  it("has nothing for a viewer when nothing on it is of use", async () => {
    const archive = packed(item(format("com.adobe.pdf", Buffer.alloc(16, 9))))
    expect(await pasteboardContents(archive)).toBeNull()
  })

  it("takes an image as it is", async () => {
    const png = await picture().png().toBuffer()
    const archive = packed(
      item(format(TIFF, Buffer.alloc(8)), format(PNG, png))
    )
    expect(await pasteboardContents(archive)).toEqual({ image: png })
  })

  it("turns an image only a Mac would read into PNG", async () => {
    const tiff = await picture().tiff().toBuffer()
    const contents = await pasteboardContents(packed(item(format(TIFF, tiff))))
    if (!contents || !("image" in contents)) throw new Error("No image")
    const shown = await sharp(contents.image).metadata()
    expect(shown).toMatchObject({ format: "png", height: 4, width: 6 })
  })

  it("prefers text, as copying from a document brings a picture of it", async () => {
    const png = await picture().png().toBuffer()
    const archive = packed(
      item(format(PNG, png), format(TEXT, Buffer.from("words")))
    )
    expect(await pasteboardContents(archive)).toEqual({
      text: Buffer.from("words"),
    })
  })

  it("keeps no larger an image than it can carry", async () => {
    const image = Buffer.alloc(MAX_PASTEBOARD_IMAGE_BYTES + 1, 9)
    expect(
      await pasteboardContents(packed(item(format(PNG, image))))
    ).toBeNull()
  })

  it("won't decode a TIFF with more pixels than a picture can have", async () => {
    const tiff = await sharp({
      create: {
        background: { b: 0, g: 0, r: 0 },
        channels: 3,
        height: 10_000,
        width: 7_000,
      },
    })
      .tiff({ compression: "deflate" })
      .toBuffer()
    expect(
      await pasteboardContents(packed(item(format(TIFF, tiff))))
    ).toBeNull()
  })

  it("survives an image that isn't one", async () => {
    const archive = packed(item(format(TIFF, Buffer.from("not a picture"))))
    expect(await pasteboardContents(archive)).toBeNull()
  })

  it("has none for a format that's only a promise", async () => {
    const archive = packed(item(format(TEXT, Buffer.alloc(0))))
    expect(await pasteboardContents(archive)).toBeNull()
  })

  it("keeps no more text than it can carry", async () => {
    const text = Buffer.alloc(MAX_PASTEBOARD_TEXT_BYTES + 1, 0x61)
    expect(
      await pasteboardContents(packed(item(format(TEXT, text))))
    ).toBeNull()
  })

  it("isn't taken past the end by a count", async () => {
    const lying = Buffer.concat([
      number(1),
      number(Buffer.byteLength(TEXT)),
      Buffer.from(TEXT),
      number(0),
      number(0),
      number(0xffff_ffff),
      Buffer.from("short"),
    ])
    expect(await pasteboardContents(packed(lying))).toBeNull()
  })

  it("survives what doesn't inflate", async () => {
    expect(await pasteboardContents(Buffer.from([1, 2, 3, 4]))).toBeNull()
  })

  it("won't inflate without limit", async () => {
    const bomb = packed(
      item(
        format("com.adobe.pdf", Buffer.alloc(129 * 1024 * 1024)),
        format(TEXT, Buffer.from("after"))
      )
    )
    expect(await pasteboardContents(bomb)).toBeNull()
  })
})

describe("a pasteboard for a Mac", () => {
  it("carries text as UTF-8, and says how long it is", async () => {
    const message = await pasteboardMessage(Buffer.from("héllo → 🙂"))
    expect(message[0]).toBe(0x1f)
    const compressed = message.subarray(16)
    expect(message.readUInt32BE(12)).toBe(compressed.length)
    const archive = inflateSync(compressed, {
      finishFlush: constants.Z_SYNC_FLUSH,
    })
    expect(message.readUInt32BE(8)).toBe(archive.length)
    expect(await pasteboardContents(compressed)).toEqual({
      text: Buffer.from("héllo → 🙂"),
    })
  })

  it("carries an image as PNG", async () => {
    const png = await picture().png().toBuffer()
    const cutText = Buffer.concat([CLIPBOARD_IMAGE, png])
    const message = await pasteboardMessage(cutText)
    expect(await pasteboardContents(message.subarray(16))).toEqual({
      image: png,
    })
  })
})
