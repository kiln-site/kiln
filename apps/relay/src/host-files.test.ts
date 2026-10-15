import { Effect } from "effect"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { DockerEngine } from "./docker-engine.js"
import { mountHostFilesEffect } from "./host-files.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness } from "./test/relay.js"

// Mounting host files recreates the Relay's own container, so a failure must
// leave the Relay as it was.
describe("mounting host files", () => {
  async function relayContainer() {
    const { config } = await relayHarness()
    fakeDocker.addNetwork({ name: "kiln" })
    const relay = fakeDocker.addContainer({
      name: "kiln-relay-1",
      image: "ghcr.io/kiln-site/relay:latest",
      env: { KILN_RELAY_NAME: "Node One" },
      mounts: [
        {
          type: "bind",
          source: "/var/run/docker.sock",
          destination: "/var/run/docker.sock",
        },
        { type: "volume", source: "relay-data", destination: "/data" },
      ],
      networks: ["kiln"],
      running: true,
    })
    return { engine: new DockerEngine(config.dockerSocket), relay }
  }

  function mount(engine: DockerEngine, relay: string) {
    return Effect.runPromise(
      mountHostFilesEffect(engine, {
        relay,
        root: "/host",
        disableLabel: false,
      })
    )
  }

  it("recreates the Relay with the host mounted and everything else kept", async () => {
    const { engine, relay } = await relayContainer()

    await mount(engine, relay.id)

    const replaced = fakeDocker.container("kiln-relay-1")!
    expect(replaced.id).not.toBe(relay.id)
    expect(replaced.state.running).toBe(true)
    expect(replaced.env).toEqual({ KILN_RELAY_NAME: "Node One" })
    expect(replaced.mounts).toEqual(
      expect.arrayContaining([
        ...relay.mounts.map((mount) => expect.objectContaining(mount)),
        expect.objectContaining({
          type: "bind",
          source: "/",
          destination: "/host",
        }),
      ])
    )
    expect([...replaced.networks.keys()]).toEqual(["kiln"])
    expect(fakeDocker.container(relay.id)).toBeUndefined()
  })

  it("mounts without propagation where the host's root isn't shared", async () => {
    const { engine, relay } = await relayContainer()
    fakeDocker.failNext(
      { command: "start" },
      "path / is mounted on / but it is not a shared or slave mount"
    )

    await mount(engine, relay.id)

    const replaced = fakeDocker.container("kiln-relay-1")!
    expect(replaced.state.running).toBe(true)
    expect(replaced.mounts).toContainEqual(
      expect.objectContaining({ source: "/", destination: "/host" })
    )
  })

  it("keeps the Relay's state in a volume Docker named itself", async () => {
    const { config } = await relayHarness()
    fakeDocker.addNetwork({ name: "kiln" })
    const relay = fakeDocker.addContainer({
      name: "kiln-relay-1",
      mounts: [
        {
          type: "volume",
          source: "3f1c9a",
          destination: "/data",
          anonymous: true,
        },
      ],
      networks: ["kiln"],
      running: true,
    })

    await mount(new DockerEngine(config.dockerSocket), relay.id)

    expect(fakeDocker.container("kiln-relay-1")!.mounts).toContainEqual(
      expect.objectContaining({ source: "3f1c9a", destination: "/data" })
    )
  })

  it("mounts a Relay on Docker's default bridge network", async () => {
    const { config } = await relayHarness()
    const relay = fakeDocker.addContainer({
      name: "kiln-relay-1",
      networks: ["bridge"],
      running: true,
    })

    await mount(new DockerEngine(config.dockerSocket), relay.id)

    const replaced = fakeDocker.container("kiln-relay-1")!
    expect(replaced.id).not.toBe(relay.id)
    expect(replaced.state.running).toBe(true)
  })

  it("puts the Relay back when its replacement doesn't start", async () => {
    const { engine, relay } = await relayContainer()
    fakeDocker.failNext({ command: "start" }, "no space left on device")

    await expect(mount(engine, relay.id)).rejects.toThrow(
      "no space left on device"
    )

    const restored = fakeDocker.container("kiln-relay-1")!
    expect(restored.id).toBe(relay.id)
    expect(restored.state.running).toBe(true)
    expect(restored.mounts).toEqual(relay.mounts)
    expect(
      [...fakeDocker.containers.values()].filter(({ name }) =>
        name.startsWith("kiln-relay-1")
      )
    ).toHaveLength(1)
  })
})
