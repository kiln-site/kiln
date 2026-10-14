import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { HostShell, hostTerminalTarget } from "./host-shell.js"
import { ContainerTerminals } from "./container-terminal.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness, TEST_NAMESPACE } from "./test/relay.js"

describe("host access", () => {
  it("reuses a running helper across concurrent requests and Relay restarts", async () => {
    const { config } = await relayHarness()
    const helper = new HostShell(config)
    const [first, second] = await Promise.all([
      helper.container(),
      helper.container(),
    ])
    expect(first).toEqual(second)
    const container = fakeDocker.container(first.id)!
    expect(container.state.running).toBe(true)
    container.state.running = false
    expect(await new HostShell(config).container()).toEqual(first)
    expect(container.state.running).toBe(true)
  })

  it("refuses disabled host access and removes its previous helper", async () => {
    const { config } = await relayHarness()
    const created = await new HostShell(config).container()
    const disabled = new HostShell({ ...config, hostAccess: false })
    await expect(disabled.container()).rejects.toThrow(
      "Host access is turned off"
    )
    await disabled.remove()
    expect(fakeDocker.container(created.id)).toBeUndefined()
  })

  it("does not take over or remove another container with the helper's name", async () => {
    const { config } = await relayHarness()
    const foreign = fakeDocker.addContainer({
      name: `${TEST_NAMESPACE}-kiln-host-shell`,
      labels: { "kiln.relay.owner": TEST_NAMESPACE },
    })
    const helper = new HostShell(config)
    await expect(helper.container()).rejects.toThrow("not owned")
    await helper.remove()
    expect(fakeDocker.container(foreign.id)).toBe(foreign)
    expect(await helper.runningContainer()).toBeNull()
  })

  it("keeps host shell sessions private to the person and paired client", async () => {
    const { config } = await relayHarness()
    const target = hostTerminalTarget(await new HostShell(config).container())
    const terminals = new ContainerTerminals(config)
    try {
      const input = {
        attachmentId: "a".repeat(24),
        cols: 80,
        rows: 24,
        idleTimeoutMs: 60_000,
      }
      const session = await terminals.attach(
        "hearth:alice",
        target,
        input,
        async () => ({ accepted: true })
      )
      expect(() =>
        terminals.write("hearth:mallory", target.key, session.sessionId, "id\n")
      ).toThrow()
      terminals.write("hearth:alice", target.key, session.sessionId, "id\n")
      const again = await terminals.attach(
        "hearth:alice",
        target,
        { ...input, attachmentId: "b".repeat(24) },
        async () => ({ accepted: true })
      )
      expect(again.sessionId).toBe(session.sessionId)
    } finally {
      await terminals.restart("hearth:alice", target.key)
    }
  })
})
