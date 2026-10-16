import type { RelayConsoleLine } from "@workspace/contracts"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { parseConsoleLine } from "./console-parsing.js"
import { fakeDocker } from "./test/docker.js"
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

  it("numbers lines in a long-followed log as a history read does", async () => {
    const harness = await relayHarness()
    const recipe = serverRecipe()
    const container = await harness.seedServer({
      id,
      labels: {
        "kiln.brick.snapshot-sha256": await harness.bricks.saveSnapshot(recipe),
        "kiln.brick.source": await harness.publishRecipe(recipe),
      },
      running: true,
      startedAt,
      tty: false,
    })
    await harness.docker.inspectInstances()
    const session = await harness.docker.consoleSession(id)
    // Far more lines than a followed log keeps counts for. Some print twice
    // in the same instant, others print text seen before, and a burst of
    // thousands shares one timestamp, repeating a line at either end.
    const at = (offset: number) =>
      new Date(Date.parse(startedAt) + 1_000 + offset).toISOString()
    const burst = at(2_000)
    const written = [
      ...Array.from({ length: 2_000 }, (_, index) => ({
        text: index % 7 === 0 ? "Saving chunks" : `line ${index}`,
        time: at(index),
      })).flatMap((line, index) => (index % 50 === 0 ? [line, line] : [line])),
      { text: "Saving chunks", time: burst },
      ...Array.from({ length: 2_500 }, (_, index) => ({
        text: `burst ${index}`,
        time: burst,
      })),
      { text: "Saving chunks", time: burst },
      ...Array.from({ length: 400 }, (_, index) => ({
        text: `after ${index}`,
        time: at(2_001 + index),
      })),
    ]

    const controller = new AbortController()
    const followed: Array<RelayConsoleLine> = []
    const read = (async () => {
      for await (const line of session.stream(controller.signal)) {
        followed.push(line)
        if (followed.length === written.length) return
      }
    })()
    // Write once the log is followed, as a running server would.
    await vi.waitFor(() => expect(fakeDocker.followerCount()).toBe(1))
    fakeDocker.writeLogs(container.name, written)
    await read
    controller.abort()
    const history = await session.history(5_000)

    expect(history.lines).toHaveLength(written.length)
    expect(followed.map((line) => line.id)).toEqual(
      history.lines.map((line) => line.id)
    )
    expect(new Set(followed.map((line) => line.id)).size).toBe(written.length)
  })

  it("numbers a repeat that Docker logs thousands of lines out of order", async () => {
    const harness = await relayHarness()
    const recipe = serverRecipe()
    const container = await harness.seedServer({
      id,
      labels: {
        "kiln.brick.snapshot-sha256": await harness.bricks.saveSnapshot(recipe),
        "kiln.brick.source": await harness.publishRecipe(recipe),
      },
      running: true,
      startedAt,
      tty: false,
    })
    await harness.docker.inspectInstances()
    const session = await harness.docker.consoleSession(id)
    const at = (offset: number) =>
      new Date(Date.parse(startedAt) + 1_000 + offset).toISOString()
    const repeated = { text: "Saving chunks", time: at(0) }
    const written = [
      repeated,
      ...Array.from({ length: 2_050 }, (_, index) => ({
        text: `line ${index}`,
        time: at(1 + index),
      })),
      repeated,
    ]

    const controller = new AbortController()
    const followed: Array<RelayConsoleLine> = []
    const read = (async () => {
      for await (const line of session.stream(controller.signal)) {
        followed.push(line)
        if (followed.length === written.length) return
      }
    })()
    await vi.waitFor(() => expect(fakeDocker.followerCount()).toBe(1))
    fakeDocker.writeLogs(container.name, written)
    await read
    controller.abort()
    const history = await session.history(5_000)

    const followedIds = followed.map((line) => line.id)
    expect(new Set(followedIds).size).toBe(written.length)
    expect([...followedIds].sort((a, b) => a.localeCompare(b))).toEqual(
      history.lines.map((line) => line.id).sort((a, b) => a.localeCompare(b))
    )
  })

  it("keeps the newest history within its size limit and says it was cut", async () => {
    const session = await serverWithOutput(2_000, 10_000)

    const history = await session.history(5_000)

    expect(history.lines.length).toBeLessThan(2_000)
    expect(history.lines.at(-1)?.text).toMatch(/^line 1999 /u)
    expect(history.truncated).toBe(true)
  })
})

describe("console completion", () => {
  it("probes a running server's console, whatever its container attaches at start", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const harness = await relayHarness()
    const recipe = serverRecipe({
      metadata: {
        author: "Kiln",
        description: "A test Brick recipe.",
        game: "Minecraft",
        id: "paper",
        name: "Paper",
      },
    })
    const container = await harness.seedServer({
      id: "c".repeat(40),
      labels: {
        "kiln.brick.id": "paper",
        "kiln.brick.snapshot-sha256": await harness.bricks.saveSnapshot(recipe),
        "kiln.brick.source": await harness.publishRecipe(recipe),
      },
      running: true,
      tty: true,
    })
    await harness.docker.inspectInstances()
    const instance = await harness.docker.findInstance("c".repeat(40))
    if (!instance) throw new Error("Server was not discovered")

    let settled = false
    const completion = harness.docker
      .completeCommand(instance, "ver", 3)
      .finally(() => {
        settled = true
      })
    while (!settled) {
      await vi.advanceTimersByTimeAsync(100)
      await new Promise((resolve) => setImmediate(resolve))
    }
    vi.useRealTimers()

    expect((await completion).supported).toBe(true)
    expect(container.stdin).toContain("ver\t")
  })
})
