import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { RelayDesktop, RelayDesktopMonitor } from "@workspace/contracts"
import { Result } from "effect"
import {
  ClipboardPaste,
  Command,
  Gem,
  Keyboard,
  LoaderCircle,
  Maximize,
  Minimize,
  Monitor,
  MonitorOff,
  Plug,
  Rabbit,
  RotateCw,
  TerminalSquare,
  Touchpad,
  TriangleAlert,
  Unplug,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import { RelayKindIcon } from "@/components/instance-kind-icon"
import { screenSharingClient } from "@/components/relay/relay-desktop-screen-sharing"
import {
  monitorsOf,
  type DesktopClient,
  type DesktopImageSize,
  type DesktopSurface,
} from "@/components/relay/relay-desktop-surface"
import { voxlClient } from "@/components/relay/relay-desktop-voxl"
import { useRelayLiveStatus } from "@/components/relay/relay-presentation"
import { useRelayWorkspace } from "@/components/relay/relay-workspace-context"
import { forkPromise } from "@/effect/promise"
import {
  closeRelayDesktop,
  getRelayDesktop,
  getRelayDesktopSession,
  openRelayDesktop,
} from "@/server/relay-desktop"

// The node's desktop. Which client shows it depends on the node
// (relay.desktop.read); the toolbar and the session around it are the same.

const SESSION_CHECK_MS = 10_000
const LAYOUT_CHECK_MS = 1_000
const LAYOUT_CHECKS_FOR_MS = 10_000
const TOUCH_SCREEN = "(any-pointer: coarse)"
const MAIN_POINTER_IS_TOUCH = "(pointer: coarse)"
const TRACKPAD_STORAGE_KEY = "kiln:desktop-trackpad"

function relayDesktopQueryOptions(relayId: string) {
  return {
    queryKey: ["relay-desktop", relayId],
    queryFn: () => getRelayDesktop({ data: { relayId } }),
    retry: false,
    staleTime: 10_000,
    // Checks again while there's nothing to show, so the page lights up
    // when someone signs in at the node.
    refetchInterval: (query: { state: { data?: RelayDesktop } }) =>
      query.state.data?.status === "x11" ||
      query.state.data?.status === "screen-sharing"
        ? false
        : 15_000,
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
  return (
    <DesktopContent
      checking={desktop.isFetching}
      desktop={desktop.data}
      relayId={relay.id}
      onCheckAgain={() => {
        forkPromise(() => desktop.refetch())
      }}
    />
  )
}

function DesktopContent({
  checking,
  desktop,
  onCheckAgain,
  relayId,
}: {
  checking: boolean
  desktop: RelayDesktop
  onCheckAgain: () => void
  relayId: string
}) {
  switch (desktop.status) {
    case "x11":
      return (
        <DesktopStream
          client={voxlClient}
          desktop={desktop}
          key={desktop.display}
          relayId={relayId}
        />
      )
    case "screen-sharing":
      return (
        <DesktopStream
          client={screenSharingClient}
          desktop={desktop}
          relayId={relayId}
        />
      )
    case "screen-sharing-off":
      return (
        <DesktopPlaceholder
          icon={<MonitorOff />}
          title="Screen Sharing is off on this Mac"
          description="Turn it on in System Settings, under General, Sharing. Other devices that can reach this Mac can then try to sign in to it, so don't forward its port 5900 on your router."
        >
          <Button
            className="mt-4"
            disabled={checking}
            size="sm"
            variant="outline"
            onClick={onCheckAgain}
          >
            <RotateCw />
            Check again
          </Button>
        </DesktopPlaceholder>
      )
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

function DesktopStream({
  client,
  desktop,
  relayId,
}: {
  client: DesktopClient
  desktop: RelayDesktop
  relayId: string
}) {
  const [attempt, setAttempt] = React.useState(0)
  const [state, setState] = React.useState<StreamState>({ status: "opening" })
  const [connected, setConnected] = React.useState(true)
  const reopen = React.useCallback(() => setAttempt((value) => value + 1), [])
  const unsupported = useUnsupported(client)
  const supported = unsupported === null

  React.useEffect(() => {
    if (!supported || !connected) return
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
  }, [attempt, connected, relayId, supported])

  if (!supported) {
    return (
      <DesktopPlaceholder
        icon={<TriangleAlert />}
        title="This browser can't play the desktop"
        description={unsupported ?? ""}
      />
    )
  }
  if (!connected) {
    return (
      <DesktopPlaceholder
        icon={<Unplug />}
        title="Disconnected"
        description="This page has let go of the desktop. Nothing on the node changed."
      >
        <Button className="mt-4" size="sm" onClick={() => setConnected(true)}>
          <Plug />
          Connect
        </Button>
      </DesktopPlaceholder>
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
        description={client.opening}
      />
    )
  }
  return (
    <DesktopFrame
      client={client}
      desktop={desktop}
      relayId={relayId}
      session={state.session}
      onDisconnect={() => setConnected(false)}
      onEnded={reopen}
    />
  )
}

function DesktopFrame({
  client,
  desktop,
  onDisconnect,
  onEnded,
  relayId,
  session,
}: {
  client: DesktopClient
  desktop: RelayDesktop
  onDisconnect: () => void
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
  const surface = React.useRef<DesktopSurface>(null)
  const [root, setRoot] = React.useState<HTMLDivElement | null>(null)
  const { expanded, toggleExpanded } = useDesktopExpansion(surface, root)
  const [imageSize, setImageSize] = React.useState<DesktopImageSize | null>(
    null
  )
  const [chosen, setChosen] = React.useState<number | null>(null)
  const monitors = monitorsOf(desktop, imageSize)
  // A monitor that's gone, as when the arrangement changes, shows them all.
  const monitor = chosen === null ? undefined : monitors[chosen]
  React.useEffect(() => {
    surface.current?.showMonitor?.(monitor)
  }, [monitor])
  const [video, setVideo] = React.useState(false)
  const [keyboardOpen, setKeyboardOpen] = React.useState(false)
  const touch = useTouchScreen()
  const [trackpad, setTrackpad] = React.useState(prefersTrackpad)
  React.useEffect(() => {
    surface.current?.setTrackpad?.(trackpad)
  }, [trackpad])
  const [fastMotion, setFastMotion] = React.useState(true)
  React.useEffect(() => {
    surface.current?.setFastMotion?.(fastMotion)
  }, [fastMotion])
  const [lossless, setLossless] = React.useState(false)
  React.useEffect(() => {
    surface.current?.setLossless?.(lossless)
  }, [lossless])
  // An image no arrangement fits means the node's displays just changed, and
  // a Mac takes a moment to save the new one.
  const queryClient = useQueryClient()
  const unplaced = imageSize !== null && monitors.length === 0
  React.useEffect(() => {
    if (!unplaced) return
    const check = () => {
      forkPromise(() =>
        queryClient.refetchQueries({ queryKey: ["relay-desktop", relayId] })
      )
    }
    check()
    const again = setInterval(check, LAYOUT_CHECK_MS)
    const stop = setTimeout(() => clearInterval(again), LAYOUT_CHECKS_FOR_MS)
    return () => {
      clearInterval(again)
      clearTimeout(stop)
    }
  }, [imageSize, queryClient, relayId, unplaced])
  const menuProps = {
    align: "end",
    className: cn(expanded && "z-60"),
    // Only the fullscreen element's own content shows.
    container: expanded ? root : undefined,
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault()
      surface.current?.focus()
    },
  } as const
  return (
    <div
      ref={setRoot}
      className={cn(
        "flex min-h-0 flex-1 flex-col bg-black",
        expanded && "fixed inset-0 z-50"
      )}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border/70 bg-card px-2 sm:justify-end">
        {client.offersTrackpad ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-pressed={trackpad}
                size="sm"
                variant={trackpad ? "secondary" : "ghost"}
                onClick={() => {
                  const next = !trackpad
                  setTrackpad(next)
                  rememberTrackpad(next)
                  surface.current?.focus()
                }}
              >
                <Touchpad />
                <ToolbarLabel>Trackpad</ToolbarLabel>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Drag to move the pointer, tap to click, and drag two fingers to
              scroll.
            </TooltipContent>
          </Tooltip>
        ) : null}
        {client.offersKeyboard && touch ? (
          <Button
            aria-pressed={keyboardOpen}
            size="sm"
            variant={keyboardOpen ? "secondary" : "ghost"}
            // Stays on the hidden field, so a second tap can close the keyboard
            // rather than finding it already gone.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => surface.current?.toggleKeyboard?.()}
          >
            <Keyboard />
            <ToolbarLabel>Keyboard</ToolbarLabel>
          </Button>
        ) : null}
        {client.offersPaste && touch ? (
          <Button
            disabled={!imageSize}
            size="sm"
            variant="ghost"
            onClick={() => surface.current?.paste?.()}
          >
            <ClipboardPaste />
            <ToolbarLabel>Paste</ToolbarLabel>
          </Button>
        ) : null}
        {monitors.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost">
                <Monitor />
                <ToolbarLabel>
                  {monitor ? `Monitor ${(chosen ?? 0) + 1}` : "All monitors"}
                </ToolbarLabel>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent {...menuProps}>
              <DropdownMenuRadioGroup
                value={monitor ? String(chosen) : "all"}
                onValueChange={(value) =>
                  setChosen(value === "all" ? null : Number(value))
                }
              >
                <DropdownMenuRadioItem value="all">
                  All monitors
                </DropdownMenuRadioItem>
                {monitors.map(({ height, width }, index) => (
                  <DropdownMenuRadioItem key={index} value={String(index)}>
                    Monitor {index + 1}
                    <DropdownMenuShortcut>
                      {width} × {height}
                    </DropdownMenuShortcut>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {client.offersLossless && !video ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-pressed={fastMotion}
                size="sm"
                variant={fastMotion ? "secondary" : "ghost"}
                onClick={() => {
                  setFastMotion((value) => !value)
                  surface.current?.focus()
                }}
              >
                <Rabbit />
                <ToolbarLabel>Fast motion</ToolbarLabel>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Keeps big displays moving by skipping pixels in motion. Sharpens
              when it stops.
            </TooltipContent>
          </Tooltip>
        ) : null}
        {client.offersLossless ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-pressed={lossless}
                size="sm"
                variant={lossless ? "secondary" : "ghost"}
                onClick={() => {
                  setLossless((value) => !value)
                  surface.current?.focus()
                }}
              >
                <Gem />
                <ToolbarLabel>Lossless</ToolbarLabel>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Every pixel exact, for small text and artwork. Moves slower.
            </TooltipContent>
          </Tooltip>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost">
              <Command />
              <ToolbarLabel>Send keys</ToolbarLabel>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent {...menuProps}>
            {client.combos.map((combo) => (
              <DropdownMenuItem
                key={combo.label}
                onSelect={() => surface.current?.sendKeys(combo.keys)}
              >
                {combo.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" variant="ghost" onClick={toggleExpanded}>
          {expanded ? <Minimize /> : <Maximize />}
          <ToolbarLabel>
            {expanded ? "Exit fullscreen" : "Fullscreen"}
          </ToolbarLabel>
        </Button>
        <Button size="sm" variant="ghost" onClick={onDisconnect}>
          <Unplug />
          <ToolbarLabel>Disconnect</ToolbarLabel>
        </Button>
      </div>
      <DesktopViewport
        imageSize={client.cropsMonitors ? null : imageSize}
        monitor={monitor}
      >
        <client.Surface
          desktop={desktop}
          relayId={relayId}
          session={session}
          surface={surface}
          onImageSize={setImageSize}
          onKeyboard={setKeyboardOpen}
          onVideo={setVideo}
        />
      </DesktopViewport>
    </div>
  )
}

// Icons alone on a phone, where the toolbar can't hold every name.
function ToolbarLabel({ children }: { children: React.ReactNode }) {
  return <span className="max-sm:sr-only">{children}</span>
}

// What this browser was last set to, or else what suits its main pointer: a
// laptop with a touch screen still has a mouse first.
function prefersTrackpad() {
  const saved = Result.getOrElse(
    Result.try(() => window.localStorage.getItem(TRACKPAD_STORAGE_KEY)),
    () => null
  )
  return saved === null
    ? window.matchMedia(MAIN_POINTER_IS_TOUCH).matches
    : saved === "true"
}

function rememberTrackpad(trackpad: boolean) {
  Result.try(() =>
    window.localStorage.setItem(TRACKPAD_STORAGE_KEY, String(trackpad))
  )
}

function useTouchScreen() {
  return React.useSyncExternalStore(
    subscribeToPointer,
    () => window.matchMedia(TOUCH_SCREEN).matches,
    () => false
  )
}

function subscribeToPointer(onChange: () => void) {
  const query = window.matchMedia(TOUCH_SCREEN)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

// Shows one monitor of the image by making the client's element as large as
// the whole image would be at that monitor's scale, and clipping it to that
// monitor. The client needs no idea of it: its own scaling and pointer mapping
// follow its element, so this works for any of them.
function DesktopViewport({
  children,
  imageSize,
  monitor,
}: {
  children: React.ReactNode
  imageSize: DesktopImageSize | null
  monitor: RelayDesktopMonitor | undefined
}) {
  const [area, setArea] = React.useState<HTMLDivElement | null>(null)
  const [areaSize, setAreaSize] = React.useState({ height: 0, width: 0 })
  React.useEffect(() => {
    if (!area) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      setAreaSize({
        height: entry.contentRect.height,
        width: entry.contentRect.width,
      })
    })
    observer.observe(area)
    return () => observer.disconnect()
  }, [area])
  const crop =
    monitor && imageSize && areaSize.width > 0
      ? cropOf(monitor, imageSize, areaSize)
      : undefined
  return (
    <div
      className="relative flex min-h-0 w-full flex-1 overflow-hidden bg-black"
      ref={setArea}
    >
      <div
        className={cn(
          "flex min-h-0",
          crop ? "absolute overflow-hidden" : "w-full flex-1"
        )}
        style={crop?.monitor}
      >
        <div
          className={cn("flex min-h-0", crop ? "absolute" : "w-full flex-1")}
          style={crop?.image}
        >
          {children}
        </div>
      </div>
    </div>
  )
}

// The monitor centered in the area, clipping the image to it so that its
// neighbours don't show in the margins, and the image placed behind it.
function cropOf(
  monitor: RelayDesktopMonitor,
  image: DesktopImageSize,
  area: DesktopImageSize
): { image: React.CSSProperties; monitor: React.CSSProperties } {
  const scale = Math.min(
    area.width / monitor.width,
    area.height / monitor.height
  )
  return {
    image: {
      height: image.height * scale,
      left: -monitor.x * scale,
      top: -monitor.y * scale,
      width: image.width * scale,
    },
    monitor: {
      height: monitor.height * scale,
      left: (area.width - monitor.width * scale) / 2,
      top: (area.height - monitor.height * scale) / 2,
      width: monitor.width * scale,
    },
  }
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
  surface: React.RefObject<DesktopSurface | null>,
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
      surface.current?.focus()
    }
    document.addEventListener("fullscreenchange", onChange)
    return () => {
      document.removeEventListener("fullscreenchange", onChange)
      keyboard?.unlock()
    }
  }, [keyboard, surface])
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
    surface.current?.focus()
  }, [filled, native, root, surface])
  return { expanded: native || filled, toggleExpanded }
}

function useUnsupported(client: DesktopClient) {
  return React.useSyncExternalStore(
    noSubscription,
    client.unsupported,
    () => null
  )
}

function noSubscription() {
  return () => undefined
}

// Why there's nothing to show, in the desktop's place.
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
    <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto bg-card p-6 text-center">
      <div className="flex max-w-sm flex-col items-center">
        <div className="mb-4 grid size-11 place-items-center rounded-xl border bg-muted/20 text-muted-foreground [&_svg]:size-5">
          {icon}
        </div>
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
  )
}
