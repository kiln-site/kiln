import { connect } from "node:net"
import type { Socket } from "node:net"

import type { RelayDesktop } from "@workspace/contracts"
import { Effect } from "effect"
import { WebSocketServer } from "ws"

import type { RelayConfig } from "./config.js"
import {
  DesktopUnavailableError,
  type DesktopBackend,
  type DesktopStream,
} from "./desktop-backend.js"
import { DockerEngine } from "./docker-engine.js"
import { carryScaledScreen } from "./desktop-screen-scaling.js"
import { DesktopVideo } from "./desktop-video.js"
import { recoverPromise } from "./effect/promise.js"
import type { HostShell } from "./host-shell.js"
import type { OperationLanes } from "./operation-lanes.js"
import { MAC_HOST_SCRIPT, parseMacHost } from "./mac-host.js"

// A Mac's desktop, through macOS's own Screen Sharing. Docker on a Mac runs
// containers in a Linux VM, where nothing can capture the Mac's screen, but
// they can reach services on the Mac itself, and Screen Sharing is one: a VNC
// server the Mac's owner turns on in System Settings. So nothing is installed
// on the Mac. The viewer signs in to it, in noVNC, with its own account, which
// Kiln never sees, and the Relay shrinks the picture on its way
// (desktop-screen-scaling.ts), through a video encoder when it can get one
// (desktop-video.ts).

const PROBE_TIMEOUT_MS = 2_000
const GREETING_BYTES = 12
const GREETING_PATTERN = /^RFB \d{3}\.\d{3}\n$/u
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024

type ScreenSharingConfig = Pick<
  RelayConfig,
  | "desktopImage"
  | "dockerSocket"
  | "resourceNamespace"
  | "screenSharingAddress"
>

export class ScreenSharingDesktop implements DesktopBackend {
  readonly #engine: DockerEngine
  readonly #hostShell: Pick<HostShell, "runScript">
  readonly #host: string
  readonly #port: number
  readonly #video: DesktopVideo
  readonly #server = new WebSocketServer({
    clientTracking: false,
    maxPayload: MAX_MESSAGE_BYTES,
    noServer: true,
    perMessageDeflate: false,
  })
  #onMac: boolean | null = null

  constructor(
    config: ScreenSharingConfig,
    hostShell: Pick<HostShell, "runScript">,
    lanes: OperationLanes
  ) {
    this.#engine = new DockerEngine(config.dockerSocket)
    this.#hostShell = hostShell
    this.#host = config.screenSharingAddress.host
    this.#port = config.screenSharingAddress.port
    this.#video = new DesktopVideo(config, lanes)
  }

  async applies(): Promise<boolean> {
    this.#onMac ??= await Effect.runPromise(
      this.#engine.info({ timeout: 2_500 }).pipe(
        Effect.map(dockerRunsOnMac),
        // Not known yet, rather than not a Mac: asks again next time.
        Effect.catch(() => Effect.succeed(null))
      )
    )
    return this.#onMac === true
  }

  async read(): Promise<RelayDesktop> {
    if (!(await this.#listening())) {
      return { displayManager: false, status: "screen-sharing-off" }
    }
    // Conveniences: the desktop works without them.
    const mac = await recoverPromise(
      async () =>
        parseMacHost(await this.#hostShell.runScript(MAC_HOST_SCRIPT)),
      () => parseMacHost("")
    )
    return {
      accounts: [...mac.accounts],
      displayManager: false,
      layouts: mac.layouts.map((layout) => [...layout]),
      status: "screen-sharing",
    }
  }

  async prepare(): Promise<RelayDesktop> {
    const desktop = await this.read()
    if (desktop.status !== "screen-sharing") {
      throw new DesktopUnavailableError("Screen Sharing is off on this Mac")
    }
    // Without video the desktop still shows, as JPEG.
    await recoverPromise(
      () => this.#video.prepare(),
      (cause) =>
        Effect.runPromise(
          Effect.logWarning("The desktop's video encoder isn't available", {
            cause,
          })
        )
    )
    return desktop
  }

  connect(stream: DesktopStream): void {
    const { head, request, socket } = stream
    this.#server.handleUpgrade(request, socket, head, (webSocket) => {
      const upstream: Socket = connect(this.#port, this.#host)
      let connected = false
      upstream.once("connect", () => {
        connected = true
        upstream.setNoDelay(true)
      })
      upstream.once("error", () => {
        if (!connected) stream.unreachable()
      })
      carryScaledScreen(upstream, webSocket, () => this.#video.open())
    })
  }

  release(): Promise<void> {
    return this.#video.release()
  }

  // Whether Screen Sharing answers: a VNC server greets whoever connects.
  #listening(): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = connect(this.#port, this.#host)
      let greeting = ""
      const finish = (listening: boolean) => {
        probe.destroy()
        resolve(listening)
      }
      probe.setTimeout(PROBE_TIMEOUT_MS, () => finish(false))
      probe.once("error", () => finish(false))
      probe.once("close", () => finish(false))
      probe.on("data", (data) => {
        greeting += data.toString("latin1")
        if (greeting.length >= GREETING_BYTES) {
          finish(GREETING_PATTERN.test(greeting.slice(0, GREETING_BYTES)))
        }
      })
    })
  }
}

// Docker reports the VM it runs in, and says what runs it. Only the Mac's
// Docker runs on a Mac: OrbStack is Mac-only, and Docker Desktop's label names
// its socket under the Mac's /Users.
function dockerRunsOnMac(info: {
  readonly Labels?: ReadonlyArray<string> | null
  readonly OperatingSystem?: string
}): boolean {
  const name = info.OperatingSystem?.trim()
  if (name === "OrbStack") return true
  return (
    name === "Docker Desktop" &&
    (info.Labels ?? []).some((label) =>
      label.startsWith("com.docker.desktop.address=unix:///Users/")
    )
  )
}
