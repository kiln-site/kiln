import { randomBytes } from "node:crypto"
import type { IncomingMessage, Server } from "node:http"
import type { Duplex } from "node:stream"

import type { RelayDesktop } from "@workspace/contracts"
import { Effect } from "effect"

import type { RelayConfig } from "./config.js"
import {
  DesktopUnavailableError,
  type DesktopBackend,
} from "./desktop-backend.js"
import {
  ensuringPromise,
  forkPromise,
  promiseEffect,
} from "./effect/promise.js"
import {
  exclusive,
  laneKeys,
  type OperationLanes,
} from "./operation-lanes.js"
import { operation, runOperation } from "./operations/operation.js"
import { requestUrl } from "./request-url.js"

// The node's desktop. Browsers never reach a Relay or its node for it: Hearth
// checks who may watch, and carries each WebSocket through to
// `/v1/desktop/<ticket>/ws` here, which the node's backend carries on to the
// desktop (desktop-backend.ts). Hearth serves the clients itself, so nothing
// the node sends runs as a page in Hearth.

// A ticket lasts this long past its last heartbeat from Hearth, which sends
// one every 20 seconds while anyone watches.
const TICKET_TTL_MS = 60_000
// Backends let go of the desktop once nobody has watched for this long.
const IDLE_MS = 5 * 60_000
const SWEEP_INTERVAL_MS = 10_000
const MAX_TICKETS = 32
const TICKET_PATTERN = /^\/v1\/desktop\/([A-Za-z0-9_-]{43})\/ws$/u

interface Ticket {
  readonly backend: DesktopBackend
  expiresAt: number
  readonly sockets: Set<Duplex>
}

export class Desktop {
  readonly #backends: ReadonlyArray<DesktopBackend>
  readonly #config: Pick<RelayConfig, "hostAccess">
  readonly #lanes: OperationLanes
  readonly #tickets = new Map<string, Ticket>()
  // Stopping waits its turn with attaching, which starts what it stops, and
  // only goes ahead if nobody has attached since.
  readonly #stop = operation<{ readonly idleOnly: boolean }>()({
    name: "relay.desktop.stop",
    locks: () => [exclusive(laneKeys.desktop)],
    precondition: ({ input }) => !input.idleOnly || this.#idle(),
    run: () => promiseEffect(() => this.#release()),
  })
  #lastWatched = Date.now()
  // Whether anything may be running, as a streamer an earlier process left
  // may be.
  #mayBeRunning = true
  #stopping = false
  #sweeper: ReturnType<typeof setInterval> | null = null

  /** `backends` in order of preference: the first that applies shows it. */
  constructor(
    backends: ReadonlyArray<DesktopBackend>,
    config: Pick<RelayConfig, "hostAccess">,
    lanes: OperationLanes
  ) {
    this.#backends = backends
    this.#config = config
    this.#lanes = lanes
  }

  /** What the node shows: its desktop, if any. */
  async read(): Promise<RelayDesktop> {
    const unavailable = this.#unavailable()
    if (unavailable) return unavailable
    return (await this.#backend()).read()
  }

  /**
   * Readies the node's desktop if it isn't, and returns a ticket Hearth opens
   * the stream with.
   */
  async attach(): Promise<{ desktop: RelayDesktop; ticket: string }> {
    const unavailable = this.#unavailable()
    if (unavailable) {
      throw new DesktopUnavailableError("The desktop can't be opened now")
    }
    this.#sweepTickets()
    if (this.#tickets.size >= MAX_TICKETS) {
      throw new DesktopUnavailableError("Too many desktop sessions are open")
    }
    const backend = await this.#backend()
    this.#mayBeRunning = true
    const desktop = await backend.prepare(() => this.closeStreams())
    const ticket = randomBytes(32).toString("base64url")
    this.#tickets.set(ticket, {
      backend,
      expiresAt: Date.now() + TICKET_TTL_MS,
      sockets: new Set(),
    })
    this.#lastWatched = Date.now()
    return { desktop, ticket }
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

  /** Takes `/v1/desktop/<ticket>/ws` upgrades and carries them to the desktop. */
  attachServer(server: Server): void {
    // Also clears a streamer an earlier process left, which no attach may
    // ever come back for.
    this.#sweeper ??= setInterval(() => this.#sweep(), SWEEP_INTERVAL_MS)
    this.#sweeper.unref()
    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head) => {
      const match = TICKET_PATTERN.exec(requestUrl(request)?.pathname ?? "")
      if (!match) return
      socket.on("error", () => socket.destroy())
      // Upgraded sockets stay half open until they're destroyed.
      const refuse = () =>
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n", () =>
          socket.destroy()
        )
      const id = match[1] ?? ""
      const ticket = this.#ticket(id)
      if (!ticket || this.#lanes.paused) {
        refuse()
        return
      }
      this.#lastWatched = Date.now()
      ticket.sockets.add(socket)
      socket.once("close", () => ticket.sockets.delete(socket))
      ticket.backend.connect({
        head,
        refuse,
        request,
        socket,
        unreachable: () => this.detach(id),
      })
    })
  }

  /** Lets go of the desktop, as when host access is turned off. */
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

  // What stands in for the desktop while it can't be shown at all.
  #unavailable(): RelayDesktop | null {
    if (!this.#config.hostAccess) {
      return { status: "disabled", displayManager: false }
    }
    // Reaching the host can start its helper, and a stream takes input,
    // neither of which a paused Relay does.
    if (this.#lanes.paused) return { status: "paused", displayManager: false }
    return null
  }

  async #backend(): Promise<DesktopBackend> {
    for (const backend of this.#backends) {
      if (await backend.applies()) return backend
    }
    throw new DesktopUnavailableError("This node has no desktop to show")
  }

  async #release(): Promise<void> {
    this.closeStreams()
    await Promise.all(this.#backends.map((backend) => backend.release()))
    this.#mayBeRunning = false
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
      this.#tickets.size === 0 && Date.now() - this.#lastWatched > IDLE_MS
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
}
