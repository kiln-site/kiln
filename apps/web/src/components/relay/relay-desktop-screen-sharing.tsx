import * as React from "react"
import type { RelayDesktopMonitor } from "@workspace/contracts"
import { Result } from "effect"
import { LoaderCircle, RotateCw, TriangleAlert } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"

import { DesktopKeyboard } from "@/components/relay/relay-desktop-keyboard"
import {
  desktopStreamUrl,
  digit,
  keys,
  letter,
  type DesktopClient,
  type DesktopImageSize,
  type DesktopSurfaceProps,
} from "@/components/relay/relay-desktop-surface"
import { DesktopTrackpad } from "@/components/relay/relay-desktop-trackpad"
import { decodesDesktopVideo } from "@/components/relay/relay-desktop-video-check"
import { forkPromise } from "@/effect/promise"

// A Mac's desktop, through macOS's own Screen Sharing. noVNC plays it, in a
// chunk only this page loads, and its WebSocket goes through Hearth to the
// Relay like any stream (lib/relay-desktop.server.ts). The viewer signs in to
// the Mac here: the password goes from this page to the Mac, which is never
// saved, and only the Mac can read it.

type Connection =
  | { status: "connecting" }
  | { status: "signing-in"; rejected: boolean }
  | { status: "connected" }
  | { status: "failed"; message: string }

type NoVnc = InstanceType<typeof import("@novnc/novnc").default>

const CONTROL_LEFT = 0xffe3
const CONTROL_RIGHT = 0xffe4
const SUPER_LEFT = 0xffeb
const SUPER_RIGHT = 0xffec
const ALT_LEFT = 0xffe9
const ALT_RIGHT = 0xffea
const META_LEFT = 0xffe7
const META_RIGHT = 0xffe8

// What macOS's server makes of keys, measured: Alt and Super are both Command,
// and only Meta is Option. So a viewer's Alt is sent as Meta, on any computer.
// Other computers' shortcuts use Control where a Mac's use Command, so their
// Control is the Mac's Command, and their Windows key the Mac's Control.
function macKeysym(keysym: number) {
  if (keysym === ALT_LEFT) return META_LEFT
  if (keysym === ALT_RIGHT) return META_RIGHT
  if (navigator.platform.startsWith("Mac")) return keysym
  switch (keysym) {
    case CONTROL_LEFT:
      return SUPER_LEFT
    case CONTROL_RIGHT:
      return SUPER_RIGHT
    case SUPER_LEFT:
      return CONTROL_LEFT
    case SUPER_RIGHT:
      return CONTROL_RIGHT
    default:
      return keysym
  }
}

// The Relay shrinks the picture before it leaves the node, so it's told what
// to send: which part of the Mac's image, at the size it fills here.
const VIEW_MESSAGE = 0xfa
const RESIZE_SETTLE_MS = 150
const IMAGE_SIZE_NOTICE = /^kiln-image:(\d+)x(\d+)$/u
const VIDEO_NOTICE = /^kiln-video:(on|off)$/u

interface View {
  decodesVideo: boolean
  fastMotion: boolean
  lossless: boolean
  monitor: RelayDesktopMonitor | undefined
}

function sendView(
  rfb: NoVnc,
  element: HTMLElement,
  image: DesktopImageSize,
  { decodesVideo, fastMotion, lossless, monitor }: View
) {
  const socket = rfb._sock._websocket
  if (socket?.readyState !== WebSocket.OPEN) return
  const area = monitor ?? { ...image, x: 0, y: 0 }
  const box = element.getBoundingClientRect()
  const scale = lossless
    ? 1
    : Math.min(
        1,
        (box.width * window.devicePixelRatio) / area.width,
        (box.height * window.devicePixelRatio) / area.height
      )
  if (scale <= 0) return
  const message = new DataView(new ArrayBuffer(14))
  message.setUint8(0, VIEW_MESSAGE)
  const fields = [
    area.x,
    area.y,
    area.width,
    area.height,
    Math.round(area.width * scale),
    Math.round(area.height * scale),
  ]
  fields.forEach((value, index) => message.setUint16(1 + index * 2, value))
  message.setUint8(
    13,
    (lossless ? 1 : 0) | (fastMotion ? 2 : 0) | (decodesVideo ? 4 : 0)
  )
  socket.send(message.buffer)
}

const accountStorageKey = (relayId: string) => `kiln:desktop-account:${relayId}`

function rememberedAccount(relayId: string) {
  return Result.getOrElse(
    Result.try(() => window.localStorage.getItem(accountStorageKey(relayId))),
    () => null
  )
}

// The name only, for next time. Passwords stay with the browser's person.
function rememberAccount(relayId: string, account: string) {
  Result.try(() =>
    window.localStorage.setItem(accountStorageKey(relayId), account)
  )
}

function ScreenSharingSurface({
  desktop,
  onImageSize,
  onKeyboard,
  onVideo,
  relayId,
  session,
  surface,
}: DesktopSurfaceProps) {
  const target = React.useRef<HTMLDivElement>(null)
  // What the viewer last tried, kept across a wrong password.
  const account = React.useRef<string | null>(null)
  const client = React.useRef<NoVnc | null>(null)
  const imageSize = React.useRef<DesktopImageSize | null>(null)
  const view = React.useRef<View>({
    decodesVideo: false,
    fastMotion: true,
    lossless: false,
    monitor: undefined,
  })
  // Straight to the Mac, for the toolbar's keys, which already name Mac keys.
  const sendRawKey = React.useRef<NoVnc["sendKey"] | null>(null)
  const keyboard = React.useRef<HTMLTextAreaElement>(null)
  // Kept across attempts: a wrong password ends the connection, and the next
  // one has to say so.
  const rejected = React.useRef(false)
  const [attempt, setAttempt] = React.useState(0)
  const [trackpad, setTrackpad] = React.useState(false)
  const [connection, setConnection] = React.useState<Connection>({
    status: "connecting",
  })

  const image = React.useCallback(
    () => target.current?.querySelector("canvas") ?? null,
    []
  )
  // Keys go to the desktop, unless a phone's keyboard is taking them.
  const takeKeys = React.useCallback(() => {
    if (document.activeElement !== keyboard.current) client.current?.focus()
  }, [])

  const showView = React.useCallback(() => {
    const rfb = client.current
    if (rfb && target.current && imageSize.current) {
      sendView(rfb, target.current, imageSize.current, view.current)
    }
  }, [])

  React.useImperativeHandle(
    surface,
    () => ({
      focus: () => client.current?.focus(),
      sendKeys: (combo) => {
        const send = sendRawKey.current
        if (!send) return
        for (const key of combo) send(key.keysym, key.code, true)
        for (const key of [...combo].reverse()) {
          send(key.keysym, key.code, false)
        }
      },
      setTrackpad,
      toggleKeyboard: () => {
        const field = keyboard.current
        if (document.activeElement === field) field?.blur()
        else field?.focus()
      },
      setFastMotion: (fastMotion) => {
        view.current.fastMotion = fastMotion
        showView()
      },
      setLossless: (lossless) => {
        view.current.lossless = lossless
        showView()
      },
      showMonitor: (monitor) => {
        view.current.monitor = monitor
        showView()
      },
    }),
    [showView]
  )

  React.useEffect(() => {
    let cancelled = false
    let failedSignIn = false
    setConnection({ status: "connecting" })
    const fail = (message: string) => {
      if (!cancelled) setConnection({ status: "failed", message })
    }
    forkPromise(
      async () => {
        const [{ default: RFB }, decodesVideo] = await Promise.all([
          import("@novnc/novnc"),
          decodesDesktopVideo(),
        ])
        view.current.decodesVideo = decodesVideo
        const element = target.current
        if (cancelled || !element) return
        const rfb = new RFB(element, desktopStreamUrl(relayId, session))
        client.current = rfb
        const sendKey = rfb.sendKey.bind(rfb)
        sendRawKey.current = sendKey
        rfb.sendKey = (keysym, code, down) =>
          sendKey(macKeysym(keysym), code, down)
        rfb.scaleViewport = true
        // macOS sends no cursor until it changes, which noVNC starts out
        // drawing as nothing: a dot stands in, so the pointer never vanishes.
        rfb.showDotCursor = true
        // The Relay says so this way when the Mac's displays change
        // (desktop-screen-scaling.ts).
        rfb.addEventListener("desktopname", (event) => {
          const video = VIDEO_NOTICE.exec(event.detail.name)
          if (video) onVideo?.(video[1] === "on")
          const size = IMAGE_SIZE_NOTICE.exec(event.detail.name)
          if (!size) return
          const image = { height: Number(size[2]), width: Number(size[1]) }
          imageSize.current = image
          onImageSize(image)
          const { monitor } = view.current
          const fits =
            monitor &&
            monitor.x + monitor.width <= image.width &&
            monitor.y + monitor.height <= image.height
          if (!fits) view.current.monitor = undefined
          showView()
        })
        rfb.addEventListener("connect", () => {
          if (cancelled) return
          rejected.current = false
          if (account.current) rememberAccount(relayId, account.current)
          setConnection({ status: "connected" })
          const image = element.querySelector("canvas")
          if (image) {
            const size = { height: image.height, width: image.width }
            imageSize.current = size
            onImageSize(size)
            showView()
          }
          rfb.focus()
        })
        rfb.addEventListener("credentialsrequired", () => {
          if (cancelled) return
          setConnection({ status: "signing-in", rejected: rejected.current })
        })
        rfb.addEventListener("securityfailure", () => {
          // macOS closes the connection on a wrong password: a new one asks
          // again, saying why.
          failedSignIn = true
          rejected.current = true
        })
        rfb.addEventListener("disconnect", () => {
          client.current = null
          imageSize.current = null
          onImageSize(null)
          onVideo?.(false)
          if (cancelled) return
          if (failedSignIn) {
            setAttempt((value) => value + 1)
            return
          }
          fail("The connection to this Mac ended.")
        })
      },
      () => fail("The desktop client couldn't load.")
    )
    return () => {
      cancelled = true
      client.current?.disconnect()
      client.current = null
    }
  }, [attempt, onImageSize, onVideo, relayId, session, showView])

  // The trackpad's clicks would otherwise close a phone's keyboard, as the
  // canvas took the focus from it. It decides what has the keys itself.
  React.useEffect(() => {
    if (client.current) client.current.focusOnClick = !trackpad
  }, [connection.status, trackpad])

  // A new size is a new picture to scale, once the window stops moving.
  React.useEffect(() => {
    const element = target.current
    if (!element) return
    let settling: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      clearTimeout(settling)
      settling = setTimeout(showView, RESIZE_SETTLE_MS)
    })
    observer.observe(element)
    return () => {
      clearTimeout(settling)
      observer.disconnect()
    }
  }, [showView])

  return (
    <div className="relative min-h-0 w-full flex-1 bg-black">
      <div
        ref={target}
        aria-label="Node desktop"
        className="absolute inset-0"
        role="application"
      />
      {trackpad && connection.status === "connected" ? (
        <DesktopTrackpad
          image={image}
          onUsed={takeKeys}
        />
      ) : null}
      <DesktopKeyboard
        input={keyboard}
        send={sendRawKey}
        onOpen={onKeyboard}
      />
      {connection.status === "connected" ? null : (
        <div className="absolute inset-0 grid place-items-center bg-card/95 p-4">
          {connection.status === "connecting" ? (
            <LoaderCircle className="size-6 animate-spin text-muted-foreground" />
          ) : null}
          {connection.status === "signing-in" ? (
            <SignInForm
              accounts={"accounts" in desktop ? desktop.accounts : []}
              initialAccount={account.current ?? rememberedAccount(relayId)}
              rejected={connection.rejected}
              onSubmit={(credentials) => {
                account.current = credentials.username
                setConnection({ status: "connecting" })
                client.current?.sendCredentials(credentials)
              }}
            />
          ) : null}
          {connection.status === "failed" ? (
            <div className="flex max-w-sm flex-col items-center text-center">
              <TriangleAlert className="mb-3 size-5 text-muted-foreground" />
              <p className="text-sm">{connection.message}</p>
              <Button
                className="mt-4"
                size="sm"
                variant="outline"
                onClick={() => setAttempt((value) => value + 1)}
              >
                <RotateCw />
                Try again
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

function SignInForm({
  accounts,
  initialAccount,
  onSubmit,
  rejected,
}: {
  accounts: ReadonlyArray<string>
  initialAccount: string | null
  onSubmit: (credentials: { password: string; username: string }) => void
  rejected: boolean
}) {
  const suggestions = React.useId()
  // A Mac with one account needs no choosing.
  const account = initialAccount ?? (accounts.length === 1 ? accounts[0] : "")
  return (
    <form
      className="flex w-full max-w-xs flex-col gap-2"
      // Read from the form, so the password is never held in state.
      onSubmit={(event) => {
        event.preventDefault()
        const fields = new FormData(event.currentTarget)
        onSubmit({
          password: String(fields.get("password") ?? ""),
          username: String(fields.get("username") ?? ""),
        })
      }}
    >
      <p className="text-sm font-semibold">Sign in to this Mac</p>
      <p className="mb-1 text-xs leading-relaxed text-muted-foreground">
        {rejected
          ? "That name or password wasn't right, or that account can't use Screen Sharing."
          : "Use an account Screen Sharing allows on this Mac. Kiln doesn't save it."}
      </p>
      <Input
        aria-label="Mac account name"
        autoComplete="off"
        autoFocus={!account}
        defaultValue={account}
        list={suggestions}
        name="username"
        placeholder="Account name"
        required
      />
      <Input
        aria-label="Mac password"
        // Off, so the browser never offers Kiln's own password for a Mac.
        autoComplete="off"
        autoFocus={Boolean(account)}
        name="password"
        placeholder="Password"
        required
        type="password"
      />
      <datalist id={suggestions}>
        {accounts.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <Button className="mt-1" size="sm" type="submit">
        Sign in
      </Button>
    </form>
  )
}

const command = keys.super
const option = { code: "AltLeft", key: "Alt", keysym: META_LEFT }

export const screenSharingClient: DesktopClient = {
  cropsMonitors: true,
  offersKeyboard: true,
  offersTrackpad: true,
  offersLossless: true,
  Surface: ScreenSharingSurface,
  combos: [
    { label: "Command+Tab", keys: [command, keys.tab] },
    { label: "Command+Space", keys: [command, keys.space] },
    { label: "Command+W", keys: [command, letter("w")] },
    { label: "Command+Q", keys: [command, letter("q")] },
    { label: "Command+Shift+3", keys: [command, keys.shift, digit("3")] },
    { label: "Force Quit", keys: [command, option, keys.escape] },
    { label: "Lock Screen", keys: [keys.control, command, letter("q")] },
  ],
  opening:
    "Connecting to Screen Sharing on this Mac. The first time, the Relay downloads the video encoder.",
  unsupported: () =>
    window.isSecureContext
      ? null
      : "Signing in to a Mac needs a secure page. Open Kiln over HTTPS.",
}
