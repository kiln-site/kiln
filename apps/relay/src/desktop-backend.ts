import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"

import type { RelayDesktop } from "@workspace/contracts"

/** A desktop that can't be opened now, for a reason the page can show. */
export class DesktopUnavailableError extends Error {}

/** A browser's stream, admitted by its ticket, for a backend to carry. */
export interface DesktopStream {
  readonly head: Buffer
  readonly request: IncomingMessage
  readonly socket: Duplex
  /** Turns the stream away, as when the backend isn't ready for it. */
  refuse(): void
  /**
   * The desktop can't be reached: ends the ticket, so Hearth's next heartbeat
   * tells the page to attach again, which finds what the node shows now.
   */
  unreachable(): void
}

/**
 * One way of showing a node's desktop. `Desktop` (desktop.ts) keeps what's the
 * same for all of them: tickets, streams and who may hold them, pausing, and
 * letting go once nobody's watching.
 */
export interface DesktopBackend {
  /** Whether this is how this node's desktop is shown; the first that is. */
  applies(): Promise<boolean>
  /** What the node shows now, without changing anything. */
  read(): Promise<RelayDesktop>
  /**
   * Readies the desktop for a stream, in the desktop's lane, and returns it.
   * Fails with `DesktopUnavailableError` when there's nothing to show.
   * `closeStreams` ends every stream, for a change that takes them down.
   */
  prepare(closeStreams: () => void): Promise<RelayDesktop>
  /** Carries an admitted stream, until either end closes it. */
  connect(stream: DesktopStream): void
  /** Lets go of whatever `prepare` started, once nobody's watching. */
  release(): Promise<void>
}
