import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { fakeDocker } from "./test/docker.js"
import { relayHarness } from "./test/relay.js"

const first = "a".repeat(40)
const second = "b".repeat(40)

describe("game server file roots", () => {
  it("resolves each server to its own directory, never another Relay's", async () => {
    const harness = await relayHarness()
    await harness.seedServer({ id: first })
    await harness.seedServer({ id: second })
    // Another Relay's container claiming the same id on a shared daemon.
    fakeDocker.addContainer({
      mounts: [{ destination: "/server", source: "/elsewhere", type: "bind" }],
      name: "foreign-server",
      labels: {
        "kiln.relay.managed": "true",
        "kiln.relay.owner": "another-relay",
        "kiln.server.id": first,
      },
    })

    await expect(harness.docker.findFileRoot(first)).resolves.toEqual({
      directory: first,
      id: first,
    })
    await expect(harness.docker.findFileRoot(second)).resolves.toEqual({
      directory: second,
      id: second,
    })
    // Short ids and names resolve as before.
    await expect(
      harness.docker.findFileRoot(second.slice(0, 8))
    ).resolves.toMatchObject({ directory: second, id: second })
  })

  it("refuses an id two containers share, whatever its case", async () => {
    const harness = await relayHarness()
    await harness.seedServer({ id: first })
    await harness.seedServer({
      id: second,
      labels: { "kiln.server.id": first.toUpperCase() },
      name: "uppercase-duplicate",
    })

    await expect(harness.docker.findFileRoot(first)).rejects.toThrow(
      `Duplicate kiln.server.id ${first}`
    )
  })

  it("follows a replaced container and forgets a removed one", async () => {
    const harness = await relayHarness()
    await harness.seedServer({ id: first })
    await expect(harness.docker.findFileRoot(first)).resolves.toMatchObject({
      directory: first,
    })

    fakeDocker.removeContainer(harness.resources.instanceContainer(first))
    await expect(harness.docker.findFileRoot(first)).resolves.toBeNull()

    await harness.seedServer({
      id: first,
      labels: { "kiln.instance.directory": second },
      mounts: [
        {
          destination: "/server",
          source: `${harness.config.rootDirectory}/${second}`,
          type: "bind",
        },
      ],
    })
    await expect(harness.docker.findFileRoot(first)).resolves.toEqual({
      directory: second,
      id: first,
    })
  })
})
