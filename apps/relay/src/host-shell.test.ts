import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { HOST_SHELL_IMAGE, HostShell } from "./host-shell.js"
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
    const container = fakeDocker.container(first)!
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
    expect(fakeDocker.container(created)).toBeUndefined()
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

  it("replaces a helper from an earlier revision instead of reusing it", async () => {
    const { config } = await relayHarness()
    const earlier = fakeDocker.addContainer({
      name: `${TEST_NAMESPACE}-kiln-host-shell`,
      image: HOST_SHELL_IMAGE,
      labels: {
        "kiln.relay.infrastructure": "host-shell",
        "kiln.relay.owner": TEST_NAMESPACE,
      },
    })

    const current = await new HostShell(config).container()

    expect(current).not.toBe(earlier.id)
    expect(fakeDocker.container(earlier.id)).toBeUndefined()
    expect(fakeDocker.container(current)!.state.running).toBe(true)
  })
})
