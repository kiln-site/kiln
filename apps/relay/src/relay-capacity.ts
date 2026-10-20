import { Effect, Metric } from "effect"

/**
 * How full the Relay's shared capacity is: the control requests Hearth sends
 * and the work they start, folder-size scans, file cursors, direct transfers,
 * and terminals. Every user of a Relay shares these, so they show when one
 * caller is crowding out the rest. Labels stay to the Relay and small fixed
 * sets, never users, paths, or request IDs.
 */
export interface RelayCapacity {
  readonly control: ControlCapacity
  readonly filesystems: ReadonlyArray<{
    readonly filesystem: "instances" | "apps" | "host"
    readonly capacity: FilesystemCapacity
  }>
  readonly transfers: number
  readonly terminals: TerminalCapacity
}

export interface ControlCapacity {
  readonly inFlight: number
  /** Since the oldest request in flight arrived; 0 with none. */
  readonly oldestInFlightMs: number
  /**
   * Work still running after the request that started it ended, as when
   * Hearth cancelled a read the Relay can't stop, or a change outlived its
   * request. It holds no request slot, so the in-flight count misses it.
   */
  readonly orphanedWork: number
  readonly oldestOrphanedWorkMs: number
  /** Requests the Relay sent Hearth that haven't been answered. */
  readonly reversePending: number
}

export interface FilesystemCapacity {
  readonly directorySizeScans: number
  readonly directorySizePending: number
  /** Open listing cursors, and searches; each has its own limit. */
  readonly directoryCursors: number
  readonly searchCursors: number
}

export interface TerminalCapacity {
  readonly sessions: number
  readonly viewers: number
}

const sampleInterval = "10 seconds"

const gauges = {
  inFlight: gauge(
    "relay.control.requests.in_flight",
    "Control requests the Relay is running for Hearth",
    "{request}"
  ),
  oldestInFlight: gauge(
    "relay.control.requests.oldest_age",
    "Time since the oldest control request in flight arrived",
    "s"
  ),
  orphanedWork: gauge(
    "relay.control.work.orphaned",
    "Work still running after the control request that started it ended",
    "{operation}"
  ),
  oldestOrphanedWork: gauge(
    "relay.control.work.oldest_orphaned_age",
    "Time the oldest work still running after its request ended has run",
    "s"
  ),
  reversePending: gauge(
    "relay.control.reverse_requests.pending",
    "Requests the Relay sent Hearth that are waiting for an answer",
    "{request}"
  ),
  directorySizeScans: gauge(
    "relay.files.directory_size.scans",
    "Folder-size scans running",
    "{scan}"
  ),
  directorySizePending: gauge(
    "relay.files.directory_size.pending",
    "Folders waiting for a size scan",
    "{folder}"
  ),
  cursors: gauge(
    "relay.files.cursors",
    "Open directory listing and file search cursors",
    "{cursor}"
  ),
  transfers: gauge(
    "relay.browser.transfers.active",
    "Direct file transfers between browsers and the Relay",
    "{transfer}"
  ),
  terminalSessions: gauge(
    "relay.terminals.sessions",
    "Terminal sessions open",
    "{session}"
  ),
  terminalViewers: gauge(
    "relay.terminals.viewers",
    "Viewers attached to terminal sessions",
    "{viewer}"
  ),
}

const refusals = Metric.counter("relay.control.requests.refused", {
  description: "Control requests the Relay turned away because it was full",
  attributes: { unit: "{request}" },
  incremental: true,
})

/** Counts a control request the Relay refused for lack of room. */
export function countRelayRefusal(
  relayId: string,
  reason: "in_flight_limit" | "lanes_full"
): Effect.Effect<void> {
  return Metric.update(
    Metric.withAttributes(refusals, { "relay.id": relayId, reason }),
    1
  )
}

/** Records the Relay's capacity gauges every ten seconds, for good. */
export function sampleRelayCapacity(
  relayId: () => string,
  read: () => RelayCapacity
): Effect.Effect<never> {
  return Effect.suspend(() => {
    const id = relayId()
    const { control, filesystems, terminals, transfers } = read()
    const at = (metric: Metric.Gauge<number>, extra = {}) =>
      Metric.withAttributes(metric, { "relay.id": id, ...extra })
    return Effect.all(
      [
        Metric.update(at(gauges.inFlight), control.inFlight),
        Metric.update(
          at(gauges.oldestInFlight),
          control.oldestInFlightMs / 1000
        ),
        Metric.update(at(gauges.orphanedWork), control.orphanedWork),
        Metric.update(
          at(gauges.oldestOrphanedWork),
          control.oldestOrphanedWorkMs / 1000
        ),
        Metric.update(at(gauges.reversePending), control.reversePending),
        Metric.update(at(gauges.transfers), transfers),
        Metric.update(at(gauges.terminalSessions), terminals.sessions),
        Metric.update(at(gauges.terminalViewers), terminals.viewers),
        ...filesystems.flatMap(({ capacity, filesystem }) => [
          Metric.update(
            at(gauges.directorySizeScans, { filesystem }),
            capacity.directorySizeScans
          ),
          Metric.update(
            at(gauges.directorySizePending, { filesystem }),
            capacity.directorySizePending
          ),
          Metric.update(
            at(gauges.cursors, { filesystem, kind: "directory" }),
            capacity.directoryCursors
          ),
          Metric.update(
            at(gauges.cursors, { filesystem, kind: "search" }),
            capacity.searchCursors
          ),
        ]),
      ],
      { discard: true }
    )
  }).pipe(Effect.andThen(Effect.sleep(sampleInterval)), Effect.forever)
}

function gauge(name: string, description: string, unit: string) {
  return Metric.gauge(name, { description, attributes: { unit } })
}
