import * as React from "react"

import { showToast } from "@workspace/ui/components/sonner"

import { forkPromise, recoverPromise } from "@/effect/promise"

// Mirrors text and images between a Mac and the viewer's browser. The Relay does the Mac's
// side (desktop-mac-pasteboard.ts). This side has what browsers allow to work with:
//
// - What the Mac copies goes on the browser's clipboard, which only takes writes
//   while the page has focus, and on phones from a tap: a write that's refused
//   waits for the next time one can work.
// - What the browser holds can be read from a paste, which noVNC stops by taking
//   every key: Paste is kept from it, and lands in a hidden field instead.
//   Chromium browsers can also be given leave to read it, which is what lets
//   copying elsewhere and coming back reach the Mac without a key.

/** What the Relay carries of a clipboard (desktop-mac-pasteboard.ts). */
const MAX_TEXT_BYTES = 1024 * 1024
const MAX_IMAGE_BYTES = 15 * 1024 * 1024
const IMAGE_MARKER = "\0kiln-image\0"
const PNG = "image/png"
// Long enough for a browser that sends no paste event to have had its chance.
const PASTE_WAIT_MS = 250

const encoder = new TextEncoder()
const decoder = new TextDecoder()

type ClipboardContent = Blob | string

/** noVNC reads cut text as a character a byte, and the Relay sends UTF-8. */
export function desktopClipboardContent(cutText: string): ClipboardContent {
  const bytes = new Uint8Array(cutText.length)
  for (let index = 0; index < cutText.length; index += 1) {
    bytes[index] = cutText.charCodeAt(index)
  }
  return cutText.startsWith(IMAGE_MARKER)
    ? new Blob([bytes.subarray(IMAGE_MARKER.length)], { type: PNG })
    : decoder.decode(bytes)
}

// Browsers call most images on a clipboard PNG already.
async function pngOf(image: Blob) {
  if (image.type === PNG) return image
  const bitmap = await createImageBitmap(image)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0)
  bitmap.close()
  return canvas.convertToBlob({ type: PNG })
}

// What a browser's clipboard holds, for the toolbar's Paste. Text comes first, as
// on the Mac's side, and what's only an image needs the newer of the two calls.
async function readClipboard(): Promise<ClipboardContent> {
  if (!navigator.clipboard.read) return navigator.clipboard.readText()
  for (const item of await navigator.clipboard.read()) {
    if (item.types.includes("text/plain")) {
      return (await item.getType("text/plain")).text()
    }
    const image = item.types.find((type) => type.startsWith("image/"))
    if (image) return item.getType(image)
  }
  return ""
}

// Whether this press is Paste on the viewer's own computer. Other computers'
// Control is the Mac's Command, as with every other shortcut.
function isPaste(event: KeyboardEvent) {
  const modifier = navigator.platform.startsWith("Mac")
    ? event.metaKey
    : event.ctrlKey
  return (
    modifier &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "v"
  )
}

// Asking is what makes Chromium offer the permission. Other browsers show a Paste
// bubble for each read and don't have this query, so they stay with the paste key.
async function canReadQuietly() {
  if (!navigator.permissions) return false
  const status = await recoverPromise(
    () =>
      navigator.permissions.query({ name: "clipboard-read" as PermissionName }),
    () => null
  )
  return status !== null && status.state !== "denied"
}

export function useDesktopClipboard({
  area,
  connected,
  focus,
  pressPaste,
  send,
}: {
  /** What takes the viewer's keys and taps. */
  area: React.RefObject<HTMLElement | null>
  connected: boolean
  /** Gives the keys back to the desktop. */
  focus: () => void
  /** Sends V, with Command unless the viewer's holding it. */
  pressPaste: (holdingCommand: boolean) => void
  send: (cutText: Uint8Array) => void
}) {
  const field = React.useRef<HTMLTextAreaElement>(null)
  // What each side was last known to hold, so nothing's mirrored back.
  const known = React.useRef<string | null>(null)
  const waiting = React.useRef<ClipboardContent | null>(null)
  const pasting = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const sendText = React.useCallback(
    (text: string) => {
      const bytes = encoder.encode(text)
      if (bytes.length > MAX_TEXT_BYTES) {
        showToast({
          message: "That's too much text to send to the desktop, over 1 MB.",
          type: "error",
        })
        return
      }
      known.current = text
      send(bytes)
    },
    [send]
  )

  const sendImage = React.useCallback(
    async (image: Blob) => {
      const png = await pngOf(image)
      if (png.size > MAX_IMAGE_BYTES) {
        showToast({
          message:
            "That image is too large to send to the desktop, over 15 MB.",
          type: "error",
        })
        return
      }
      const marker = encoder.encode(IMAGE_MARKER)
      const cutText = new Uint8Array(marker.length + png.size)
      cutText.set(marker)
      cutText.set(new Uint8Array(await png.arrayBuffer()), marker.length)
      send(cutText)
    },
    [send]
  )

  const flush = React.useCallback(() => {
    const content = waiting.current
    if (content === null || !navigator.clipboard || !document.hasFocus()) return
    forkPromise(
      async () => {
        await (typeof content === "string"
          ? navigator.clipboard.writeText(content)
          : navigator.clipboard.write([new ClipboardItem({ [PNG]: content })]))
        if (waiting.current === content) waiting.current = null
      },
      // Not allowed yet: tried again with the next tap, key, or return here.
      () => undefined
    )
  }, [])

  const receive = React.useCallback(
    (content: ClipboardContent) => {
      if (content === known.current) return
      known.current = typeof content === "string" ? content : null
      waiting.current = content
      flush()
    },
    [flush]
  )

  // What was copied elsewhere, on coming back. A clipboard that can't be read
  // says nothing: Paste still works.
  const pull = React.useCallback(async () => {
    if (!navigator.clipboard?.readText || !(await canReadQuietly())) return
    const text = await recoverPromise(
      () => navigator.clipboard.readText(),
      () => null
    )
    if (text && text !== known.current) sendText(text)
  }, [sendText])

  const finishPaste = React.useCallback(
    (pasted: DataTransfer | null) => {
      if (pasting.current === null) return
      clearTimeout(pasting.current)
      pasting.current = null
      focus()
      // Sent even when it's what the Mac last said, which may since have been
      // an image or anything else that doesn't come here as text.
      const text = pasted?.getData("text/plain")
      const image = [...(pasted?.files ?? [])].find((file) =>
        file.type.startsWith("image/")
      )
      if (text || !image) {
        if (text) sendText(text)
        pressPaste(true)
        return
      }
      // Reading it takes a moment, by when the viewer may have let go.
      forkPromise(
        async () => {
          await sendImage(image)
          pressPaste(false)
        },
        () => pressPaste(false)
      )
    },
    [focus, pressPaste, sendImage, sendText]
  )

  const paste = React.useCallback(async () => {
    const content = await recoverPromise(readClipboard, () => null)
    if (content === null) {
      showToast({
        message: "This browser didn't allow reading its clipboard.",
        type: "error",
      })
      return
    }
    if (typeof content !== "string") await sendImage(content)
    else if (content) sendText(content)
    pressPaste(false)
  }, [pressPaste, sendImage, sendText])

  React.useEffect(() => {
    const element = area.current
    if (!element || !connected) return
    const onKey = (event: KeyboardEvent) => {
      flush()
      if (!isPaste(event)) return
      // Left to happen, for the paste event, and kept from noVNC, which would
      // stop it and send the Mac a V before the text. Command's already there.
      event.stopPropagation()
      if (pasting.current !== null) return
      field.current?.focus()
      pasting.current = setTimeout(() => finishPaste(null), PASTE_WAIT_MS)
    }
    const onReturn = () => {
      flush()
      forkPromise(pull, () => undefined)
    }
    element.addEventListener("keydown", onKey, true)
    element.addEventListener("pointerup", flush, true)
    window.addEventListener("focus", onReturn)
    forkPromise(pull, () => undefined)
    return () => {
      element.removeEventListener("keydown", onKey, true)
      element.removeEventListener("pointerup", flush, true)
      window.removeEventListener("focus", onReturn)
      if (pasting.current !== null) clearTimeout(pasting.current)
      pasting.current = null
    }
  }, [area, connected, finishPaste, flush, pull])

  return { field, finishPaste, paste, receive }
}

export function DesktopPasteField({
  field,
  onPaste,
}: {
  field: React.Ref<HTMLTextAreaElement>
  onPaste: (pasted: DataTransfer) => void
}) {
  return (
    <textarea
      ref={field}
      aria-hidden
      aria-label="Desktop paste"
      className="pointer-events-none absolute bottom-0 left-0 size-px resize-none overflow-hidden border-0 bg-transparent p-0 text-base opacity-0"
      tabIndex={-1}
      value=""
      onChange={() => undefined}
      onPaste={(event) => {
        event.preventDefault()
        onPaste(event.clipboardData)
      }}
    />
  )
}
