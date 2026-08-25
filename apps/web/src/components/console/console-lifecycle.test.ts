import { describe, expect, it } from "vite-plus/test"
import type { RelayInstanceLifecycleEvent } from "@workspace/contracts"

import {
  consoleRecoveryLine,
  consoleSessionAcceptedAheadOfRuntime,
  consoleSessionIsCurrent,
  consoleStateLine,
  initialConsoleStateLines,
  isConsoleRecoveryLine,
  isConsoleStateLine,
  isConsoleStateLineFor,
  mergeConsoleHistory,
  mergeConsoleStateLines,
  reconcileConsoleLifecycleLines,
  retimestampConsoleStateLine,
  shouldAwaitConsoleRecoverySession,
  shouldRecordConsoleStateTransition,
} from "./console-lifecycle"

const startedAt = "2026-07-28T19:57:00.000Z"
const readyAt = "2026-07-28T19:57:15.000Z"

function lifecycle(
  readyTime: string | null = null,
  rest: ReadonlyArray<RelayInstanceLifecycleEvent> = []
): Array<RelayInstanceLifecycleEvent> {
  return [
    { state: "started", time: startedAt },
    ...(readyTime ? [{ state: "ready" as const, time: readyTime }] : []),
    ...rest,
  ]
}

describe("console lifecycle lines", () => {
  it("shows starting and running for a ready server", () => {
    expect(
      initialConsoleStateLines(lifecycle(readyAt), "running").map(
        (line) => line.text
      )
    ).toEqual(["Server is starting", "Server is running"])
  })

  it("places a restored running transition where Relay observed readiness", () => {
    const lines = [
      {
        id: "before-ready",
        level: "info" as const,
        text: "Preparing spawn",
        timestamp: "2026-07-28T19:57:14.000Z",
      },
      {
        id: "after-ready",
        level: "info" as const,
        text: "Player joined",
        timestamp: "2026-07-28T19:57:20.000Z",
      },
    ]

    expect(
      mergeConsoleStateLines(lines, lifecycle(readyAt), "running").map(
        (line) => line.text
      )
    ).toEqual([
      "Server is starting",
      "Preparing spawn",
      "Server is running",
      "Player joined",
    ])
  })

  it("places running directly after the matching readiness log, before later output", () => {
    const doneAt = "2026-08-21T20:40:19.000Z"
    const lines = [
      {
        id: "done",
        level: "info" as const,
        text: 'Done (21.758s)! For help, type "help"',
        timestamp: doneAt,
      },
      {
        id: "backup-started",
        level: "info" as const,
        text: "Server is Backing up...",
        timestamp: "2026-08-22T08:11:13.000Z",
      },
      {
        id: "backup-completed",
        level: "info" as const,
        text: "Backup Completed!",
        timestamp: "2026-08-22T08:11:15.000Z",
      },
    ]

    expect(
      mergeConsoleStateLines(lines, lifecycle(doneAt), "running").map(
        (line) => line.text
      )
    ).toEqual([
      "Server is starting",
      'Done (21.758s)! For help, type "help"',
      "Server is running",
      "Server is Backing up...",
      "Backup Completed!",
    ])
  })

  it("preserves Docker nanosecond ordering within one millisecond", () => {
    const doneAt = "2026-08-24T14:48:22.051488536Z"
    const lines = [
      {
        id: "done",
        level: "info" as const,
        text: 'Done (10.617s)! For help, type "help"',
        timestamp: doneAt,
      },
      {
        id: "first-start-help",
        level: "info" as const,
        text: "This is the first time you're starting this server.",
        timestamp: "2026-08-24T14:48:22.051821247Z",
      },
    ]

    expect(
      mergeConsoleStateLines(lines, lifecycle(doneAt), "running").map(
        (line) => line.text
      )
    ).toEqual([
      "Server is starting",
      'Done (10.617s)! For help, type "help"',
      "Server is running",
      "This is the first time you're starting this server.",
    ])
  })

  it("keeps unknown restored readiness after console history", () => {
    const lines = [
      {
        id: "startup-log",
        level: "info" as const,
        text: "Preparing spawn",
        timestamp: "2026-07-28T19:57:14.000Z",
      },
      {
        id: "latest-log",
        level: "info" as const,
        text: "Player joined",
        timestamp: "2026-07-28T19:57:20.000Z",
      },
    ]

    expect(
      mergeConsoleStateLines(lines, lifecycle(), "running").map(
        (line) => line.text
      )
    ).toEqual([
      "Server is starting",
      "Preparing spawn",
      "Player joined",
      "Server is running",
    ])
  })

  it("keeps restored history around lifecycle transitions", () => {
    const current = mergeConsoleStateLines(
      [
        {
          id: "newest",
          level: "info" as const,
          text: "Player joined",
          timestamp: "2026-07-28T19:57:20.000Z",
        },
      ],
      lifecycle(readyAt),
      "running"
    )
    const history = [
      {
        id: "older",
        level: "info" as const,
        text: "Preparing spawn",
        timestamp: "2026-07-28T19:57:14.000Z",
      },
    ]

    expect(
      mergeConsoleHistory(current, history).map((line) => line.text)
    ).toEqual([
      "Server is starting",
      "Preparing spawn",
      "Server is running",
      "Player joined",
    ])
  })

  it("keeps replacement-session output when its starting snapshot arrives later", () => {
    const replacementStartedAt = "2026-07-28T20:10:00.000Z"
    const lines = [
      consoleStateLine("stopped", null),
      {
        id: "replacement-output",
        level: "info" as const,
        text: "Loading properties",
        timestamp: "2026-07-28T20:10:01.000Z",
      },
    ]

    const acceptedAheadOfRuntime = consoleSessionAcceptedAheadOfRuntime(
      false,
      startedAt,
      replacementStartedAt,
      "starting",
      null
    )

    expect(acceptedAheadOfRuntime).toBe(true)
    expect(
      consoleSessionIsCurrent(
        false,
        acceptedAheadOfRuntime,
        replacementStartedAt,
        null
      )
    ).toBe(true)
    expect(
      consoleSessionIsCurrent(
        false,
        acceptedAheadOfRuntime,
        replacementStartedAt,
        startedAt
      )
    ).toBe(true)
    expect(
      reconcileConsoleLifecycleLines(
        lines,
        [{ state: "started", time: replacementStartedAt }],
        "starting"
      ).map((line) => line.text)
    ).toEqual(["Server is starting", "Loading properties"])
  })

  it("continues awaiting a replacement when the current session is unchanged", () => {
    expect(consoleSessionIsCurrent(true, false, startedAt, startedAt)).toBe(
      false
    )
    expect(
      consoleSessionIsCurrent(
        false,
        false,
        startedAt,
        "2026-07-28T20:10:00.000Z"
      )
    ).toBe(false)
  })

  it("does not re-arm pending recovery after accepting its replacement session", () => {
    const replacementStartedAt = "2026-07-28T20:10:00.000Z"
    const acceptedAheadOfRuntime = consoleSessionAcceptedAheadOfRuntime(
      false,
      startedAt,
      replacementStartedAt,
      "starting",
      null
    )

    expect(
      shouldAwaitConsoleRecoverySession("pending", acceptedAheadOfRuntime)
    ).toBe(false)
    expect(shouldAwaitConsoleRecoverySession("pending", false)).toBe(true)
    expect(
      consoleSessionAcceptedAheadOfRuntime(
        acceptedAheadOfRuntime,
        replacementStartedAt,
        replacementStartedAt,
        "starting",
        null
      )
    ).toBe(true)
    expect(
      consoleSessionAcceptedAheadOfRuntime(
        acceptedAheadOfRuntime,
        replacementStartedAt,
        replacementStartedAt,
        "running",
        replacementStartedAt
      )
    ).toBe(false)
  })

  it("inserts a live running transition at its readiness timestamp", () => {
    const current = [
      {
        id: "before-ready",
        level: "info" as const,
        text: "Preparing spawn",
        timestamp: "2026-07-28T19:57:14.000Z",
      },
      {
        id: "after-ready",
        level: "info" as const,
        text: "Player joined",
        timestamp: "2026-07-28T19:57:20.000Z",
      },
    ]

    expect(
      mergeConsoleHistory(current, [consoleStateLine("running", readyAt)]).map(
        (line) => line.text
      )
    ).toEqual(["Preparing spawn", "Server is running", "Player joined"])
  })

  it("repositions a provisional running transition when readiness arrives", () => {
    const lines = [
      {
        id: "before-ready",
        level: "info" as const,
        text: "Preparing spawn",
        timestamp: "2026-07-28T19:57:14.000Z",
      },
      consoleStateLine("running", null),
      {
        id: "after-ready",
        level: "info" as const,
        text: "Player joined",
        timestamp: "2026-07-28T19:57:20.000Z",
      },
    ]

    const replaced = retimestampConsoleStateLine(lines, "running", readyAt)

    expect(replaced?.map((line) => line.text)).toEqual([
      "Preparing spawn",
      "Server is running",
      "Player joined",
    ])
    expect(
      replaced?.filter((line) => isConsoleStateLineFor(line, "running"))
    ).toHaveLength(1)
    expect(replaced?.[1]?.timestamp).toBe(readyAt)
    expect(
      retimestampConsoleStateLine(replaced ?? [], "running", readyAt)
    ).toBeNull()
  })

  it("does not invent a running transition while the server is stopping", () => {
    expect(
      initialConsoleStateLines(lifecycle(), "stopping").map((line) => line.text)
    ).toEqual(["Server is starting", "Server is stopping"])
  })

  it("restores the complete stopped session in chronological order", () => {
    const stoppingAt = "2026-07-28T20:10:00.000Z"
    const stoppedAt = "2026-07-28T20:10:04.000Z"
    const lines = initialConsoleStateLines(
      lifecycle(readyAt, [
        { state: "stopping", time: stoppingAt },
        { state: "stopped", time: stoppedAt },
      ]),
      "stopped"
    )

    expect(lines.map((line) => [line.text, line.timestamp])).toEqual([
      ["Server is starting", startedAt],
      ["Server is running", readyAt],
      ["Server is stopping", stoppingAt],
      ["Server stopped", stoppedAt],
    ])
  })

  it("keeps a crash marker while automatic recovery awaits a new session", () => {
    const failedAt = "2026-07-28T20:10:04.000Z"
    const lines = initialConsoleStateLines(
      lifecycle(readyAt, [{ state: "failed", time: failedAt }]),
      "starting",
      {
        attempt: 1,
        exitCode: 137,
        maxAttempts: 2,
        nextAttemptAt: "2026-07-28T20:10:09.000Z",
        oomKilled: true,
        phase: "pending",
        reason: "out_of_memory",
        runtimeMs: 780_000,
      }
    )

    expect(lines.slice(0, 3).map((line) => line.text)).toEqual([
      "Server is starting",
      "Server is running",
      "Server failed",
    ])
    expect(lines[2]?.timestamp).toBe(failedAt)
    expect(lines[3]?.text).toContain("ran out of memory")
  })

  it("identifies synthetic lifecycle lines for centered rendering", () => {
    const [line] = initialConsoleStateLines([], "stopped")

    expect(line?.text).toBe("Server stopped")
    expect(line && isConsoleStateLine(line)).toBe(true)
    expect(isConsoleStateLine({ id: "docker:log-line" })).toBe(false)
  })

  it("explains an internal stop while Relay schedules recovery", () => {
    const line = consoleRecoveryLine(
      {
        attempt: 1,
        exitCode: 0,
        maxAttempts: 2,
        nextAttemptAt: new Date(Date.now() + 5_000).toISOString(),
        oomKilled: false,
        phase: "pending",
        reason: "clean_exit",
        runtimeMs: 60_000,
      },
      null
    )

    expect(line.text).toContain("Server stopped internally.")
    expect(line.text).toContain("Automatic restart scheduled")
    expect(line.text).not.toMatch(/Restarting in \d+s/u)
    expect(line.text).toContain("attempt 1 of 2")
    expect(line.level).toBe("warn")
    expect(isConsoleRecoveryLine(line)).toBe(true)
  })

  it("gives an actionable message when automatic recovery is exhausted", () => {
    const lines = initialConsoleStateLines([], "failed", {
      attempt: 2,
      exitCode: 137,
      maxAttempts: 2,
      nextAttemptAt: null,
      oomKilled: true,
      phase: "failed",
      reason: "out_of_memory",
      runtimeMs: 1_000,
    })

    expect(lines[0]?.text).toBe("Server failed")
    expect(lines[1]?.text).toContain("Automatic recovery stopped")
    expect(lines[1]?.text).toContain("try a different Brick")
    expect(lines[1]?.text).toContain("contact support")
    expect(lines[1]?.level).toBe("error")
  })

  it("ignores stale states that move a stopping lifecycle backwards", () => {
    expect(shouldRecordConsoleStateTransition("stopping", "running")).toBe(
      false
    )
    expect(shouldRecordConsoleStateTransition("stopped", "stopping")).toBe(
      false
    )
    expect(shouldRecordConsoleStateTransition("stopped", "running")).toBe(false)
    expect(shouldRecordConsoleStateTransition("failed", "running")).toBe(false)
    expect(shouldRecordConsoleStateTransition("stopping", "stopped")).toBe(true)
    expect(shouldRecordConsoleStateTransition("stopping", "starting")).toBe(
      true
    )
    expect(shouldRecordConsoleStateTransition("stopped", "starting")).toBe(true)
  })
})
