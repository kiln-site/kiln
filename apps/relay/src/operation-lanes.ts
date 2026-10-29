/**
 * Ordered lanes for every Relay mutation.
 *
 * An operation names the resources it touches as lock keys, each shared or
 * exclusive. It is granted when no running operation holds a conflicting
 * lock and no operation admitted before it is still waiting on a
 * conflicting one, so conflicting work runs in admission order while work on
 * other resources runs at once. All of an operation's locks are granted
 * together, which rules out deadlock.
 *
 * Every actor admits through the same lanes: Hearth's control socket, the
 * browser socket, SFTP, schedules, crash recovery, and the background
 * workers. See docs/relay-operations.md for the keys each operation takes.
 * The lane rules themselves are shared with Hearth's (`@workspace/operations`).
 */
import {
  OperationLanes as Lanes,
  type LaneLock,
  type OperationLanesOptions,
} from "@workspace/operations"

export {
  exclusive,
  LaneRejectedError,
  shared,
  type LaneAdmission,
  type LaneLock,
  type LaneMode,
  type LaneTicket,
} from "@workspace/operations"

export const laneKeys = {
  app: (id: string) => `app:${id}`,
  appFiles: (id: string) => `app:${id}/files`,
  appLifecycle: (id: string) => `app:${id}/lifecycle`,
  /** The Kiln volumes an App's configuration mounts, as Hearth last sent. */
  appVolumes: (id: string) => `app:${id}/volumes`,
  database: (id: string) => `database:${id}`,
  /** The Relay host's own files, under the host file root. */
  hostFiles: "relay:host-files",
  instance: (id: string) => `instance:${id}`,
  instanceFiles: (id: string) => `instance:${id}/files`,
  /** Power and console input: anything that changes the running process. */
  instanceLifecycle: (id: string) => `instance:${id}/lifecycle`,
  instanceMetadata: (id: string) => `instance:${id}/metadata`,
  /** Web routes, game ports, and the edge proxy shared by every resource. */
  routes: "relay:routes",
  /**
   * The node's memory and disk, which instances' limits reserve: checking a
   * change against the others and applying it happen together.
   */
  allocations: "relay:allocations",
  /** The Relay's own Tailscale settings, which every stack runs under. */
  tailscale: "relay:tailscale",
  /**
   * Kiln's own services, when the Relay hosts them: Hearth, its database,
   * and its cache. See platform.ts.
   */
  platform: "relay:platform",
  /** One of the Relay's Docker named volumes. */
  volume: (id: string) => `volume:${id}`,
} as const

/**
 * Why an operation may not run now, or null when it may: something the
 * Relay keeps across operations, such as a restore that didn't finish.
 */
export type LaneRefusal = (
  label: string,
  locks: ReadonlyArray<LaneLock>
) => string | null

/** The Relay's lanes, in its words and with its span attribute. */
export class OperationLanes extends Lanes {
  readonly #refusals: Array<LaneRefusal>

  constructor(options: Pick<OperationLanesOptions, "maxWaiting"> = {}) {
    const refusals: Array<LaneRefusal> = []
    super({
      ...options,
      messages: {
        busy: "The Relay is busy; try again shortly",
        paused: (label) => `${label} didn't run: this Relay is paused`,
      },
      refuse: (label, locks) => firstRefusal(refusals, label, locks),
      waitAttribute: "relay.lanes.wait_ms",
    })
    this.#refusals = refusals
  }

  /** Checks every operation from now on, as its turn comes. */
  addRefusal(refusal: LaneRefusal): void {
    this.#refusals.push(refusal)
  }

  /**
   * Why work would be refused, for locks an operation takes once it's
   * running (`runNested`), which the lanes don't check themselves.
   */
  refusalFor(label: string, locks: ReadonlyArray<LaneLock>): string | null {
    return firstRefusal(this.#refusals, label, locks)
  }
}

function firstRefusal(
  refusals: ReadonlyArray<LaneRefusal>,
  label: string,
  locks: ReadonlyArray<LaneLock>
): string | null {
  for (const refusal of refusals) {
    const reason = refusal(label, locks)
    if (reason) return reason
  }
  return null
}
