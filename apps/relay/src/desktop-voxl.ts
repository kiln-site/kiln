import { randomBytes } from "node:crypto"
import { request as httpRequest } from "node:http"
import { connect, type Socket } from "node:net"

import type { RelayDesktop } from "@workspace/contracts"
import { Effect } from "effect"

import type { RelayConfig } from "./config.js"
import {
  DesktopUnavailableError,
  type DesktopBackend,
  type DesktopStream,
} from "./desktop-backend.js"
import { DesktopHelper } from "./desktop-helper.js"
import { ensureImage } from "./docker-engine.js"
import type { HostShell } from "./host-shell.js"

// An X11 desktop, streamed by voxl (apps/desktop). voxl runs in a helper
// container beside the node's X server: it connects to the display's socket
// as the signed-in person, and shares the Relay's network namespace, so it
// listens only where the Relay can reach it.

// Raised whenever how the streamer runs changes, so older ones are replaced.
const DESKTOP_REVISION = "2"
// Inside the Relay's network namespace, which the streamer shares.
const VOXL_PORT = 47901
const VOXL_HOST = "127.0.0.1"
const XAUTHORITY_PATH = "/run/kiln-desktop/Xauthority"
const PULSE_PATH = "/run/kiln-desktop/pulse"
const SESSION_TEXT_MAX = 200
// What the detection script reports. The display and the cookie's path come
// from the environment of the person's processes, which they control, and
// become the streamer's mounts, so only exact shapes count; a root session
// isn't streamed at all.
const DISPLAY_PATTERN = /^:\d{1,4}$/u
const UID_PATTERN = /^[1-9]\d{0,9}$/u
const GID_PATTERN = /^\d{1,10}$/u
const PATH_PATTERN = /^(?:\/[A-Za-z0-9._@+-]+)+$/u
const MONITOR_PATTERN = /^(\d{1,5})x(\d{1,5})\+(\d{1,5})\+(\d{1,5})$/u
const MAX_MONITORS = 16

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
gid=$(id -g "$uid" 2>/dev/null || echo "$uid")
emit status x11
emit uid "$uid"
emit gid "$gid"
emit display ":$number"
emit xauthority "$xauthority"
if command -v xrandr >/dev/null 2>&1 && command -v setpriv >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then
  index=0
  # As the signed-in person: it's their X server, which root shouldn't talk to.
  for monitor in $(DISPLAY=":$number" XAUTHORITY="$xauthority" timeout 3 setpriv --reuid="$uid" --regid="$gid" --clear-groups xrandr --listmonitors 2>/dev/null | sed -n 's#^ *[0-9]*: [^ ]* \([0-9]*\)/[0-9]*x\([0-9]*\)/[0-9]*+\([0-9]*\)+\([0-9]*\) .*#\1x\2+\3+\4#p'); do
    emit "monitor$index" "$monitor"
    index=$((index + 1))
  done
fi
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

type VoxlConfig = Pick<
  RelayConfig,
  "desktopImage" | "dockerSocket" | "resourceNamespace"
>

export class VoxlDesktop implements DesktopBackend {
  readonly #config: VoxlConfig
  readonly #helper: DesktopHelper
  readonly #hostShell: Pick<HostShell, "runScript">
  #password: string | null = null

  constructor(config: VoxlConfig, hostShell: Pick<HostShell, "runScript">) {
    this.#config = config
    this.#helper = new DesktopHelper(config, "kiln-desktop")
    this.#hostShell = hostShell
  }

  // The last in line: whatever no other backend serves.
  applies(): Promise<boolean> {
    return Promise.resolve(true)
  }

  async read(): Promise<RelayDesktop> {
    return (await this.#detect()).public
  }

  async prepare(closeStreams: () => void): Promise<RelayDesktop> {
    const detected = await this.#detect()
    if (!detected.x11) {
      throw new DesktopUnavailableError(
        detected.public.status === "wayland"
          ? "This node's desktop runs on Wayland, which can't be streamed yet"
          : "This node has no graphical desktop to show"
      )
    }
    await this.#ensure(detected.x11, closeStreams)
    return detected.public
  }

  connect(stream: DesktopStream): void {
    const password = this.#password
    if (!password) {
      stream.refuse()
      return
    }
    const { head, request, socket } = stream
    const upstream: Socket = connect(VOXL_PORT, VOXL_HOST)
    let connected = false
    const close = () => {
      upstream.destroy()
      socket.destroy()
    }
    upstream.once("error", () => {
      if (!connected) stream.unreachable()
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

  async release(): Promise<void> {
    await this.#helper.release()
    this.#password = null
  }

  async #detect(): Promise<Detected> {
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
      public: {
        status: "x11",
        displayManager,
        display,
        layouts: monitorLayouts(values),
        ...session,
      },
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
  async #ensure(
    desktop: X11Desktop,
    closeStreams: () => void
  ): Promise<void> {
    const image = this.#config.desktopImage
    // voxl joins the Relay's network namespace, so it must be the Relay's
    // current container.
    const relay = await this.#helper.relayContainer()
    const signature = JSON.stringify({
      desktop,
      image,
      relay: relay.Id,
      revision: DESKTOP_REVISION,
    })
    const existing = await this.#helper.existing()
    if (existing) {
      const password = existing.Config.Env?.find((entry) =>
        entry.startsWith("VOXL_PASSWORD=")
      )
      // A restarted Relay has a new network namespace, leaving a streamer
      // that still runs but that nothing can reach: only one that answers
      // is kept.
      if (
        this.#helper.matches(existing, signature) &&
        password &&
        (await healthy())
      ) {
        this.#password = password.slice("VOXL_PASSWORD=".length)
        return
      }
      // Another display, person, or Relay: start over, ending the old
      // streams.
      closeStreams()
      await this.#helper.remove(existing.Id)
    }
    await Effect.runPromise(ensureImage(this.#helper.engine, image))
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
      this.#helper.engine.createContainer(this.#helper.name, {
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
        Labels: this.#helper.labels(signature),
        User: `${desktop.uid}:${desktop.gid}`,
      })
    )
    await Effect.runPromise(this.#helper.engine.startContainer(created.Id))
    await this.#ready(created.Id)
    this.#password = password
  }

  // Waits for voxl to answer, failing with why it stopped if it does.
  async #ready(id: string): Promise<void> {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (await healthy()) return
      const state = await this.#helper.inspect()
      if (!state?.State.Running) {
        throw new DesktopUnavailableError(
          `The desktop streamer stopped (exit code ${state?.State.ExitCode ?? "unknown"}). It may not be able to open the display.`
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    await Effect.runPromise(
      this.#helper.engine.removeContainer(id, { force: true }).pipe(Effect.ignore)
    )
    throw new DesktopUnavailableError("The desktop streamer didn't start")
  }
}

// What xrandr reports, as `<width>x<height>+<x>+<y>` records.
function monitorLayouts(values: ReadonlyMap<string, string>) {
  const monitors = []
  for (let index = 0; index < MAX_MONITORS; index += 1) {
    const match = MONITOR_PATTERN.exec(values.get(`monitor${index}`) ?? "")
    if (!match) break
    const [width, height, x, y] = match.slice(1).map(Number)
    if (width && height) {
      monitors.push({ height, width, x: x ?? 0, y: y ?? 0 })
    }
  }
  return monitors.length > 0 ? [monitors] : []
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
