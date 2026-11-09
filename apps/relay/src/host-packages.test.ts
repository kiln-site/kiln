import { describe, expect, it } from "vite-plus/test"

import { HostPackages } from "./host-packages.js"

// The host's shell, answering as the script would. The scripts themselves
// need a real package manager; this is what a Relay makes of their answers.
const hostPrinting = (stdout: string, helper: string | null = "helper") =>
  new HostPackages({
    runningContainer: async () => helper,
    runScript: async () => stdout,
  })

describe("HostPackages", () => {
  it("calls a run that died without finishing failed", async () => {
    const found = await hostPrinting(
      "@manager\napt-get\n@reboot\n@status\nrunning 412 1700000000\n@output\nUnpacking curl"
    ).read({ refresh: false })
    expect(found.run.state).toBe("failed")
    expect(found.run.output).toBe("Unpacking curl")
  })

  it("won't start a second run, and says when it can't start one", async () => {
    await expect(hostPrinting("started\n").update()).resolves.toEqual({
      started: true,
    })
    await expect(hostPrinting("running\n").update()).resolves.toEqual({
      started: false,
    })
    await expect(hostPrinting("unsupported\n").update()).rejects.toThrow(
      "package manager"
    )
    await expect(hostPrinting("failed\n").update()).rejects.toThrow(
      "didn't start"
    )
  })
})
