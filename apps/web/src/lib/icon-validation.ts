import { sniffIconImage } from "@workspace/contracts"

import { ICON_MAX_BYTES, ICON_MAX_DIMENSION } from "@/lib/icons"

// What Hearth accepts as a chosen icon. Browsers shrink and convert what
// people pick to WebP (or PNG where they can't write WebP), but uploads are
// still untrusted: the bytes must be one of those, small, and no larger
// than an icon is ever drawn.

export type UploadedIconType = "image/png" | "image/webp"

export function validateUploadedIcon(bytes: Uint8Array): UploadedIconType {
  if (bytes.byteLength === 0) throw new Error("The icon is empty")
  if (bytes.byteLength > ICON_MAX_BYTES) {
    throw new Error(`Icons must be at most ${ICON_MAX_BYTES / 1024} KiB`)
  }
  const type = sniffIconImage(bytes)
  if (type !== "image/png" && type !== "image/webp") {
    throw new Error("Icons must be WebP or PNG images")
  }
  const size = type === "image/png" ? pngSize(bytes) : webpSize(bytes)
  if (!size || size.width < 1 || size.height < 1) {
    throw new Error("The icon image is invalid")
  }
  if (size.width > ICON_MAX_DIMENSION || size.height > ICON_MAX_DIMENSION) {
    throw new Error(
      `Icons must be at most ${ICON_MAX_DIMENSION}×${ICON_MAX_DIMENSION} pixels`
    )
  }
  return type
}

interface ImageSize {
  height: number
  width: number
}

function view(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

// The IHDR chunk comes first, right after the signature.
function pngSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.byteLength < 24) return null
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null
  const data = view(bytes)
  return { width: data.getUint32(16), height: data.getUint32(20) }
}

// The first chunk after the RIFF header says how the image is encoded.
function webpSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.byteLength < 30) return null
  const data = view(bytes)
  const chunk = String.fromCharCode(...bytes.subarray(12, 16))
  if (chunk === "VP8X") {
    return { width: 1 + uint24(bytes, 24), height: 1 + uint24(bytes, 27) }
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return null
    const bits = data.getUint32(21, true)
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
  }
  if (chunk === "VP8 ") {
    // A key frame's start code, then its 14-bit dimensions.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      return null
    }
    return {
      width: data.getUint16(26, true) & 0x3fff,
      height: data.getUint16(28, true) & 0x3fff,
    }
  }
  return null
}

function uint24(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16)
  )
}
