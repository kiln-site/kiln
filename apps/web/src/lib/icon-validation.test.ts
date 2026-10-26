import { describe, expect, it } from "vite-plus/test"

import { validateUploadedIcon } from "@/lib/icon-validation"

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

// A lossless WebP header, whose 14-bit sides are stored less one.
function webp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64)
  bytes.set(new TextEncoder().encode("RIFF"))
  bytes.set(new TextEncoder().encode("WEBPVP8L"), 8)
  bytes[20] = 0x2f
  const bits = (width - 1) | ((height - 1) << 14)
  new DataView(bytes.buffer).setUint32(21, bits, true)
  return bytes
}

describe("validateUploadedIcon", () => {
  it("accepts the WebP and PNG icons browsers prepare", () => {
    expect(validateUploadedIcon(webp(256, 256))).toBe("image/webp")
    expect(validateUploadedIcon(png(64, 64))).toBe("image/png")
  })

  it("refuses anything but WebP or PNG, whatever it's named", () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    )
    expect(() => validateUploadedIcon(svg)).toThrow("WebP or PNG")
    const html = new TextEncoder().encode("<!doctype html><p>hi</p>")
    expect(() => validateUploadedIcon(html)).toThrow("WebP or PNG")
    expect(() => validateUploadedIcon(new Uint8Array())).toThrow("empty")
  })

  it("refuses icons larger than they're ever drawn", () => {
    expect(() => validateUploadedIcon(png(4096, 4096))).toThrow("512×512")
    expect(() => validateUploadedIcon(webp(1024, 16))).toThrow("512×512")
  })

  it("refuses icons over the size limit", () => {
    const large = new Uint8Array(300 * 1024)
    large.set(png(64, 64))
    expect(() => validateUploadedIcon(large)).toThrow("256 KiB")
  })
})
