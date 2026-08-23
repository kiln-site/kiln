import { describe, expect, it } from "vite-plus/test"

import {
  consoleRecoveryLine,
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
  shouldRecordConsoleStateTransition,
} from "./console-lifecycle"

const startedAt = "2026-07-28T19:57:00.000Z"
const readyAt = "2026-07-28T19:57:15.000Z"

describe("console lifecycle lines", () => {
  it("shows starting and running for a ready server", () => {
    expect(
      initialConsoleStateLines(startedAt, "running", readyAt).map(
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
      mergeConsoleStateLines(lines, startedAt, "running", readyAt).map(
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
      mergeConsoleStateLines(lines, startedAt, "running", doneAt).map(
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
      mergeConsoleStateLines(lines, startedAt, "running").map(
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
      startedAt,
      "running",
      readyAt
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

    expect(
      consoleSessionIsCurrent(
        false,
        replacementStartedAt,
        replacementStartedAt
      )
    ).toBe(true)
    expect(
      reconcileConsoleLifecycleLines(
        lines,
        replacementStartedAt,
        "starting"
      ).map((line) => line.text)
    ).toEqual(["Server is starting", "Loading properties"])
  })

  it("continues awaiting a replacement when the current session is unchanged", () => {
    expect(consoleSessionIsCurrent(true, startedAt, startedAt)).toBe(false)
    expect(
      consoleSessionIsCurrent(false, startedAt, "2026-07-28T20:10:00.000Z")
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
      initialConsoleStateLines(startedAt, "stopping").map((line) => line.text)
    ).toEqual(["Server is starting", "Server is stopping"])
  })

  it("identifies synthetic lifecycle lines for centered rendering", () => {
    const [line] = initialConsoleStateLines(null, "stopped")

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
    const lines = initialConsoleStateLines(null, "failed", null, {
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
