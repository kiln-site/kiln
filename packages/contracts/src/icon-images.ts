import { Result } from "effect"

// The image formats an icon may be, told apart by their first bytes rather
// than by a name or a declared type. Kiln reads icons from files and sites
// it doesn't control, so only what is one of these is kept or passed on.

export const iconImageContentTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/x-icon",
  "image/svg+xml",
] as const

export type IconImageContentType = (typeof iconImageContentTypes)[number]

function startsWith(bytes: Uint8Array, prefix: ReadonlyArray<number>) {
  return (
    bytes.length >= prefix.length &&
    prefix.every((value, index) => bytes[index] === value)
  )
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.subarray(start, end))
}

/** The image format `bytes` hold, or null for anything else. */
export function sniffIconImage(bytes: Uint8Array): IconImageContentType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png"
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") {
    return "image/gif"
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return "image/webp"
  }
  // An icon directory with at least one image.
  if (
    startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) &&
    bytes.length > 6 &&
    (bytes[4] ?? 0) + (bytes[5] ?? 0) > 0
  ) {
    return "image/x-icon"
  }
  return isSvgDocument(bytes) ? "image/svg+xml" : null
}

// An SVG is text whose first element is <svg>, after any XML declaration,
// comments, and doctype.
function isSvgDocument(bytes: Uint8Array): boolean {
  const decoded = Result.try(() =>
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, 4096))
  )
  // A multi-byte character cut at 4 KiB is still text.
  if (Result.isFailure(decoded) && bytes.length <= 4096) return false
  const text = Result.isSuccess(decoded)
    ? decoded.success
    : new TextDecoder("utf-8").decode(bytes.subarray(0, 4096))
  const head = text
    .replace(/^\uFEFF/u, "")
    .replace(/^\s*<\?xml[\s\S]*?\?>/u, "")
    .replace(/^(?:\s*<!--[\s\S]*?-->)*/u, "")
    .replace(/^\s*<!DOCTYPE[^>]*>/iu, "")
    .replace(/^(?:\s*<!--[\s\S]*?-->)*/u, "")
  return /^\s*<svg[\s>]/u.test(head)
}
