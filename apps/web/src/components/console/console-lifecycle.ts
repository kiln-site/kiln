import type {
  RelayConsoleLine,
  RelayInstanceLifecycleEvent,
  RelayInstanceLifecycleState,
  RelayInstanceRecovery,
  RelayInstanceStateReason,
  RelayObservedState,
} from "@workspace/contracts"

export const CONSOLE_STARTUP_REASON_DELAY_MS = 60_000

export function consoleRuntimeReasonDelayRemaining(
  reason: RelayInstanceStateReason,
  startedAt: string | null,
  now = Date.now()
): number {
  if (reason.code !== "waiting_for_readiness") return 0
  if (!startedAt) return CONSOLE_STARTUP_REASON_DELAY_MS
  const startedAtMs = Date.parse(startedAt)
  if (!Number.isFinite(startedAtMs)) return CONSOLE_STARTUP_REASON_DELAY_MS
  return Math.max(0, startedAtMs + CONSOLE_STARTUP_REASON_DELAY_MS - now)
}

export function initialConsoleStateLines(
  lifecycle: ReadonlyArray<RelayInstanceLifecycleEvent>,
  state: RelayObservedState | undefined,
  recovery: RelayInstanceRecovery | null = null
): Array<RelayConsoleLine> {
  const recoveryLines = recovery ? [consoleRecoveryLine(recovery, null)] : []
  const lines = lifecycle.map((event) =>
    consoleStateLine(lifecycleObservedState(event.state), event.time)
  )
  if (state && !lines.some((line) => isConsoleStateLineFor(line, state))) {
    lines.push(consoleStateLine(state, null))
  }
  return [...lines, ...recoveryLines].sort(compareConsoleLineOrder)
}

export function mergeConsoleStateLines(
  lines: ReadonlyArray<RelayConsoleLine>,
  lifecycle: ReadonlyArray<RelayInstanceLifecycleEvent>,
  state: RelayObservedState | undefined,
  recovery: RelayInstanceRecovery | null = null
): Array<RelayConsoleLine> {
  return [
    ...initialConsoleStateLines(lifecycle, state, recovery),
    ...lines,
  ].sort(compareConsoleLineOrder)
}

export function reconcileConsoleLifecycleLines(
  lines: ReadonlyArray<RelayConsoleLine>,
  lifecycle: ReadonlyArray<RelayInstanceLifecycleEvent>,
  state: RelayObservedState | undefined,
  recovery: RelayInstanceRecovery | null = null
): Array<RelayConsoleLine> {
  return mergeConsoleStateLines(
    lines.filter(
      (line) => !isConsoleStateLine(line) && !isConsoleRecoveryLine(line)
    ),
    lifecycle,
    state,
    recovery
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

function lifecycleObservedState(
  state: RelayInstanceLifecycleState
): RelayObservedState {
  if (state === "started") return "starting"
  if (state === "ready") return "running"
  return state
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
