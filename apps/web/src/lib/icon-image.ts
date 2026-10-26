import { ensuringPromise, recoverPromise } from "@/effect/promise"
import {
  ICON_MAX_BYTES,
  ICON_SOURCE_MAX_BYTES,
  ICON_TARGET_DIMENSION,
} from "@/lib/icons"

// Prepares a picture someone chose as an icon, in their browser: square, at
// most 256 pixels a side, and WebP, so what's uploaded is small. Browsers
// that can't write WebP send PNG. Hearth checks the result again.

export interface PreparedIcon {
  readonly blob: Blob
  readonly previewUrl: string
}

/**
 * `cover` fills the square, cropping the longer side, as a profile picture
 * does; `contain` fits the whole image with clear space around it, which
 * suits logos.
 */
export type IconFit = "contain" | "cover"

// Smaller sizes and lower quality, tried in turn until the icon fits.
const ATTEMPTS = [
  { dimension: ICON_TARGET_DIMENSION, quality: 0.9 },
  { dimension: ICON_TARGET_DIMENSION, quality: 0.75 },
  { dimension: 192, quality: 0.75 },
  { dimension: 128, quality: 0.7 },
] as const

export async function prepareIconImage(
  source: Blob,
  fit: IconFit
): Promise<PreparedIcon> {
  if (source.size > ICON_SOURCE_MAX_BYTES * 2) {
    throw new Error("Choose an image smaller than 8 MB")
  }
  const image = await decodeImage(source)
  // The decoded image is let go however preparing it ends.
  return ensuringPromise(
    async () => {
    const width = image.naturalWidth || ICON_TARGET_DIMENSION
    const height = image.naturalHeight || ICON_TARGET_DIMENSION
    // Never enlarged, so pixel art like a Minecraft server icon stays sharp.
    const native =
      fit === "cover" ? Math.min(width, height) : Math.max(width, height)
    for (const attempt of ATTEMPTS) {
      const dimension = Math.max(1, Math.min(attempt.dimension, native))
      const canvas = document.createElement("canvas")
      canvas.width = dimension
      canvas.height = dimension
      const context = canvas.getContext("2d")
      if (!context) throw new Error("This browser can't prepare images")
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = "high"
      if (fit === "cover") {
        const side = Math.min(width, height)
        context.drawImage(
          image,
          (width - side) / 2,
          (height - side) / 2,
          side,
          side,
          0,
          0,
          dimension,
          dimension
        )
      } else {
        const scale = dimension / Math.max(width, height)
        const drawnWidth = width * scale
        const drawnHeight = height * scale
        context.drawImage(
          image,
          (dimension - drawnWidth) / 2,
          (dimension - drawnHeight) / 2,
          drawnWidth,
          drawnHeight
        )
      }
      const blob = await encode(canvas, attempt.quality)
      if (blob.size <= ICON_MAX_BYTES) {
        return { blob, previewUrl: URL.createObjectURL(blob) }
      }
    }
    throw new Error("This image can't be made small enough for an icon")
    },
    () => URL.revokeObjectURL(image.src)
  )
}

async function decodeImage(source: Blob): Promise<HTMLImageElement> {
  const image = new Image()
  image.decoding = "async"
  image.src = URL.createObjectURL(source)
  const decoded = await recoverPromise(
    () => image.decode().then(() => true),
    () => false
  )
  if (!decoded) {
    URL.revokeObjectURL(image.src)
    throw new Error("That file isn't an image this browser can open")
  }
  return image
}

async function encode(
  canvas: HTMLCanvasElement,
  quality: number
): Promise<Blob> {
  const webp = await toBlob(canvas, "image/webp", quality)
  // Browsers that can't write WebP return PNG instead.
  if (webp?.type === "image/webp") return webp
  const png =
    webp?.type === "image/png" ? webp : await toBlob(canvas, "image/png")
  if (!png) throw new Error("This browser can't prepare images")
  return png
}

function toBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

export function base64ToBlob(contentBase64: string, type: string): Blob {
  const binary = atob(contentBase64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new Blob([bytes], { type })
}
