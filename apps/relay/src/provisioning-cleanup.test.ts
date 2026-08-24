import { access, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import type { BrickCatalog } from "./bricks.js"
import { loadConfig } from "./config.js"
import type { DockerDriver } from "./docker.js"
import { LifecycleDriver } from "./lifecycle.js"

const temporaryDirectories: Array<string> = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  )
})

describe("provisioning cleanup", () => {
  it("deletes prepared data when provisioning failed before container creation", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "kiln-provisioning-"))
    temporaryDirectories.push(dataDirectory)
    const config = loadConfig({
      KILN_RELAY_DATA_DIR: dataDirectory,
      NODE_ENV: "test",
    })
    const instanceId = "e".repeat(40)
    const instanceDirectory = join(config.rootDirectory, instanceId)
    await mkdir(instanceDirectory, { recursive: true })
    const forgetRecoveryState = vi.fn(async () => undefined)
    const lifecycle = new LifecycleDriver(
      config,
      { forgetRecoveryState } as unknown as DockerDriver,
      {} as BrickCatalog
    )

    await lifecycle.deletePreparedInstance(instanceId, true)

    await expect(access(instanceDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    })
    expect(forgetRecoveryState).toHaveBeenCalledWith(instanceId)
  })
})
