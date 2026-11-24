import { describe, expect, it, vi } from "vite-plus/test"
import { Effect } from "effect"

vi.mock("./command.js", () => import("./test/docker.js"))

import { loadConfig, type RelayConfig } from "./config.js"
import {
  ensurePlatformBackupKey,
  platformBackupKey,
} from "./platform-backup-key.js"
import { writePlatformState } from "./platform-state.js"
import { newPlatformState, platformInputs } from "./platform.js"
import { relayHarness } from "./test/relay.js"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("Kiln's platform backup key", () => {
  // A Relay of `installationId`, started with this in its environment, on
  // the same data.
  async function relay() {
    const harness = await relayHarness({})
    return async (installationId: string, environmentKey?: string) => {
      const config: RelayConfig = {
        ...harness.config,
        installationId,
        platformBackupKey: environmentKey ?? null,
      }
      await run(ensurePlatformBackupKey(config, harness.state))
      return run(platformBackupKey(config, harness.state))
    }
  }

  it("is generated once, and no variable replaces it", async () => {
    const start = await relay()
    const key = await start("kiln")
    expect(key?.length).toBeGreaterThanOrEqual(32)

    expect(await start("kiln")).toBe(key)
    expect(await start("kiln", "b".repeat(40))).toBe(key)
  })

  it("starts as KILN_PLATFORM_BACKUP_KEY, and outlives it", async () => {
    const start = await relay()
    expect(await start("kiln", "a".repeat(40))).toBe("a".repeat(40))
    expect(await start("kiln")).toBe("a".repeat(40))
  })

  it("is each Kiln's own, and comes back when a Relay does", async () => {
    const start = await relay()
    const first = await start("first-kiln")
    const second = await start("second-kiln")
    expect(second).not.toBe(first)
    expect(await start("first-kiln")).toBe(first)
  })

  it("is the installed Kiln's, even outside platform mode", async () => {
    const { config, state } = await relayHarness({})
    const installed = newPlatformState(
      config,
      platformInputs({ KILN_URL: "https://kiln.example.test" }),
      "ghcr.io/kiln-site/hearth:latest"
    )
    await run(writePlatformState(config.dataDirectory, installed))
    const external = { ...config, installationId: installed.installationId }
    await run(ensurePlatformBackupKey(external, state))
    expect(await run(platformBackupKey(external, state))).toBe(
      installed.secrets.platformBackupKey
    )
  })

  it("takes the recovery code people save it as", () => {
    expect(
      loadConfig({ KILN_PLATFORM_BACKUP_KEY: `kiln-rk-${"c".repeat(40)}` })
        .platformBackupKey
    ).toBe("c".repeat(40))
  })
})
