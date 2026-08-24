import { describe, expect, it } from "vite-plus/test"

import {
  dockerLogSinceArguments,
  historicalReadinessLogArguments,
  isIntentionalServerStopCommand,
  matchingReadyLogLine,
  observedSessionReadyAt,
  parseConsoleLine,
  instanceReadinessProbe,
} from "./docker.js"

describe("Docker console parsing", () => {
  it("limits every log target to its current container session", () => {
    expect(dockerLogSinceArguments("2026-07-25T17:59:03.000000000Z")).toEqual([
      "--since",
      "2026-07-25T17:59:03.000000000Z",
    ])
    expect(dockerLogSinceArguments("0001-01-01T00:00:00Z")).toEqual([])
  })

  it("recovers readiness from the startup window instead of a recent log tail", () => {
    expect(
      historicalReadinessLogArguments("2026-07-25T17:59:03.000000000Z")
    ).toEqual([
      "--since",
      "2026-07-25T17:59:03.000000000Z",
      "--until",
      "2026-07-25T18:01:03.000Z",
    ])
  })

  it("retains safe ANSI styling while keeping searchable plain text", () => {
    expect(
      parseConsoleLine(
        "2026-07-25T17:59:03.000000000Z \u001b[92mBukkit Plugins:\u001b[0m \u001b[96mLuckPerms\u001b[0m"
      )
    ).toEqual({
      level: "info",
      segments: [
        { text: "Bukkit Plugins:", color: "#4ade80" },
        { text: " " },
        { text: "LuckPerms", color: "#22d3ee" },
      ],
      text: "Bukkit Plugins: LuckPerms",
      timestamp: "2026-07-25T17:59:03.000000000Z",
    })
  })

  it("parses raw Minecraft section formatting into plain text and segments", () => {
    expect(
      parseConsoleLine("2026-07-25T17:59:03.000000000Z §aGreen §lBold §rPlain")
    ).toEqual({
      level: "info",
      segments: [
        { text: "Green ", color: "#55ff55" },
        { text: "Bold ", color: "#55ff55", bold: true },
        { text: "Plain" },
      ],
      text: "Green Bold Plain",
      timestamp: "2026-07-25T17:59:03.000000000Z",
    })
  })

  it("finds the first literal startup completion log after formatting", () => {
    const lines = [
      parseConsoleLine(
        "2026-07-25T17:59:03.000000000Z \u001b[33mPreparing level world\u001b[0m"
      ),
      parseConsoleLine(
        '2026-07-25T17:59:12.000000000Z \u001b[32mDone (9.0s)! For help, type "help"\u001b[0m'
      ),
    ].filter((line) => line !== null)

    expect(matchingReadyLogLine(lines, [")! For help, type "])?.timestamp).toBe(
      "2026-07-25T17:59:12.000000000Z"
    )
  })

  it("keeps rediscovered readiness unknown without an observed transition", () => {
    const relayRestartedAt = Date.parse("2026-07-25T20:00:00.000Z")

    expect(
      observedSessionReadyAt(undefined, false, relayRestartedAt)
    ).toBeNull()
    expect(
      observedSessionReadyAt(
        "2026-07-25T17:59:12.000000000Z",
        false,
        relayRestartedAt
      )
    ).toBe("2026-07-25T17:59:12.000000000Z")
    expect(observedSessionReadyAt(undefined, true, relayRestartedAt)).toBe(
      "2026-07-25T20:00:00.000Z"
    )
  })

  it.each([
    {
      expected: "historical",
      hasHealthCheck: false,
      hasLogReadiness: true,
      label: "an old session with a configured readiness log",
      running: true,
      startedRecently: false,
      transitionAction: undefined,
    },
    {
      expected: null,
      hasHealthCheck: false,
      hasLogReadiness: false,
      label: "an old port-only session",
      running: true,
      startedRecently: false,
      transitionAction: undefined,
    },
    {
      expected: "live",
      hasHealthCheck: false,
      hasLogReadiness: false,
      label: "a recent port-only session",
      running: true,
      startedRecently: true,
      transitionAction: undefined,
    },
    {
      expected: "live",
      hasHealthCheck: false,
      hasLogReadiness: false,
      label: "an explicitly restarted port-only session",
      running: true,
      startedRecently: false,
      transitionAction: "restart" as const,
    },
    {
      expected: null,
      hasHealthCheck: true,
      hasLogReadiness: true,
      label: "a session whose health check owns readiness",
      running: true,
      startedRecently: true,
      transitionAction: "start" as const,
    },
    {
      expected: null,
      hasHealthCheck: false,
      hasLogReadiness: true,
      label: "a stopped session",
      running: false,
      startedRecently: true,
      transitionAction: "start" as const,
    },
    {
      expected: null,
      hasHealthCheck: false,
      hasLogReadiness: true,
      label: "a stopping session",
      running: true,
      startedRecently: false,
      transitionAction: "stop" as const,
    },
  ])("selects the readiness probe for $label", ({ expected, ...input }) => {
    expect(instanceReadinessProbe(input)).toBe(expected)
  })

  it.each([
    "% Total    % Received % Xferd  Average Speed   Time    Time     Time  Current",
    "0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0",
    "100  177k    0  177k    0     0   170k      0 --:--:--  0:00:01 --:--:--  170k",
  ])("removes curl progress output: %s", (line) => {
    expect(
      parseConsoleLine(`2026-07-25T17:59:03.000000000Z ${line}`)
    ).toBeNull()
  })

  it("recognizes only exact recipe-declared console stop commands", () => {
    const stopCommands = ["stop", "/stop"]
    expect(isIntentionalServerStopCommand(stopCommands, "stop")).toBe(true)
    expect(isIntentionalServerStopCommand(stopCommands, " /stop ")).toBe(true)
    expect(isIntentionalServerStopCommand(stopCommands, "/STOP")).toBe(false)
    expect(isIntentionalServerStopCommand(stopCommands, "stop now")).toBe(false)
    expect(isIntentionalServerStopCommand([], "stop")).toBe(false)
  })
})
