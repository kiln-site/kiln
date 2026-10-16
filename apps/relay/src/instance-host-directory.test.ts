import { relayInstanceSchema } from "@workspace/contracts"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { fakeDocker } from "./test/docker.js"
import { relayHarness } from "./test/relay.js"

const id = "a".repeat(40)

describe("a server's host folder", () => {
  it("is reported as the folder Docker mounts at /server", async () => {
    const harness = await relayHarness()
    await harness.createServer({ id })
    const mount = fakeDocker
      .container(harness.resources.instanceContainer(id))
      ?.mounts.find((candidate) => candidate.destination === "/server")
    if (!mount) throw new Error("The server has no /server mount")

    const [instance] = await harness.docker.inspectInstances()

    expect(instance?.hostDirectory).toBe(mount.source)
    // The snapshot Hearth parses keeps it.
    expect(relayInstanceSchema.parse(instance).hostDirectory).toBe(mount.source)
  })
})
