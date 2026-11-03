import { randomBytes } from "node:crypto"
import {
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from "node:http"
import { connect, type Socket } from "node:net"
import { hostname } from "node:os"
import type { Duplex } from "node:stream"

import type { RelayDesktop } from "@workspace/contracts"
import { Effect } from "effect"

import type { RelayConfig } from "./config.js"
import {
  DockerEngine,
  ensureImage,
  isDockerNotFound,
  type DockerContainerInspect,
} from "./docker-engine.js"
import {
  ensuringPromise,
  forkPromise,
  promiseEffect,
  recoverPromise,
} from "./effect/promise.js"
import type { HostShell } from "./host-shell.js"
import { exclusive, laneKeys, type OperationLanes } from "./operation-lanes.js"
import { operation, runOperation } from "./operations/operation.js"
import { RELAY_OWNER_LABEL, relayOwnsLabels } from "./relay-resources.js"
import { requestUrl } from "./request-url.js"

// The node's desktop, streamed by voxl (apps/desktop). voxl runs in a helper
// container beside the node's X server: it connects to the display's socket
// as the signed-in person, and shares the Relay's network namespace, so it
// listens only where the Relay can reach it. Browsers never reach voxl or
// the Relay for it directly: Hearth checks who may watch, and carries each
// WebSocket through to `/v1/desktop/<ticket>/ws` here, which this module
// carries on to voxl. Hearth serves voxl's page itself (apps/web/public/
// desktop-client), so nothing the node sends runs as a page in Hearth.

const DESKTOP_LABEL = "kiln.relay.infrastructure"
const DESKTOP_CONFIG_LABEL = "kiln.relay.desktop.config"
// Raised whenever how the streamer runs changes, so older ones are replaced.
const DESKTOP_REVISION = "2"
// Inside the Relay's network namespace, which the streamer shares.
const VOXL_PORT = 47901
const VOXL_HOST = "127.0.0.1"
const XAUTHORITY_PATH = "/run/kiln-desktop/Xauthority"
const PULSE_PATH = "/run/kiln-desktop/pulse"

// A ticket lasts this long past its last heartbeat from Hearth, which sends
// one every 20 seconds while anyone watches.
const TICKET_TTL_MS = 60_000
// The streamer stops once nobody has watched for this long, letting go of
// the display.
const STREAMER_IDLE_MS = 5 * 60_000
const SWEEP_INTERVAL_MS = 10_000
const MAX_TICKETS = 32
const TICKET_PATTERN = /^\/v1\/desktop\/([A-Za-z0-9_-]{43})\/ws$/u
const SESSION_TEXT_MAX = 200
// What the detection script reports. The display and the cookie's path come
// from the environment of the person's processes, which they control, and
// become the streamer's mounts, so only exact shapes count; a root session
// isn't streamed at all.
const DISPLAY_PATTERN = /^:\d{1,4}$/u
const UID_PATTERN = /^[1-9]\d{0,9}$/u
const GID_PATTERN = /^\d{1,10}$/u
const PATH_PATTERN = /^(?:\/[A-Za-z0-9._@+-]+)+$/u

// Finds the desktop someone is signed in to on the node, from logind: the
// active graphical session on a seat, a person's before the login screen's.
// For X11 it finds the display and its cookie in the environment of that
// person's processes, as their own programs find them.
const DETECT_SCRIPT = String.raw`set -u
emit() { printf '%s=%s\n' "$1" "$2"; }
dm=no
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet display-manager 2>/dev/null; then dm=yes; fi
emit displayManager "$dm"
if ! command -v loginctl >/dev/null 2>&1; then emit status none; exit 0; fi
pick=""; best=0
for id in $(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}'); do
  info=$(loginctl show-session "$id" -p Type -p Active -p Class -p Seat 2>/dev/null) || continue
  type=$(printf '%s\n' "$info" | sed -n 's/^Type=//p')
  case "$type" in x11|wayland) ;; *) continue ;; esac
  rank=1
  [ -n "$(printf '%s\n' "$info" | sed -n 's/^Seat=//p')" ] && rank=$((rank + 1))
  [ "$(printf '%s\n' "$info" | sed -n 's/^Class=//p')" = user ] && rank=$((rank + 2))
  [ "$(printf '%s\n' "$info" | sed -n 's/^Active=//p')" = yes ] && rank=$((rank + 4))
  if [ "$rank" -gt "$best" ]; then pick=$id; best=$rank; fi
done
if [ -z "$pick" ]; then emit status none; exit 0; fi
type=$(loginctl show-session "$pick" -p Type --value)
uid=$(loginctl show-session "$pick" -p User --value)
emit user "$(loginctl show-session "$pick" -p Name --value)"
emit class "$(loginctl show-session "$pick" -p Class --value)"
display=""; xauthority=""; desktop=""
for pid in $(pgrep -u "$uid" 2>/dev/null); do
  env=$(tr '\n\0' ' \n' < "/proc/$pid/environ" 2>/dev/null) || continue
  value=$(printf '%s\n' "$env" | sed -n 's/^DISPLAY=//p' | head -n 1)
  [ -n "$desktop" ] || desktop=$(printf '%s\n' "$env" | sed -n 's/^XDG_CURRENT_DESKTOP=//p' | head -n 1)
  case "$value" in :[0-9]*) ;; *) continue ;; esac
  display=$value
  xauthority=$(printf '%s\n' "$env" | sed -n 's/^XAUTHORITY=//p' | head -n 1)
  break
done
emit desktop "$desktop"
if [ "$type" = wayland ]; then emit status wayland; exit 0; fi
number=$(printf '%s' "$display" | sed 's/^://; s/\..*$//')
if [ -z "$number" ] || [ ! -S "/tmp/.X11-unix/X$number" ]; then emit status none; exit 0; fi
home=$(getent passwd "$uid" | cut -d: -f6)
if [ -z "$xauthority" ] && [ -n "$home" ]; then xauthority="$home/.Xauthority"; fi
# Mounted into the streamer, and named by that person's own processes: only
# their own regular file counts.
if [ -L "$xauthority" ] || [ ! -f "$xauthority" ] || [ "$(stat -c %u "$xauthority" 2>/dev/null)" != "$uid" ]; then xauthority=""; fi
emit status x11
emit uid "$uid"
emit gid "$(id -g "$uid" 2>/dev/null || echo "$uid")"
emit display ":$number"
emit xauthority "$xauthority"
[ -S "/run/user/$uid/pulse/native" ] && emit pulse yes
exit 0`

interface X11Desktop {
  readonly display: string
  readonly gid: string
  readonly pulse: boolean
  readonly uid: string
  readonly xauthority: string | null
}

interface Detected {
  readonly public: RelayDesktop
  readonly x11: X11Desktop | null
}

interface Ticket {
  expiresAt: number
  readonly sockets: Set<Duplex>
}

export class DesktopUnavailableError extends Error {}

export class Desktop {
  readonly #config: Pick<
    RelayConfig,
    "desktopImage" | "dockerSocket" | "hostAccess" | "resourceNamespace"
  >
  readonly #engine: DockerEngine
  readonly #hostShell: Pick<HostShell, "runScript">
  readonly #lanes: OperationLanes
  readonly #name: string
  readonly #tickets = new Map<string, Ticket>()
  // Stopping the streamer waits its turn with attaching, which starts it, and
  // only goes ahead if nobody has attached since.
  readonly #stop = operation<{ readonly idleOnly: boolean }>()({
    name: "relay.desktop.stop",
    locks: () => [exclusive(laneKeys.desktop)],
    precondition: ({ input }) => !input.idleOnly || this.#idle(),
    run: () => promiseEffect(() => this.#removeStreamer()),
  })
  #password: string | null = null
  #lastWatched = Date.now()
  // Whether a streamer may be running, as one an earlier process left may be.
  #mayBeRunning = true
  #stopping = false
  #sweeper: ReturnType<typeof setInterval> | null = null

  constructor(
    config: Pick<
      RelayConfig,
      "desktopImage" | "dockerSocket" | "hostAccess" | "resourceNamespace"
    >,
    hostShell: Pick<HostShell, "runScript">,
    lanes: OperationLanes
  ) {
    this.#config = config
    this.#engine = new DockerEngine(config.dockerSocket)
    this.#hostShell = hostShell
    this.#lanes = lanes
    this.#name = config.resourceNamespace
      ? `${config.resourceNamespace}-kiln-desktop`
      : "kiln-desktop"
  }

  /** What the node shows: its signed-in desktop, if any. */
  async read(): Promise<RelayDesktop> {
    return (await this.#detect()).public
  }

  /**
   * Starts the streamer on the node's display if it isn't, and returns a
   * ticket Hearth opens the stream with.
   */
  async attach(): Promise<{ desktop: RelayDesktop; ticket: string }> {
    const detected = await this.#detect()
    const x11 = detected.x11
    const image = this.#config.desktopImage
    if (!x11 || !image) {
      throw new DesktopUnavailableError(
        detected.public.status === "wayland"
          ? "This node's desktop runs on Wayland, which can't be streamed yet"
          : "This node has no graphical desktop to show"
      )
    }
    this.#sweepTickets()
    if (this.#tickets.size >= MAX_TICKETS) {
      throw new DesktopUnavailableError("Too many desktop sessions are open")
    }
    this.#mayBeRunning = true
    await this.#ensure(x11, image)
    const ticket = randomBytes(32).toString("base64url")
    this.#tickets.set(ticket, {
      expiresAt: Date.now() + TICKET_TTL_MS,
      sockets: new Set(),
    })
    this.#lastWatched = Date.now()
    return { desktop: detected.public, ticket }
  }

  /** Keeps the tickets Hearth still uses; returns the ones still valid. */
  heartbeat(tickets: ReadonlyArray<string>): { tickets: Array<string> } {
    const now = Date.now()
    const alive: Array<string> = []
    for (const id of tickets) {
      const ticket = this.#ticket(id)
      if (!ticket) continue
      ticket.expiresAt = now + TICKET_TTL_MS
      alive.push(id)
    }
    if (alive.length > 0) this.#lastWatched = now
    return { tickets: alive }
  }

  /** Ends a ticket and every stream it opened. */
  detach(id: string): void {
    const ticket = this.#tickets.get(id)
    if (!ticket) return
    this.#tickets.delete(id)
    for (const socket of ticket.sockets) socket.destroy()
  }

  /** Ends every ticket and stream, as when the Relay is paused. */
  closeStreams(): void {
    for (const id of this.#tickets.keys()) this.detach(id)
  }

  /** Takes `/v1/desktop/<ticket>/ws` upgrades and carries them to voxl. */
  attachServer(server: Server): void {
    // Also clears a streamer an earlier process left, which no attach may
    // ever come back for.
    this.#sweeper ??= setInterval(() => this.#sweep(), SWEEP_INTERVAL_MS)
    this.#sweeper.unref()
    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head) => {
      const match = TICKET_PATTERN.exec(requestUrl(request)?.pathname ?? "")
      if (!match) return
      socket.on("error", () => socket.destroy())
      const ticket = this.#ticket(match[1] ?? "")
      const password = this.#password
      if (!ticket || !password || this.#lanes.paused) {
        // Upgraded sockets stay half open until they're destroyed.
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n", () =>
          socket.destroy()
        )
        return
      }
      this.#lastWatched = Date.now()
      this.#pipe(request, socket, head, match[1] ?? "", ticket, password)
    })
  }

  /** Stops the streamer, as when host access is turned off. */
  remove(): Promise<void> {
    return Effect.runPromise(
      runOperation(
        this.#lanes,
        this.#stop,
        { idleOnly: false },
        { kind: "worker" }
      )
    )
  }

  async #removeStreamer(): Promise<void> {
    this.closeStreams()
    const existing = await this.#inspect()
    if (existing && this.#owns(existing)) {
      await Effect.runPromise(
        this.#engine.removeContainer(existing.Id, { force: true })
      )
    }
    this.#password = null
    this.#mayBeRunning = false
  }

  #pipe(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    id: string,
    ticket: Ticket,
    password: string
  ) {
    const upstream: Socket = connect(VOXL_PORT, VOXL_HOST)
    ticket.sockets.add(socket)
    let connected = false
    const close = () => {
      ticket.sockets.delete(socket)
      upstream.destroy()
      socket.destroy()
    }
    upstream.once("error", () => {
      // A streamer that's gone ends the ticket, so Hearth's next heartbeat
      // tells the page to attach again, which starts another.
      if (!connected) this.detach(id)
      close()
    })
    upstream.once("close", close)
    socket.once("close", close)
    upstream.once("connect", () => {
      connected = true
      upstream.setNoDelay(true)
      // The browser's own handshake, so voxl's answer completes it. No
      // Origin: Hearth checked the page, and voxl takes a request without
      // one as from a program.
      const lines = [
        "GET /ws HTTP/1.1",
        `Host: ${VOXL_HOST}:${VOXL_PORT}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Authorization: Bearer ${password}`,
      ]
      for (const name of [
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-protocol",
      ]) {
        const value = request.headers[name]
        if (typeof value === "string" && !/[\r\n]/u.test(value)) {
          lines.push(`${name}: ${value}`)
        }
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`)
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
  }

  #ticket(id: string): Ticket | null {
    const ticket = this.#tickets.get(id)
    if (!ticket) return null
    if (ticket.expiresAt > Date.now()) return ticket
    this.detach(id)
    return null
  }

  #sweepTickets() {
    const now = Date.now()
    for (const [id, ticket] of this.#tickets) {
      if (ticket.expiresAt <= now) this.detach(id)
      else if (ticket.sockets.size > 0) this.#lastWatched = now
    }
  }

  #idle(): boolean {
    return (
      this.#tickets.size === 0 &&
      Date.now() - this.#lastWatched > STREAMER_IDLE_MS
    )
  }

  #sweep() {
    this.#sweepTickets()
    if (
      !this.#mayBeRunning ||
      this.#stopping ||
      this.#lanes.paused ||
      !this.#idle()
    ) {
      return
    }
    this.#stopping = true
    forkPromise(() =>
      ensuringPromise(
        () =>
          Effect.runPromise(
            runOperation(
              this.#lanes,
              this.#stop,
              { idleOnly: true },
              { kind: "timer" }
            )
          ),
        () => {
          this.#stopping = false
        }
      )
    )
  }

  async #detect(): Promise<Detected> {
    const unavailable = (status: "disabled" | "paused" | "unconfigured") => ({
      public: { status, displayManager: false },
      x11: null,
    })
    if (!this.#config.hostAccess) return unavailable("disabled")
    if (!this.#config.desktopImage) return unavailable("unconfigured")
    // Reaching the host can start its helper, which a paused Relay doesn't.
    if (this.#lanes.paused) return unavailable("paused")
    const values = parseDetection(
      await this.#hostShell.runScript(DETECT_SCRIPT)
    )
    const text = (key: string) =>
      values.get(key)?.slice(0, SESSION_TEXT_MAX) || null
    const displayManager = values.get("displayManager") === "yes"
    const session = {
      desktop: text("desktop"),
      greeter: values.get("class") === "greeter",
      user: text("user"),
    }
    const status = values.get("status")
    if (status === "wayland") {
      return {
        public: { status: "wayland", displayManager, ...session },
        x11: null,
      }
    }
    const display = values.get("display")
    const uid = values.get("uid")
    if (
      status !== "x11" ||
      !display ||
      !DISPLAY_PATTERN.test(display) ||
      !uid ||
      !UID_PATTERN.test(uid)
    ) {
      return { public: { status: "none", displayManager }, x11: null }
    }
    const gid = values.get("gid")
    const xauthority = values.get("xauthority")
    return {
      public: { status: "x11", displayManager, display, ...session },
      x11: {
        display,
        gid: gid && GID_PATTERN.test(gid) ? gid : uid,
        pulse: values.get("pulse") === "yes",
        uid,
        xauthority:
          xauthority &&
          PATH_PATTERN.test(xauthority) &&
          !xauthority.split("/").includes("..")
            ? xauthority
            : null,
      },
    }
  }

  // The streamer for `desktop`, started if it isn't. Runs in the desktop's
  // lane, with `relay.desktop.attach`.
  async #ensure(desktop: X11Desktop, image: string): Promise<void> {
    // voxl joins the Relay's network namespace, so it must be the Relay's
    // current container.
    const relay = await recoverPromise(
      () =>
        Effect.runPromise(
          this.#engine.inspectContainer<DockerContainerInspect>(hostname())
        ),
      () => {
        throw new DesktopUnavailableError(
          "The desktop needs the Relay to run in a Docker container"
        )
      }
    )
    const signature = JSON.stringify({
      desktop,
      image,
      relay: relay.Id,
      revision: DESKTOP_REVISION,
    })
    const existing = await this.#inspect()
    if (existing) {
      if (!this.#owns(existing)) {
        throw new Error(
          `Docker container ${this.#name} exists but is not owned by this Relay`
        )
      }
      const password = existing.Config.Env?.find((entry) =>
        entry.startsWith("VOXL_PASSWORD=")
      )
      // A restarted Relay has a new network namespace, leaving a streamer
      // that still runs but that nothing can reach: only one that answers
      // is kept.
      if (
        existing.Config.Labels?.[DESKTOP_CONFIG_LABEL] === signature &&
        existing.State.Running &&
        password &&
        (await healthy())
      ) {
        this.#password = password.slice("VOXL_PASSWORD=".length)
        return
      }
      // Another display, person, or Relay: start over, ending the old
      // streams.
      this.closeStreams()
      await Effect.runPromise(
        this.#engine.removeContainer(existing.Id, { force: true })
      )
    }
    await Effect.runPromise(ensureImage(this.#engine, image))
    const password = randomBytes(32).toString("base64url")
    const socket = `/tmp/.X11-unix/X${desktop.display.slice(1)}`
    const pulse = `/run/user/${desktop.uid}/pulse/native`
    // Mounts, not binds: Docker refuses a missing path instead of creating it.
    const mounts = [
      { ReadOnly: false, Source: socket, Target: socket, Type: "bind" },
      ...(desktop.xauthority
        ? [
            {
              ReadOnly: true,
              Source: desktop.xauthority,
              Target: XAUTHORITY_PATH,
              Type: "bind",
            },
          ]
        : []),
      ...(desktop.pulse
        ? [
            {
              ReadOnly: false,
              Source: pulse,
              Target: PULSE_PATH,
              Type: "bind",
            },
          ]
        : []),
    ]
    const created = await Effect.runPromise(
      this.#engine.createContainer(this.#name, {
        Cmd: [
          `--addr=${VOXL_HOST}`,
          `--port=${VOXL_PORT}`,
          "--title=Desktop",
          // Kiln has its own host files; the node's screen isn't resized
          // to fit a viewer's window.
          "--file-transfers=none",
          "--enable-resize=false",
          "--microphone-enabled=false",
          `--audio-enabled=${desktop.pulse ? "true" : "false"}`,
          "--audio-device-name=@DEFAULT_MONITOR@",
        ],
        Env: [
          `DISPLAY=${desktop.display}`,
          "HOME=/tmp",
          `VOXL_PASSWORD=${password}`,
          ...(desktop.xauthority ? [`XAUTHORITY=${XAUTHORITY_PATH}`] : []),
          ...(desktop.pulse ? [`PULSE_SERVER=unix:${PULSE_PATH}`] : []),
        ],
        HostConfig: {
          CapDrop: ["ALL"],
          Init: true,
          // MIT-SHM: the X server reads frames from shared memory voxl
          // creates.
          IpcMode: "host",
          Mounts: mounts,
          NetworkMode: `container:${relay.Id}`,
          RestartPolicy: { Name: "no" },
          SecurityOpt: ["no-new-privileges"],
        },
        Image: image,
        Labels: {
          [DESKTOP_LABEL]: "desktop",
          [DESKTOP_CONFIG_LABEL]: signature,
          "kiln.relay.owned": "true",
          ...(this.#config.resourceNamespace
            ? { [RELAY_OWNER_LABEL]: this.#config.resourceNamespace }
            : {}),
        },
        User: `${desktop.uid}:${desktop.gid}`,
      })
    )
    await Effect.runPromise(this.#engine.startContainer(created.Id))
    await this.#ready(created.Id)
    this.#password = password
  }

  // Waits for voxl to answer, failing with why it stopped if it does.
  async #ready(id: string): Promise<void> {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (await healthy()) return
      const state = await this.#inspect()
      if (!state?.State.Running) {
        throw new DesktopUnavailableError(
          `The desktop streamer stopped (exit code ${state?.State.ExitCode ?? "unknown"}). It may not be able to open the display.`
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    await Effect.runPromise(
      this.#engine.removeContainer(id, { force: true }).pipe(Effect.ignore)
    )
    throw new DesktopUnavailableError("The desktop streamer didn't start")
  }

  #owns(container: DockerContainerInspect): boolean {
    return (
      relayOwnsLabels(this.#config, container.Config.Labels) &&
      container.Config.Labels?.[DESKTOP_LABEL] === "desktop"
    )
  }

  async #inspect(): Promise<DockerContainerInspect | null> {
    return Effect.runPromise(
      this.#engine
        .inspectContainer<DockerContainerInspect>(this.#name)
        .pipe(
          Effect.catch((cause) =>
            isDockerNotFound(cause) ? Effect.succeed(null) : Effect.fail(cause)
          )
        )
    )
  }
}

// One record per line; a repeated field isn't what the script wrote, so
// nothing from that output counts.
function parseDetection(output: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>()
  for (const line of output.split("\n")) {
    const separator = line.indexOf("=")
    if (separator <= 0) continue
    const key = line.slice(0, separator)
    if (values.has(key)) return new Map()
    values.set(key, line.slice(separator + 1).trim())
  }
  return values
}

function healthy(): Promise<boolean> {
  return new Promise((resolve) => {
    const request = httpRequest(
      {
        host: VOXL_HOST,
        path: "/healthz",
        port: VOXL_PORT,
        timeout: 1_000,
      },
      (response) => {
        response.resume()
        resolve(response.statusCode === 200)
      }
    )
    request.once("error", () => resolve(false))
    request.once("timeout", () => request.destroy())
    request.end()
  })
}
