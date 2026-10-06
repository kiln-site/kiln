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
    expect(parseConsoleLine(`2026-07-25T17:59:03.000000000Z ${line}`)).toBeNull()
  })
})

describe("console stop commands", () => {
  const id = "a".repeat(40)

  async function legacyServer(harness: RelayHarness, stopLabel: string) {
    const recipe = serverRecipe({ console: { stopCommands: ["stop", "/stop"] } })
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
