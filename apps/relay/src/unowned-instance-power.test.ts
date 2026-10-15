import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { relayHarness } from "./test/relay.js"

const id = "c".repeat(40)

describe("servers Relay discovers but does not own", () => {
  it("stops, starts, and restarts their container and keeps its restart policy", async () => {
    const harness = await relayHarness()
    // A hand-written Compose service labeled for Kiln.
    const container = await harness.seedServer({
      id,
      labels: {
        "com.docker.compose.project": "mc-servers",
        "com.docker.compose.service": "survival",
        "kiln.relay.owned": "false",
      },
      name: "mc-servers-survival-1",
      restartPolicy: "unless-stopped",
      running: true,
    })
    const instance = await harness.docker.findInstance(id)
    if (!instance) throw new Error("The server was not discovered")
    expect(instance.managedByRelay).toBe(false)

    const stopped = await harness.docker.runAction(instance, "stop")
    expect(stopped.observedState).toBe("stopped")
    expect(container.state.running).toBe(false)

    await harness.docker.runAction(instance, "start")
    expect(container.state.running).toBe(true)
    const startedAt = container.state.startedAt

    await harness.docker.runAction(instance, "restart")
    expect(container.state.running).toBe(true)
    expect(container.state.startedAt).not.toBe(startedAt)
    expect(container.restartPolicy).toBe("unless-stopped")
  })
})
