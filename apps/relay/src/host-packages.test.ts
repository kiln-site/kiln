import { describe, expect, it } from "vite-plus/test"

import { HostPackages } from "./host-packages.js"

// The host's shell, answering as the script would. The scripts themselves
// need a real package manager; this is what a Relay makes of their answers.
const hostPrinting = (stdout: string, helper: string | null = "helper") =>
  new HostPackages({
    runningContainer: async () => helper,
    runScript: async () => stdout,
  })

const read = (stdout: string, refresh = false) =>
  hostPrinting(stdout).read({ refresh })

describe("HostPackages", () => {
  it("knows a host it can't update", async () => {
    const found = await read("@manager\n\n@reboot\n@status\n\n@output\n")
    expect(found.manager).toBeNull()
    expect(found.run.state).toBe("idle")
  })

  it("names what an update would change, apart from the container engine", async () => {
    const found = await read(
      [
        "@manager",
        "apt-get",
        "@reboot",
        "yes",
        "@status",
        "",
        "@output",
        "",
        "@updates",
        "libssl3",
        "bash",
        "bash",
        "@held",
        "containerd",
        "docker-ce",
      ].join("\n"),
      true
    )
    expect(found).toMatchObject({
      heldBack: ["containerd", "docker-ce"],
      manager: "apt",
      rebootRequired: true,
      updates: ["bash", "libssl3"],
    })
  })

  it("follows a run while its process lives", async () => {
    const found = await read(
      "@manager\napt-get\n@reboot\n@status\nrunning 412 1700000000\nalive\n@output\nSetting up curl"
    )
    expect(found.run).toMatchObject({
      finishedAt: null,
      output: "Setting up curl",
      startedAt: 1_700_000_000_000,
      state: "running",
    })
  })

  it("calls a run that died without finishing failed", async () => {
    const found = await read(
      "@manager\napt-get\n@reboot\n@status\nrunning 412 1700000000\n@output\nUnpacking curl"
    )
    expect(found.run.state).toBe("failed")
    expect(found.run.output).toBe("Unpacking curl")
  })

  it("reports how a finished run went by its exit code", async () => {
    const status = (code: number) =>
      `@manager\ndnf\n@reboot\n@status\nfinished ${code} 1700000000 1700000060\n@output\nDone`
    expect((await read(status(0))).run).toMatchObject({
      finishedAt: 1_700_000_060_000,
      state: "succeeded",
    })
    expect((await read(status(1))).run.state).toBe("failed")
  })

  it("says when an update finished, for the host to be checked again", async () => {
    const finished = (code: number) =>
      `@manager\napt-get\n@reboot\n@status\nfinished ${code} 1700000000 1700000060\n@output\n`
    await expect(hostPrinting(finished(0)).updatedAt()).resolves.toBe(
      1_700_000_060_000
    )
    // One that failed changed nothing worth asking about.
    await expect(hostPrinting(finished(1)).updatedAt()).resolves.toBeNull()
  })

  it("never starts the host's helper just to ask", async () => {
    const host = new HostPackages({
      runningContainer: async () => null,
      runScript: () => {
        throw new Error("Started the helper")
      },
    })
    await expect(host.updatedAt()).resolves.toBeNull()
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
