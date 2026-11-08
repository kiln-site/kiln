import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, onTestFinished, vi } from "vite-plus/test"

import { ServerDeploymentLogs } from "./server-deployment-logs.js"

const serverId = "0123456789ab"

async function logs() {
  const directory = await mkdtemp(join(tmpdir(), "kiln-server-deployments-"))
  onTestFinished(() => rm(directory, { force: true, recursive: true }))
  return new ServerDeploymentLogs(directory)
}

describe("server deployment logs", () => {
  it("keeps how a claimed install and a failed reinstall went", async () => {
    const store = await logs()
    const install = randomUUID()
    store.expectInstall(serverId, install)
    await store.install(serverId, async (onPhase) => {
      await onPhase("pulling_image")
      await onPhase("creating_container")
    })
    const reinstall = randomUUID()
    await expect(
      store.run(serverId, reinstall, "Reinstalling", async () => {
        throw new Error("The image could not be pulled")
      })
    ).rejects.toThrow("The image could not be pulled")

    const installed = await store.read(serverId, install)
    expect(installed?.deployment).toMatchObject({
      error: null,
      id: install,
      state: "succeeded",
    })
    expect(installed?.lines.map((line) => line.text)).toContain(
      "Downloading game server image"
    )
    expect((await store.read(serverId, reinstall))?.deployment).toMatchObject({
      error: "The image could not be pulled",
      state: "failed",
    })

    await store.remove(serverId)
    expect(await store.read(serverId, install)).toBeNull()
  })

  it("keeps each game server's 20 latest", async () => {
    const store = await logs()
    const ids = Array.from({ length: 21 }, () => randomUUID())
    vi.useFakeTimers({ toFake: ["Date"] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    for (const [index, id] of ids.entries()) {
      vi.setSystemTime(Date.UTC(2026, 0, 1, 0, index))
      await store.run(serverId, id, "Reinstalling", async () => {})
    }
    expect(await store.read(serverId, ids[0]!)).toBeNull()
    expect(await store.read(serverId, ids[20]!)).not.toBeNull()
  })
})
