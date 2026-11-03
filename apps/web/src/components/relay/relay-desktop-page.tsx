import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { RelayDesktop } from "@workspace/contracts"
import {
  Keyboard,
  LoaderCircle,
  Maximize,
  Minimize,
  MonitorOff,
  RotateCw,
  TerminalSquare,
  TriangleAlert,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { cn } from "@workspace/ui/lib/utils"

import { RelayKindIcon } from "@/components/instance-kind-icon"
import { useRelayLiveStatus } from "@/components/relay/relay-presentation"
import { useRelayWorkspace } from "@/components/relay/relay-workspace-context"
import { forkPromise } from "@/effect/promise"
import {
  closeRelayDesktop,
  getRelayDesktop,
  getRelayDesktopSession,
  openRelayDesktop,
} from "@/server/relay-desktop"

// The node's desktop, streamed by voxl. The stream plays in voxl's own
// client, served by Hearth (public/desktop-client) in a frame; Hearth
// carries its WebSocket to the Relay (lib/relay-desktop.server.ts).

const DESKTOP_CLIENT = "/desktop-client/index.html"
const SESSION_CHECK_MS = 10_000

interface SendableKey {
  readonly code: string
  readonly key: string
}
const CONTROL = { code: "ControlLeft", key: "Control" }
const ALT = { code: "AltLeft", key: "Alt" }
const SUPER = { code: "OSLeft", key: "Meta" }
const letter = (key: string) => ({
  code: `Key${key.toUpperCase()}`,
  key,
})
// What a browser or the viewer's own computer may keep from the desktop.
const SENDABLE_KEYS: ReadonlyArray<{
  readonly keys: ReadonlyArray<SendableKey>
  readonly label: string
}> = [
  {
    label: "Ctrl+Alt+Delete",
    keys: [CONTROL, ALT, { code: "Delete", key: "Delete" }],
  },
  { label: "Super", keys: [SUPER] },
  { label: "Alt+Tab", keys: [ALT, { code: "Tab", key: "Tab" }] },
  { label: "Alt+F4", keys: [ALT, { code: "F4", key: "F4" }] },
  { label: "Ctrl+W", keys: [CONTROL, letter("w")] },
  { label: "Ctrl+T", keys: [CONTROL, letter("t")] },
  { label: "Ctrl+Alt+T", keys: [CONTROL, ALT, letter("t")] },
  {
    label: "Print Screen",
    keys: [{ code: "PrintScreen", key: "PrintScreen" }],
  },
]

function relayDesktopQueryOptions(relayId: string) {
  return {
    queryKey: ["relay-desktop", relayId],
    queryFn: () => getRelayDesktop({ data: { relayId } }),
    retry: false,
    staleTime: 10_000,
    // Checks again while there's nothing to show, so the page lights up
    // when someone signs in at the node.
    refetchInterval: (query: { state: { data?: RelayDesktop } }) =>
      query.state.data?.status === "x11" ? false : 15_000,
  }
}

export function RelayDesktopPage() {
  const { relay } = useRelayWorkspace()
  const { connected } = useRelayLiveStatus(relay)
  const desktop = useQuery({
    ...relayDesktopQueryOptions(relay.id),
    enabled: connected,
  })

  if (!connected) {
    return (
      <DesktopPlaceholder
        icon={<RelayKindIcon />}
        title="Waiting for the Relay"
        description="This page will open when the Relay reconnects."
      />
    )
  }
  if (desktop.isPending) return <div className="min-h-0 flex-1 bg-card" />
  if (!desktop.data) {
    return (
      <DesktopPlaceholder
        icon={<TriangleAlert />}
        title="Couldn't check this node's desktop"
        description={
          desktop.error?.message ?? "The Relay didn't answer. Try again."
        }
        terminal
      />
    )
  }
  return <DesktopContent desktop={desktop.data} relayId={relay.id} />
}

function DesktopContent({
  desktop,
  relayId,
}: {
  desktop: RelayDesktop
  relayId: string
}) {
  switch (desktop.status) {
    case "x11":
      return <DesktopStream key={desktop.display} relayId={relayId} />
    case "wayland":
      return (
        <DesktopPlaceholder
          icon={<MonitorOff />}
          title={
            desktop.greeter
              ? "This node's login screen runs on Wayland"
              : "This node's desktop runs on Wayland"
          }
          description="Kiln can stream X11 desktops only for now. Sign in with an Xorg session, such as “GNOME on Xorg”, or turn Wayland off in the node's display manager."
          terminal
        />
      )
    case "none":
      return (
        <DesktopPlaceholder
          icon={<MonitorOff />}
          title={
            desktop.displayManager
              ? "Nobody is signed in to this node's desktop"
              : "This node doesn't have a graphical interface"
          }
          description={
            desktop.displayManager
              ? "This page opens the desktop once someone signs in at the node. You can manage it from its terminal meanwhile."
              : "There's no desktop to show on this node's host. You can still manage it from its terminal."
          }
          terminal
        />
      )
    case "unconfigured":
      return (
        <DesktopPlaceholder
          icon={<MonitorOff />}
          title="Desktop streaming isn't set up"
          description="Set KILN_RELAY_DESKTOP_IMAGE on the Relay to the image built from apps/desktop to show its node's desktop."
          terminal
        />
      )
    case "paused":
      return (
        <DesktopPlaceholder
          icon={<MonitorOff />}
          title="This Relay is paused"
          description="The desktop takes keyboard and mouse input, so it can't open until the Relay resumes."
          terminal
        />
      )
    case "disabled":
      return (
        <DesktopPlaceholder
          icon={<MonitorOff />}
          title="Host access is off"
          description="Set KILN_RELAY_HOST_ACCESS=true on the Relay to show its node's desktop."
        />
      )
  }
}

type StreamState =
  | { status: "opening" }
  | { status: "open"; session: string }
  | { status: "failed"; message: string }

function DesktopStream({ relayId }: { relayId: string }) {
  const [attempt, setAttempt] = React.useState(0)
  const [state, setState] = React.useState<StreamState>({ status: "opening" })
  const reopen = React.useCallback(() => setAttempt((value) => value + 1), [])
  const supported = useStreamingSupport()

  React.useEffect(() => {
    if (!supported) return
    let session: string | null = null
    let cancelled = false
    setState({ status: "opening" })
    forkPromise(
      async () => {
        const opened = await openRelayDesktop({ data: { relayId } })
        session = opened.session
        if (cancelled) {
          await closeRelayDesktop({ data: { relayId, session } })
          return
        }
        setState({ status: "open", session })
      },
      (cause) => {
        if (cancelled) return
        setState({
          status: "failed",
          message:
            cause instanceof Error
              ? cause.message
              : "The desktop couldn't be opened",
        })
      }
    )
    return () => {
      cancelled = true
      if (session) {
        const opened = session
        forkPromise(() =>
          closeRelayDesktop({ data: { relayId, session: opened } })
        )
      }
    }
  }, [attempt, relayId, supported])

  if (!supported) {
    return (
      <DesktopPlaceholder
        icon={<TriangleAlert />}
        title="This browser can't play the desktop"
        description="Streaming the desktop needs WebCodecs, which browsers only allow on HTTPS pages. Open Kiln over HTTPS in a current browser."
      />
    )
  }
  if (state.status === "failed") {
    return (
      <DesktopPlaceholder
        icon={<TriangleAlert />}
        title="The desktop couldn't be opened"
        description={state.message}
        terminal
      >
        <Button className="mt-4" size="sm" variant="outline" onClick={reopen}>
          <RotateCw />
          Try again
        </Button>
      </DesktopPlaceholder>
    )
  }
  if (state.status === "opening") {
    return (
      <DesktopPlaceholder
        icon={<LoaderCircle className="animate-spin" />}
        title="Opening the desktop"
        description="Starting the stream on the node. The first time, the Relay downloads the streamer."
      />
    )
  }
  return (
    <DesktopFrame relayId={relayId} session={state.session} onEnded={reopen} />
  )
}

function DesktopFrame({
  onEnded,
  relayId,
  session,
}: {
  onEnded: () => void
  relayId: string
  session: string
}) {
  // A stream that can't go on, such as after the Relay restarts or someone
  // signs out at the node, ends its session, and voxl's client would only
  // keep trying. A new session finds what the node shows now.
  const { data } = useQuery({
    queryKey: ["relay-desktop-session", session],
    queryFn: () => getRelayDesktopSession({ data: { relayId, session } }),
    refetchInterval: SESSION_CHECK_MS,
    retry: false,
  })
  const ended = data?.open === false
  React.useEffect(() => {
    if (ended) onEnded()
  }, [ended, onEnded])
  const frame = React.useRef<HTMLIFrameElement>(null)
  const [root, setRoot] = React.useState<HTMLDivElement | null>(null)
  const { expanded, toggleExpanded } = useDesktopExpansion(frame, root)
  const params = new URLSearchParams({ relay: relayId, session })
  return (
    <div
      ref={setRoot}
      className={cn(
        "flex min-h-0 flex-1 flex-col bg-black",
        expanded && "fixed inset-0 z-50"
      )}
    >
      <div className="flex h-9 shrink-0 items-center justify-end gap-1 border-b border-border/70 bg-card px-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost">
              <Keyboard />
              Send keys
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className={cn(expanded && "z-60")}
            // Only the fullscreen element's own content shows.
            container={expanded ? root : undefined}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              frame.current?.focus()
            }}
          >
            {SENDABLE_KEYS.map((combo) => (
              <DropdownMenuItem
                key={combo.label}
                onSelect={() => sendKeys(frame.current, combo.keys)}
              >
                {combo.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" variant="ghost" onClick={toggleExpanded}>
          {expanded ? <Minimize /> : <Maximize />}
          {expanded ? "Exit fullscreen" : "Fullscreen"}
        </Button>
      </div>
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
    </div>
  )
}

// Keyboard Lock, which only Chromium browsers have, so TypeScript doesn't.
interface KeyboardLockNavigator extends Navigator {
  readonly keyboard?: { lock: () => Promise<void>; unlock: () => void }
}

// Fullscreen on the toolbar and desktop together, which keeps Send keys in
// reach. Only the top-level page may take the keyboard, which lets browser
// shortcuts such as Ctrl+W reach the desktop, so that happens here too. Where a
// browser has no fullscreen for pages, as on iPhones, the desktop fills the
// window instead.
function useDesktopExpansion(
  frame: React.RefObject<HTMLIFrameElement | null>,
  root: HTMLElement | null
) {
  const keyboard = (navigator as KeyboardLockNavigator).keyboard
  const [native, setNative] = React.useState(false)
  const [filled, setFilled] = React.useState(false)
  React.useEffect(() => {
    const onChange = () => {
      const active = document.fullscreenElement !== null
      setNative(active)
      if (active) {
        forkPromise(async () => {
          await keyboard?.lock()
        })
      } else {
        keyboard?.unlock()
      }
      frame.current?.focus()
    }
    document.addEventListener("fullscreenchange", onChange)
    return () => {
      document.removeEventListener("fullscreenchange", onChange)
      keyboard?.unlock()
    }
  }, [frame, keyboard])
  const toggleExpanded = React.useCallback(() => {
    if (native) {
      forkPromise(() => document.exitFullscreen())
    } else if (filled) {
      setFilled(false)
    } else if (document.fullscreenEnabled) {
      forkPromise(
        async () => {
          await root?.requestFullscreen({ navigationUI: "hide" })
        },
        () => setFilled(true)
      )
    } else {
      setFilled(true)
    }
    frame.current?.focus()
  }, [filled, frame, native, root])
  return { expanded: native || filled, toggleExpanded }
}

// Presses keys down in order and lets them go in reverse, through the keyboard
// handlers of voxl's page, for what a browser or the viewer's own computer
// keeps for itself. `code` follows voxl's mapping: OSLeft is always the
// desktop's Super key, which a Mac's Command key doesn't reach.
function sendKeys(
  frame: HTMLIFrameElement | null,
  keys: ReadonlyArray<SendableKey>
) {
  const view = frame?.contentWindow as (Window & typeof globalThis) | null
  const target = frame?.contentDocument?.getElementById("kbd")
  if (!view || !target) return
  const fire = (type: "keydown" | "keyup", key: SendableKey) =>
    target.dispatchEvent(
      new view.KeyboardEvent(type, { bubbles: true, cancelable: true, ...key })
    )
  for (const key of keys) fire("keydown", key)
  for (const key of [...keys].reverse()) fire("keyup", key)
}

function useStreamingSupport() {
  return React.useSyncExternalStore(
    noSubscription,
    () => window.isSecureContext && "VideoDecoder" in window,
    () => true
  )
}

function noSubscription() {
  return () => undefined
}

// The desktop's place, grayed out, saying why there's nothing to show.
function DesktopPlaceholder({
  children,
  description,
  icon,
  terminal = false,
  title,
}: {
  children?: React.ReactNode
  description: string
  icon: React.ReactNode
  terminal?: boolean
  title: string
}) {
  const { routeId } = useRelayWorkspace()
  return (
    <div className="grid min-h-0 flex-1 place-items-center bg-card p-4 sm:p-8">
      <div className="relative grid aspect-video w-full max-w-4xl place-items-center overflow-hidden rounded-lg border border-border/70 bg-muted/40 px-6 text-center">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 [background-image:radial-gradient(circle_at_center,var(--color-border)_1px,transparent_1px)] [background-size:18px_18px] opacity-60"
        />
        <div className="relative flex max-w-sm flex-col items-center">
          <span className="mb-4 text-muted-foreground [&_svg]:size-6">
            {icon}
          </span>
          <p className="text-sm font-semibold">{title}</p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
          {terminal ? (
            <Button asChild className="mt-4" size="sm">
              <Link params={{ relayId: routeId }} to="/relay/$relayId/terminal">
                <TerminalSquare />
                Open terminal
              </Link>
            </Button>
          ) : null}
          {children}
        </div>
      </div>
    </div>
  )
}
