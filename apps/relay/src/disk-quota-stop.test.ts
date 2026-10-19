import { rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { Effect } from "effect"

import { instanceLifecycleLocks } from "./operation-plans.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness } from "./test/relay.js"

const id = "e".repeat(40)

describe("disk quota enforcement", () => {
  it("keeps a server stopped after stopping it for exceeding its quota", async () => {
    const harness = await relayHarness()
    const container = await harness.seedServer({
      id,
      labels: { "kiln.instance.disk-bytes": "1024" },
      running: true,
      startedAt: "2026-10-19T00:00:00.000Z",
    })
    await writeFile(
      join(harness.config.rootDirectory, id, "world.dat"),
      Buffer.alloc(4096)
    )

    // The first sample records the server as running and starts measuring
    // its directory, which stops it once the scan sees it over quota.
    await harness.docker.inspectInstances()
    await vi.waitFor(() => expect(container.state.running).toBe(false), {
      timeout: 5_000,
    })

    // Crash recovery must not treat the quota stop as a crash.
    const [stopped] = await harness.docker.inspectInstances()
    expect(stopped).toMatchObject({
      desiredState: "stopped",
      observedState: "stopped",
      recovery: null,
    })
    expect(container.state.running).toBe(false)
  })

  it("keeps recovering a server whose quota stop Docker refused", async () => {
    const harness = await relayHarness()
    const container = await harness.seedServer({
      id,
      labels: { "kiln.instance.disk-bytes": "1024" },
      running: true,
      startedAt: "2026-10-19T00:00:00.000Z",
    })
    await writeFile(
      join(harness.config.rootDirectory, id, "world.dat"),
      Buffer.alloc(4096)
    )
    fakeDocker.failNext({ command: "stop" }, "cannot stop container")

    await harness.docker.inspectInstances()
    await vi.waitFor(
      async () =>
        expect(
          (await harness.docker.inspectInstances())[0]?.resources?.storage
        ).toBeTruthy(),
      { timeout: 5_000 }
    )
    await fakeDocker.idle()

    // The stop never happened, so the server is still meant to run.
    expect(container.state.running).toBe(true)
    const [running] = await harness.docker.inspectInstances()
    expect(running).toMatchObject({ desiredState: "running" })
  })

  it("measures again before a quota stop that had to wait its turn", async () => {
    const harness = await relayHarness()
    const container = await harness.seedServer({
      id,
      labels: { "kiln.instance.disk-bytes": "1024" },
      running: true,
      startedAt: "2026-10-19T00:00:00.000Z",
    })
    const world = join(harness.config.rootDirectory, id, "world.dat")
    await writeFile(world, Buffer.alloc(4096))
    // Someone's console input is running when the scan finds it over quota.
    let release: () => void = () => undefined
    const busy = Effect.runPromise(
      harness.lanes.run(
        { label: "console", locks: instanceLifecycleLocks(id) },
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              release = resolve
            })
        )
      )
    )
    await harness.docker.inspectInstances()
    await vi.waitFor(() => expect(harness.lanes.pending.waiting).toBe(1), {
      timeout: 5_000,
    })

    // The files are cleaned up before the stop's turn comes.
    await rm(world)
    release()
    await busy
    await vi.waitFor(() => expect(harness.lanes.pending.active).toBe(0))
    await fakeDocker.idle()
    expect(container.state.running).toBe(true)
  })
})
