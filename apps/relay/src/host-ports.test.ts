import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { DockerEngine } from "./docker-engine.js"
import { HostPorts } from "./host-ports.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness } from "./test/relay.js"

describe("host ports", () => {
  it("still finds the ports taken when a stopped container can't be read", async () => {
    const harness = await relayHarness()
    const stopped = await harness.seedServer({
      id: "a".repeat(12),
      running: false,
    })
    fakeDocker.failNext(
      { command: "inspect", target: stopped.name },
      "Docker's answer exceeded 4194304 bytes"
    )
    const ports = new HostPorts(new DockerEngine(harness.config.dockerSocket))

    await expect(ports.taken(["tcp"])).resolves.toBeInstanceOf(Set)
  })
})
