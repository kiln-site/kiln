import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { parseConsoleLine } from "./console-parsing.js"
import { relayHarness, serverRecipe, type RelayHarness } from "./test/relay.js"

describe("Docker console parsing", () => {
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

  it.each([
    "% Total    % Received % Xferd  Average Speed   Time    Time     Time  Current",
    "0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0",
    "100  177k    0  177k    0     0   170k      0 --:--:--  0:00:01 --:--:--  170k",
    "\u001b[2K\u001b[1A> list",
  ])("drops terminal-only output: %j", (line) => {
    expect(
      parseConsoleLine(`2026-07-25T17:59:03.000000000Z ${line}`)
    ).toBeNull()
  })
})

describe("console stop commands", () => {
  const id = "a".repeat(40)

  async function legacyServer(harness: RelayHarness, stopLabel: string) {
    const recipe = serverRecipe({
      console: { stopCommands: ["stop", "/stop"] },
    })
    const container = await harness.seedServer({
      id,
      labels: {
        "kiln.brick.console-stop-commands": stopLabel,
        "kiln.brick.snapshot-sha256": await harness.bricks.saveSnapshot(recipe),
        "kiln.brick.source": await harness.publishRecipe(recipe),
      },
      running: true,
      tty: true,
    })
    await harness.docker.inspectInstances()
    const instance = await harness.docker.findInstance(id)
    if (!instance) throw new Error("Server was not discovered")
    return { container, instance }
  }

  it("treats a recipe stop command as an intentional stop when the label is empty", async () => {
    const harness = await relayHarness()
    const { container, instance } = await legacyServer(harness, "[]")

    await harness.docker.sendCommand(instance, " stop ")

    expect(container.stdin).toBe(" stop \n")
    const [after] = await harness.docker.inspectInstances()
    expect(after?.desiredState).toBe("stopped")
  })

  it("uses a non-empty label instead of the recipe", async () => {
    const harness = await relayHarness()
    const { container, instance } = await legacyServer(harness, '["end"]')

    await harness.docker.sendCommand(instance, "stop")

    expect(container.stdin).toBe("stop\n")
    const [after] = await harness.docker.inspectInstances()
    expect(after?.desiredState).toBe("running")
  })
})

describe("console history", () => {
  const id = "b".repeat(40)
  const startedAt = "2026-07-25T17:00:00.000Z"

  // A server whose current run has written `count` lines of `size` characters.
  async function serverWithOutput(count: number, size: number) {
    const harness = await relayHarness()
    const recipe = serverRecipe()
    await harness.seedServer({
      id,
      labels: {
        "kiln.brick.snapshot-sha256": await harness.bricks.saveSnapshot(recipe),
        "kiln.brick.source": await harness.publishRecipe(recipe),
      },
      logs: Array.from({ length: count }, (_, index) => ({
        text: `line ${index} ${"x".repeat(size)}`,
        time: new Date(Date.parse(startedAt) + 1_000 + index).toISOString(),
      })),
      running: true,
      startedAt,
      tty: true,
    })
    await harness.docker.inspectInstances()
    return harness.docker.consoleSession(id)
  }

  it("reads history larger than one command's output", async () => {
    const session = await serverWithOutput(1_000, 5_000)

    const history = await session.history(5_000)

    expect(history.lines).toHaveLength(1_000)
    expect(history.lines.at(0)?.text).toMatch(/^line 0 /u)
    expect(history.truncated).toBe(false)
  })

  it("stops reading a shared log as soon as it passes the sharing limit", async () => {
    const harness = await relayHarness()
    const recipe = serverRecipe()
    // About 12 MiB, past the 10 MiB sharing limit.
    const container = await harness.seedServer({
      id,
      labels: {
        "kiln.brick.snapshot-sha256": await harness.bricks.saveSnapshot(recipe),
        "kiln.brick.source": await harness.publishRecipe(recipe),
      },
      logs: Array.from({ length: 12_000 }, (_, index) => ({
        text: `line ${index} ${"x".repeat(1_000)}`,
        time: new Date(Date.parse(startedAt) + 1_000 + index).toISOString(),
      })),
      running: true,
      startedAt,
      tty: true,
    })
    await harness.docker.inspectInstances()
    const instance = await harness.docker.findInstance(id)
    if (!instance) throw new Error("Server was not discovered")

    await expect(harness.docker.consoleLog(instance)).rejects.toThrow(
      "exceeded"
    )
    // Relay hung up instead of reading the rest of the log.
    await vi.waitFor(() => expect(container.lastLogRead).toBe("abandoned"))
  })

  describe("when Docker fails partway through reading the logs", () => {
    async function failingServer() {
      const harness = await relayHarness()
      const recipe = serverRecipe()
      const container = await harness.seedServer({
        id,
        labels: {
          "kiln.brick.snapshot-sha256": await harness.bricks.saveSnapshot(recipe),
          "kiln.brick.source": await harness.publishRecipe(recipe),
        },
        logs: [
          {
            text: "Starting server",
            time: new Date(Date.parse(startedAt) + 1_000).toISOString(),
          },
        ],
        running: true,
        startedAt,
        tty: false,
      })
      container.logStreamError = "log file is corrupted"
      await harness.docker.inspectInstances()
      const instance = await harness.docker.findInstance(id)
      if (!instance) throw new Error("Server was not discovered")
      return { harness, instance }
    }

    it("fails the shared log instead of sharing the error as output", async () => {
      const { harness, instance } = await failingServer()

      await expect(harness.docker.consoleLog(instance)).rejects.toThrow(
        "log file is corrupted"
      )
    })

    it("fails the history", async () => {
      const { harness } = await failingServer()
      const session = await harness.docker.consoleSession(id)

      await expect(session.history(5_000)).rejects.toThrow(
        "log file is corrupted"
      )
    })

    it("fails the live stream", async () => {
      const { harness, instance } = await failingServer()
      const controller = new AbortController()
      const read = async () => {
        const lines: Array<string> = []
        for await (const line of harness.docker.streamConsole(
          instance,
          controller.signal
        )) {
          lines.push(line.text)
        }
        return lines
      }

      await expect(read()).rejects.toThrow("log file is corrupted")
      controller.abort()
    })
  })

  it("keeps the newest history within its size limit and says it was cut", async () => {
    const session = await serverWithOutput(2_000, 10_000)

    const history = await session.history(5_000)

    expect(history.lines.length).toBeLessThan(2_000)
    expect(history.lines.at(-1)?.text).toMatch(/^line 1999 /u)
    expect(history.truncated).toBe(true)
  })
})
