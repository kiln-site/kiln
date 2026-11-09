import { constants, deflateSync } from "node:zlib"

import sharp from "sharp"
import { describe, expect, it } from "vite-plus/test"

import { pasteboardContents } from "./desktop-mac-pasteboard.js"

const TEXT = "public.utf8-plain-text"
const TIFF = "public.tiff"

const number = (value: number) => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(value)
  return bytes
}

const counted = (bytes: Buffer) => Buffer.concat([number(bytes.length), bytes])

const format = (name: string, data: Buffer) =>
  Buffer.concat([
    counted(Buffer.from(name)),
    number(0),
    number(0),
    counted(data),
  ])

const item = (...formats: ReadonlyArray<Buffer>) =>
  Buffer.concat([number(formats.length), ...formats])

const packed = (...items: ReadonlyArray<Buffer>) =>
  deflateSync(Buffer.concat(items), { finishFlush: constants.Z_SYNC_FLUSH })

// The pasteboard comes from the desktop session, so it is untrusted input.
describe("a pasteboard from a Mac", () => {
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
