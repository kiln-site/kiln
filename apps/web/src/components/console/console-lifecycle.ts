import type {
  RelayConsoleLine,
  RelayInstanceRecovery,
  RelayObservedState,
} from "@workspace/contracts"

export function initialConsoleStateLines(
  startedAt: string | null,
  state: RelayObservedState | undefined,
  readyAt: string | null = null,
  recovery: RelayInstanceRecovery | null = null
): Array<RelayConsoleLine> {
  const recoveryLines = recovery ? [consoleRecoveryLine(recovery, null)] : []
  if (!startedAt) {
    return state
      ? [consoleStateLine(state, null), ...recoveryLines]
      : recoveryLines
  }

  const lines = [consoleStateLine("starting", startedAt)]
  if (state === "running") {
    lines.push(consoleStateLine("running", readyAt))
  } else if (
    state === "stopping" ||
    state === "stopped" ||
    state === "failed"
  ) {
    lines.push(consoleStateLine(state, null))
  }
  return [...lines, ...recoveryLines]
}

export function mergeConsoleStateLines(
  lines: ReadonlyArray<RelayConsoleLine>,
  startedAt: string | null,
  state: RelayObservedState | undefined,
  readyAt: string | null = null,
  recovery: RelayInstanceRecovery | null = null
): Array<RelayConsoleLine> {
  return [
    ...initialConsoleStateLines(startedAt, state, readyAt, recovery),
    ...lines,
  ].sort(compareConsoleLineOrder)
}

export function reconcileConsoleLifecycleLines(
  lines: ReadonlyArray<RelayConsoleLine>,
  startedAt: string | null,
  state: RelayObservedState | undefined,
  readyAt: string | null = null,
  recovery: RelayInstanceRecovery | null = null
): Array<RelayConsoleLine> {
  return mergeConsoleStateLines(
    lines.filter(
      (line) => !isConsoleStateLine(line) && !isConsoleRecoveryLine(line)
    ),
    startedAt,
    state,
    readyAt,
    recovery
  )
}

export function consoleSessionIsCurrent(
  awaitingNewSession: boolean,
  consoleStartedAt: string | null | undefined,
  runtimeStartedAt: string | null | undefined
): boolean {
  return (
    !awaitingNewSession &&
    runtimeStartedAt !== null &&
    runtimeStartedAt !== undefined &&
    consoleStartedAt === runtimeStartedAt
  )
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
  const leftTimestamp = consoleTimestamp(left.timestamp)
  const rightTimestamp = consoleTimestamp(right.timestamp)
  if (leftTimestamp !== rightTimestamp) return leftTimestamp - rightTimestamp
  return linePosition(left) - linePosition(right)
}

function consoleTimestamp(timestamp: string | null): number {
  if (timestamp === null) return Number.POSITIVE_INFINITY
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
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
