import * as React from "react"

import {
  imageSizeOf,
  keys,
  letter,
  type DesktopClient,
  type DesktopSurfaceProps,
  type SendableKey,
} from "@/components/relay/relay-desktop-surface"

// An X11 desktop, streamed by voxl. The stream plays in voxl's own client,
// served by Hearth (public/desktop-client) in a frame, whose WebSocket Hearth
// carries to the Relay (lib/relay-desktop.server.ts).

const DESKTOP_CLIENT = "/desktop-client/index.html"

function VoxlSurface({
  desktop,
  onImageSize,
  relayId,
  session,
  surface,
}: DesktopSurfaceProps) {
  const frame = React.useRef<HTMLIFrameElement>(null)
  // X11's screen is exactly its monitors.
  const monitors = "layouts" in desktop ? desktop.layouts[0] : undefined
  React.useEffect(() => {
    onImageSize(monitors ? imageSizeOf(monitors) : null)
    return () => onImageSize(null)
  }, [monitors, onImageSize])
  React.useImperativeHandle(
    surface,
    () => ({
      focus: () => frame.current?.focus(),
      sendKeys: (combo) => sendThroughVoxl(frame.current, combo),
    }),
    []
  )
  const params = new URLSearchParams({ relay: relayId, session })
  return (
    <iframe
      onLoad={(event) => {
        // Fullscreen is the toolbar's, with Send keys beside it.
        const own =
          event.currentTarget.contentDocument?.getElementById("fs-btn")
        if (own) own.style.display = "none"
        // Keys go to the desktop as soon as it shows.
        event.currentTarget.focus()
      }}
      ref={frame}
      allow="autoplay; clipboard-read; clipboard-write; fullscreen; keyboard-map"
      className="min-h-0 w-full flex-1 border-0 bg-black"
      src={`${DESKTOP_CLIENT}?${params}`}
      title="Node desktop"
    />
  )
}

// Through the keyboard handlers of voxl's page.
function sendThroughVoxl(
  frame: HTMLIFrameElement | null,
  combo: ReadonlyArray<SendableKey>
) {
  const view = frame?.contentWindow as (Window & typeof globalThis) | null
  const target = frame?.contentDocument?.getElementById("kbd")
  if (!view || !target) return
  const fire = (type: "keydown" | "keyup", { code, key }: SendableKey) =>
    target.dispatchEvent(
      new view.KeyboardEvent(type, {
        bubbles: true,
        cancelable: true,
        code,
        key,
      })
    )
  for (const key of combo) fire("keydown", key)
  for (const key of [...combo].reverse()) fire("keyup", key)
}

export const voxlClient: DesktopClient = {
  Surface: VoxlSurface,
  combos: [
    {
      label: "Ctrl+Alt+Delete",
      keys: [keys.control, keys.alt, keys.delete],
    },
    { label: "Super", keys: [keys.super] },
    { label: "Alt+Tab", keys: [keys.alt, keys.tab] },
    { label: "Alt+F4", keys: [keys.alt, keys.f4] },
    { label: "Ctrl+W", keys: [keys.control, letter("w")] },
    { label: "Ctrl+T", keys: [keys.control, letter("t")] },
    { label: "Ctrl+Alt+T", keys: [keys.control, keys.alt, letter("t")] },
    { label: "Print Screen", keys: [keys.printScreen] },
  ],
  opening:
    "Starting the stream on the node. The first time, the Relay downloads the streamer.",
  unsupported: () =>
    window.isSecureContext && "VideoDecoder" in window
      ? null
      : "Streaming the desktop needs WebCodecs, which browsers only allow on HTTPS pages. Open Kiln over HTTPS in a current browser.",
}
