import type {
  RelayConsoleLine,
  RelayInstanceRecovery,
  RelayObservedState,
} from "@workspace/contracts"

export interface RetainedConsoleLifecycleTimestamps {
  readonly failedAt?: string | null
  readonly stoppedAt?: string | null
  readonly stoppingAt?: string | null
}

export function initialConsoleStateLines(
  startedAt: string | null,
  state: RelayObservedState | undefined,
  readyAt: string | null = null,
  recovery: RelayInstanceRecovery | null = null,
  retained: RetainedConsoleLifecycleTimestamps = {}
): Array<RelayConsoleLine> {
  const recoveryLines = recovery ? [consoleRecoveryLine(recovery, null)] : []
  if (!startedAt) {
    return state
      ? [
          consoleStateLine(state, stateTimestamp(state, readyAt, retained)),
          ...recoveryLines,
        ]
      : recoveryLines
  }

  const lines = [consoleStateLine("starting", startedAt)]
  if (readyAt || state === "running") {
    lines.push(consoleStateLine("running", readyAt))
  }
  if (retained.stoppingAt || state === "stopping") {
    lines.push(consoleStateLine("stopping", retained.stoppingAt ?? null))
  }
  if (retained.failedAt || state === "failed") {
    lines.push(consoleStateLine("failed", retained.failedAt ?? null))
  } else if (retained.stoppedAt || state === "stopped") {
    lines.push(consoleStateLine("stopped", retained.stoppedAt ?? null))
  }
  return [...lines, ...recoveryLines].sort(compareConsoleLineOrder)
}

export function mergeConsoleStateLines(
  lines: ReadonlyArray<RelayConsoleLine>,
  startedAt: string | null,
  state: RelayObservedState | undefined,
  readyAt: string | null = null,
  recovery: RelayInstanceRecovery | null = null,
  retained: RetainedConsoleLifecycleTimestamps = {}
): Array<RelayConsoleLine> {
  return [
    ...initialConsoleStateLines(startedAt, state, readyAt, recovery, retained),
    ...lines,
  ].sort(compareConsoleLineOrder)
}

export function reconcileConsoleLifecycleLines(
  lines: ReadonlyArray<RelayConsoleLine>,
  startedAt: string | null,
  state: RelayObservedState | undefined,
  readyAt: string | null = null,
  recovery: RelayInstanceRecovery | null = null,
  retained: RetainedConsoleLifecycleTimestamps = {}
): Array<RelayConsoleLine> {
  return mergeConsoleStateLines(
    lines.filter(
      (line) => !isConsoleStateLine(line) && !isConsoleRecoveryLine(line)
    ),
    startedAt,
    state,
    readyAt,
    recovery,
    retained
  )
}

export function consoleSessionIsCurrent(
  awaitingNewSession: boolean,
  sessionAcceptedAheadOfRuntime: boolean,
  consoleStartedAt: string | null | undefined,
  runtimeStartedAt: string | null | undefined
): boolean {
  return (
    !awaitingNewSession &&
    consoleStartedAt !== null &&
    consoleStartedAt !== undefined &&
    (sessionAcceptedAheadOfRuntime || consoleStartedAt === runtimeStartedAt)
  )
}

export function consoleSessionAcceptedAheadOfRuntime(
  wasAcceptedAheadOfRuntime: boolean,
  previousConsoleStartedAt: string | null | undefined,
  nextConsoleStartedAt: string | null,
  runtimeState: RelayObservedState | undefined,
  runtimeStartedAt: string | null | undefined
): boolean {
  if (nextConsoleStartedAt !== previousConsoleStartedAt) {
    return (
      nextConsoleStartedAt !== null &&
      (runtimeState !== "running" || runtimeStartedAt !== nextConsoleStartedAt)
    )
  }
  if (runtimeState === "running" && runtimeStartedAt === nextConsoleStartedAt) {
    return false
  }
  return wasAcceptedAheadOfRuntime
}

export function shouldAwaitConsoleRecoverySession(
  recoveryPhase: RelayInstanceRecovery["phase"] | undefined,
  sessionAcceptedAheadOfRuntime: boolean
): boolean {
  return recoveryPhase === "pending" && !sessionAcceptedAheadOfRuntime
}

export function consoleRecoveryLine(
  recovery: RelayInstanceRecovery,
  timestamp: string | null
): RelayConsoleLine {
  const text = recoveryMessage(recovery)
  const color = recovery.phase === "failed" ? "#f87171" : "#fbbf24"
  return {
    id: `kiln-recovery:${recovery.attempt}:${recovery.phase}:${recovery.nextAttemptAt ?? "now"}`,
    timestamp,
    level: recovery.phase === "failed" ? "error" : "warn",
    text,
    segments: [{ text, color, bold: true }],
  }
}

export function mergeConsoleHistory(
  current: ReadonlyArray<RelayConsoleLine>,
  history: ReadonlyArray<RelayConsoleLine>
): Array<RelayConsoleLine> {
  return [...current, ...history].sort(compareConsoleLineOrder)
}

export function retimestampConsoleStateLine(
  lines: ReadonlyArray<RelayConsoleLine>,
  state: RelayObservedState,
  timestamp: string
): Array<RelayConsoleLine> | null {
  const stateLines = lines.filter((line) => isConsoleStateLineFor(line, state))
  if (
    stateLines.length === 0 ||
    (stateLines.length === 1 && stateLines[0]?.timestamp === timestamp)
  ) {
    return null
  }

  return mergeConsoleHistory(
    lines.filter((line) => !isConsoleStateLineFor(line, state)),
    [consoleStateLine(state, timestamp)]
  )
}

export function consoleStateLine(
  state: RelayObservedState,
  timestamp: string | null
): RelayConsoleLine {
  const labels: Record<RelayObservedState, string> = {
    failed: "Server failed",
    stopped: "Server stopped",
    provisioning: "Server is provisioning",
    running: "Server is running",
    starting: "Server is starting",
    stopping: "Server is stopping",
  }
  const color =
    state === "failed"
      ? "#f87171"
      : state === "running"
        ? "#4ade80"
        : state === "stopping"
          ? "#fbbf24"
          : "#60a5fa"
  return {
    id: `kiln-state:${timestamp ?? "now"}:${state}`,
    timestamp,
    level: state === "failed" ? "error" : "info",
    text: labels[state],
    segments: [{ text: labels[state], color, bold: true }],
  }
}

export function isConsoleStateLine(line: Pick<RelayConsoleLine, "id">) {
  return line.id.startsWith("kiln-state:")
}

export function isConsoleStateLineFor(
  line: Pick<RelayConsoleLine, "id">,
  state: RelayObservedState
) {
  return isConsoleStateLine(line) && line.id.endsWith(`:${state}`)
}

export function isConsoleRecoveryLine(line: Pick<RelayConsoleLine, "id">) {
  return line.id.startsWith("kiln-recovery:")
}

export function shouldRecordConsoleStateTransition(
  previous: RelayObservedState | undefined,
  next: RelayObservedState
) {
  if (previous === next) return false
  if (previous === "stopping" && next === "running") return false
  if (
    (previous === "stopped" || previous === "failed") &&
    (next === "running" || next === "stopping")
  ) {
    return false
  }
  return true
}

function compareConsoleLineOrder(
  left: RelayConsoleLine,
  right: RelayConsoleLine
): number {
  const timestampOrder = compareConsoleTimestamps(
    left.timestamp,
    right.timestamp
  )
  if (timestampOrder !== 0) return timestampOrder
  return linePosition(left) - linePosition(right)
}

function compareConsoleTimestamps(
  left: string | null,
  right: string | null
): number {
  if (left === right) return 0
  if (left === null) return 1
  if (right === null) return -1

  const leftExact = exactUtcTimestamp(left)
  const rightExact = exactUtcTimestamp(right)
  if (leftExact && rightExact) {
    if (leftExact.seconds !== rightExact.seconds) {
      return leftExact.seconds - rightExact.seconds
    }
    return leftExact.nanoseconds - rightExact.nanoseconds
  }

  const leftParsed = Date.parse(left)
  const rightParsed = Date.parse(right)
  if (Number.isFinite(leftParsed) && Number.isFinite(rightParsed)) {
    return leftParsed - rightParsed
  }
  if (Number.isFinite(leftParsed)) return -1
  if (Number.isFinite(rightParsed)) return 1
  return 0
}

function exactUtcTimestamp(
  timestamp: string
): { nanoseconds: number; seconds: number } | null {
  const match = timestamp.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/u
  )
  if (!match?.[1]) return null
  const milliseconds = Date.parse(`${match[1]}Z`)
  if (!Number.isFinite(milliseconds)) return null
  return {
    nanoseconds: Number((match[2] ?? "").slice(0, 9).padEnd(9, "0")),
    seconds: Math.floor(milliseconds / 1_000),
  }
}

function stateTimestamp(
  state: RelayObservedState,
  readyAt: string | null,
  retained: RetainedConsoleLifecycleTimestamps
): string | null {
  if (state === "running") return readyAt
  if (state === "stopping") return retained.stoppingAt ?? null
  if (state === "stopped") return retained.stoppedAt ?? null
  if (state === "failed") return retained.failedAt ?? null
  return null
}

function linePosition(line: RelayConsoleLine): number {
  if (line.id.endsWith(":starting")) return -1
  return isConsoleStateLine(line) || isConsoleRecoveryLine(line) ? 1 : 0
}

function recoveryMessage(recovery: RelayInstanceRecovery): string {
  if (recovery.phase === "failed") {
    const cause =
      recovery.reason === "out_of_memory"
        ? "The server ran out of memory repeatedly."
        : "The server failed repeatedly."
    return `${cause} Automatic recovery stopped after ${recovery.attempt} attempt${recovery.attempt === 1 ? "" : "s"}. Check the console above, try a different Brick, or contact support.`
  }

  const action =
    recovery.phase === "restarting"
      ? "Restarting now"
      : "Automatic restart scheduled"
  const cause =
    recovery.reason === "out_of_memory"
      ? "Server ran out of memory."
      : recovery.reason === "clean_exit"
        ? "Server stopped internally."
        : recovery.reason === "start_failed"
          ? "Relay could not restart the server."
          : `Server exited unexpectedly${recovery.exitCode === null ? "" : ` (code ${recovery.exitCode})`}.`
  return `${cause} ${action} — attempt ${recovery.attempt} of ${recovery.maxAttempts}.`
}
