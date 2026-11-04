import * as React from "react"

import { showToast } from "@workspace/ui/components/sonner"

import { viewerUsesCommand } from "@/components/relay/relay-desktop-surface"
import { forkPromise, recoverPromise } from "@/effect/promise"

// Mirrors text and images between a Mac and the viewer's browser. The Relay does
// the Mac's side (desktop-mac-pasteboard.ts). This side has what browsers allow to
// work with:
//
// - What the Mac copies goes on the browser's clipboard while the viewer's on this
//   page. That takes focus, and on phones a tap, so a refused write waits for the
//   next one. Copies made while the viewer's elsewhere are left, rather than
//   replacing what they've copied there in the meantime.
// - The browser's clipboard only goes to the Mac on Paste, as it's whatever the
//   viewer last copied, passwords included, and this may be anyone's Mac. noVNC
//   stops the paste event by taking every key, so Paste is kept from it and lands
//   in a hidden field instead.

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
  return (
    (viewerUsesCommand() ? event.metaKey : event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "v"
  )
}

const isModifier = ({ key }: KeyboardEvent) =>
  key === "Control" || key === "Meta" || key === "Alt" || key === "Shift"

const canvasOf = (area: HTMLElement) => area.querySelector("canvas")

const showTooLarge = (message: string) => {
  showToast({ message, type: "error" })
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
  // Text just sent, which the Mac will report back once.
  const sent = React.useRef<string | null>(null)
  const waiting = React.useRef<ClipboardContent | null>(null)
  const pasting = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const holdingCommand = React.useRef(false)

  const sendText = React.useCallback(
    (text: string) => {
      const bytes = encoder.encode(text)
      if (bytes.length > MAX_TEXT_BYTES) {
        showTooLarge("That's too much text to send to the desktop, over 1 MB.")
        return false
      }
      sent.current = text
      send(bytes)
      return true
    },
    [send]
  )

  const sendImage = React.useCallback(
    async (image: Blob) => {
      const png = await pngOf(image)
      if (png.size > MAX_IMAGE_BYTES) {
        showTooLarge(
          "That image is too large to send to the desktop, over 15 MB."
        )
        return false
      }
      const marker = encoder.encode(IMAGE_MARKER)
      const cutText = new Uint8Array(marker.length + png.size)
      cutText.set(marker)
      cutText.set(new Uint8Array(await png.arrayBuffer()), marker.length)
      sent.current = null
      send(cutText)
      return true
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
      // Not allowed yet: tried again with the next tap or key.
      () => undefined
    )
  }, [])

  const receive = React.useCallback(
    (content: ClipboardContent) => {
      if (content === sent.current) {
        sent.current = null
        return
      }
      if (!document.hasFocus()) return
      waiting.current = content
      flush()
    },
    [flush]
  )

  // Rejected content leaves the key unsent, or the Mac would paste something else.
  const finishPaste = React.useCallback(
    (pasted: DataTransfer | null) => {
      if (pasting.current === null) return
      clearTimeout(pasting.current)
      pasting.current = null
      focus()
      const press = () => pressPaste(holdingCommand.current)
      const text = pasted?.getData("text/plain")
      const image = [...(pasted?.files ?? [])].find((file) =>
        file.type.startsWith("image/")
      )
      if (!text && image) {
        forkPromise(
          async () => {
            if (await sendImage(image)) press()
          },
          () => showTooLarge("That image couldn't be read.")
        )
        return
      }
      // Sent even when it's what the Mac last said, which may since have been
      // something that doesn't come here.
      if (!text || sendText(text)) press()
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
    const fits =
      typeof content === "string"
        ? !content || sendText(content)
        : await sendImage(content)
    if (fits) pressPaste(false)
  }, [pressPaste, sendImage, sendText])

  React.useEffect(() => {
    const element = area.current
    if (!element || !connected) return
    const onKey = (event: KeyboardEvent) => {
      // What the hidden field gets while it has the keys is noVNC's, which only
      // listens on its canvas: a key let go of here would stay down on the Mac.
      if (event.target === field.current) {
        if (event.type === "keyup" && isModifier(event)) {
          holdingCommand.current = false
        }
        if (isPaste(event)) event.stopPropagation()
        else {
          canvasOf(element)?.dispatchEvent(new KeyboardEvent(event.type, event))
        }
        return
      }
      if (event.type === "keyup") {
        if (isModifier(event)) holdingCommand.current = false
        return
      }
      if (isPaste(event)) {
        // Left to happen, for the paste event, and kept from noVNC, which would
        // stop it. What the viewer's pasting comes before what the Mac last said.
        event.stopPropagation()
        waiting.current = null
        holdingCommand.current = true
        // On Windows, noVNC holds Control back until the next key, in case it's
        // AltGr. The one it won't see is this, so a release says the same.
        canvasOf(element)?.dispatchEvent(
          new KeyboardEvent("keyup", { code: event.code, key: event.key })
        )
        if (pasting.current !== null) return
        field.current?.focus()
        pasting.current = setTimeout(() => finishPaste(null), PASTE_WAIT_MS)
        return
      }
      if (!isModifier(event)) flush()
    }
    const onLeave = () => {
      holdingCommand.current = false
    }
    element.addEventListener("keydown", onKey, true)
    element.addEventListener("keyup", onKey, true)
    element.addEventListener("pointerup", flush, true)
    window.addEventListener("blur", onLeave)
    return () => {
      element.removeEventListener("keydown", onKey, true)
      element.removeEventListener("keyup", onKey, true)
      element.removeEventListener("pointerup", flush, true)
      window.removeEventListener("blur", onLeave)
      if (pasting.current !== null) clearTimeout(pasting.current)
      pasting.current = null
    }
  }, [area, connected, finishPaste, flush])

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
