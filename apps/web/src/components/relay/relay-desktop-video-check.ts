import { ensuringPromise, recoverPromise } from "@/effect/promise"

// Whether this browser can play a Mac's picture as H.264, tried on one real
// frame from the encoder (apps/desktop/encoder.c). noVNC has a check of its own
// that decides what it offers a server, but its sample fails to decode in Chrome
// on a Mac, whose H.264 works. So the page asks for video itself, and noVNC, which
// always holds a decoder, plays what comes. Browsers that say they can decode
// H.264 and then can't, as Firefox can, are why this decodes a frame at all.

const CODEC = "avc1.42c00a"
const SIZE = 64
// The stream waits on this, so a decoder that never answers counts as none.
const CHECK_MS = 2_000
const KEY_FRAME = [
  "AAAAAWdCwAraEJpqAhoMgAAAAwCAAAAeR4kTUAAAAAFozg/IAAABBgX//1XcRem9",
  "5tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2",
  "NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIzIC0gaHR0cDov",
  "L3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCBy",
  "ZWY9MSBkZWJsb2NrPTA6MDowIGFuYWx5c2U9MDowIG1lPWRpYSBzdWJtZT0wIHBz",
  "eT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTAgbWVfcmFuZ2U9MTYgY2hy",
  "b21hX21lPTEgdHJlbGxpcz0wIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDEx",
  "IGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PTAgdGhyZWFkcz0xIGxvb2th",
  "aGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEg",
  "aW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0w",
  "IGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PWluZmluaXRlIGtleWludF9taW49",
  "MzAgc2NlbmVjdXQ9MCBpbnRyYV9yZWZyZXNoPTAgcmM9Y3JmIG1idHJlZT0wIGNy",
  "Zj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9y",
  "YXRpbz0xLjQwIGFxPTAAgAAAAWWIhDoMYBwACZQBywABD/rD9/f39/f39/f39/f3",
  "9/f38MAoAAIFkMAI75Ozs7OD3x7498e+F1DgIcMQW9u7u9vbu7uIQOIAAgBMrKls",
  "VlsVhdQOAhwQgd3d3d3d3d3cQg4gACAEqqqKxWKxWF1A4CHDEDu7u7u7u7u7iEDi",
  "AAIASqqorFYrFYWw4ABMAcAMZV1tt11ttttttttttiAEBUIAEAqZ2dnZx7498e+P",
  "fEkm/pSS8SSftC2BwACYA4AYybbbbbbbbbbbbbbbbEAIHQgAQDpnZ2dnHvj3x749",
  "8pJNKSfCkk4WwHAAJgDyACJG222222222222222xACAqEACAVM7Ozs498e+PfHvl",
  "JlJE+JJtgA==",
].join("")

async function decodesKeyFrame() {
  let frames = 0
  const decoder = new VideoDecoder({
    error: () => undefined,
    output: (frame) => {
      frames += 1
      frame.close()
    },
  })
  return ensuringPromise(
    async () => {
      decoder.configure({
        codec: CODEC,
        codedHeight: SIZE,
        codedWidth: SIZE,
        optimizeForLatency: true,
      })
      decoder.decode(
        new EncodedVideoChunk({
          data: Uint8Array.from(atob(KEY_FRAME), (byte) => byte.charCodeAt(0)),
          timestamp: 0,
          type: "key",
        })
      )
      await Promise.race([
        decoder.flush(),
        new Promise((resolve) => setTimeout(resolve, CHECK_MS)),
      ])
      return frames > 0
    },
    () => {
      if (decoder.state !== "closed") decoder.close()
    }
  )
}

let checked: Promise<boolean> | null = null

/** Once per page: whether the browser decoded the frame. */
export function decodesDesktopVideo(): Promise<boolean> {
  checked ??=
    "VideoDecoder" in window
      ? recoverPromise(decodesKeyFrame, () => false)
      : Promise.resolve(false)
  return checked
}
