import type { RelayDesktop, RelayDesktopMonitor } from "@workspace/contracts"
import type * as React from "react"

/** One key of a combination the toolbar sends. */
export interface SendableKey {
  readonly code: string
  readonly key: string
  readonly keysym: number
}

/** A named combination, for what a browser or viewer's computer keeps. */
export interface SendableCombo {
  readonly keys: ReadonlyArray<SendableKey>
  readonly label: string
}

/** What the toolbar asks of whichever client is showing the desktop. */
export interface DesktopSurface {
  focus: () => void
  /** Sends every pixel exactly, at the cost of speed. */
  setLossless?: (lossless: boolean) => void
  /** Skips pixels while the picture moves, to keep up with big displays. */
  setFastMotion?: (fastMotion: boolean) => void
  /** Moves the pointer by dragging, like a trackpad, instead of where it's touched. */
  setTrackpad?: (trackpad: boolean) => void
  /** Opens or closes a phone's keyboard, from the tap on the toolbar. */
  toggleKeyboard?: () => void
  /** Pastes the browser's clipboard, for a touch screen with no paste key. */
  paste?: () => void
  /** The monitor on show, for a client that can ask for only that much. */
  showMonitor?: (monitor: RelayDesktopMonitor | undefined) => void
  /** Presses keys down in order and lets them go in reverse. */
  sendKeys: (keys: ReadonlyArray<SendableKey>) => void
}

/** Whether shortcuts here use Command: a Mac, or an iPad or iPhone's keyboard. */
export const viewerUsesCommand = () =>
  /^(Mac|iPhone|iPad|iPod)/u.test(navigator.platform)

/** The size of the image a client shows, in the desktop's pixels. */
export interface DesktopImageSize {
  readonly height: number
  readonly width: number
}

export interface DesktopSurfaceProps {
  desktop: RelayDesktop
  /** The image's size once it shows, and null when it stops. */
  onImageSize: (size: DesktopImageSize | null) => void
  /** Whether the picture is coming as video, for the toolbar. */
  onVideo?: (video: boolean) => void
  /** Whether a phone's keyboard is open, for the toolbar. */
  onKeyboard?: (open: boolean) => void
  relayId: string
  session: string
  surface: React.Ref<DesktopSurface>
}

/** How the page shows one kind of desktop (`relay.desktop.read`'s status). */
export interface DesktopClient {
  readonly Surface: React.ComponentType<DesktopSurfaceProps>
  readonly combos: ReadonlyArray<SendableCombo>
  /** Whether it shows just the monitor it's given, instead of the page. */
  readonly cropsMonitors?: boolean
  /** Whether the toolbar offers `DesktopSurface.setTrackpad`. */
  readonly offersTrackpad?: boolean
  /** Whether touch screens get `DesktopSurface.toggleKeyboard`. voxl has its own. */
  readonly offersKeyboard?: boolean
  /** Whether touch screens get `DesktopSurface.paste`. voxl has no need. */
  readonly offersPaste?: boolean
  /** Whether the toolbar offers `DesktopSurface.setLossless`. */
  readonly offersLossless?: boolean
  /** Shown while the stream opens. */
  readonly opening: string
  /** Whether this browser can play it, and if not, why. */
  readonly unsupported: () => string | null
}

const key = (code: string, name: string, keysym: number): SendableKey => ({
  code,
  key: name,
  keysym,
})

export const keys = {
  alt: key("AltLeft", "Alt", 0xffe9),
  control: key("ControlLeft", "Control", 0xffe3),
  delete: key("Delete", "Delete", 0xffff),
  escape: key("Escape", "Escape", 0xff1b),
  f4: key("F4", "F4", 0xffc1),
  printScreen: key("PrintScreen", "PrintScreen", 0xff61),
  shift: key("ShiftLeft", "Shift", 0xffe1),
  space: key("Space", " ", 0x20),
  // OSLeft is always the desktop's Super key, which a Mac's Command key
  // doesn't reach through voxl.
  super: key("OSLeft", "Meta", 0xffeb),
  tab: key("Tab", "Tab", 0xff09),
}

export const letter = (name: string) =>
  key(`Key${name.toUpperCase()}`, name, name.charCodeAt(0))

export const digit = (name: string) =>
  key(`Digit${name}`, name, name.charCodeAt(0))

/** The smallest image that holds every monitor. */
export function imageSizeOf(
  monitors: ReadonlyArray<RelayDesktopMonitor>
): DesktopImageSize {
  return {
    height: Math.max(...monitors.map(({ height, y }) => y + height)),
    width: Math.max(...monitors.map(({ width, x }) => x + width)),
  }
}

/**
 * The node's monitors, from the arrangement that fits the image: a Mac keeps
 * every arrangement it has had. None when it can't tell, or there's only one.
 */
export function monitorsOf(
  desktop: RelayDesktop,
  size: DesktopImageSize | null
): ReadonlyArray<RelayDesktopMonitor> {
  if (!size || !("layouts" in desktop)) return []
  const monitors = desktop.layouts.find((layout) => {
    const fitted = imageSizeOf(layout)
    return fitted.width === size.width && fitted.height === size.height
  })
  return monitors && monitors.length > 1 ? monitors : []
}

/** The Hearth WebSocket a client's stream connects through. */
export function desktopStreamUrl(relayId: string, session: string) {
  const url = new URL("/desktop-client/ws", window.location.href)
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  url.search = new URLSearchParams({ relay: relayId, session }).toString()
  return url.href
}
