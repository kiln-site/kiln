import { describe, expect, it, vi } from "vite-plus/test"
import { Effect } from "effect"

vi.mock("./command.js", () => import("./test/docker.js"))

import { loadConfig, type RelayConfig } from "./config.js"
import {
  ensurePlatformBackupKey,
  loadPlatformBackupKey,
} from "./platform-backup-key.js"
import { writePlatformState } from "./platform-state.js"
import { newPlatformState, platformInputs } from "./platform.js"
import { relayHarness } from "./test/relay.js"

describe("Kiln's platform backup key", () => {
  async function relay(key?: string) {
    const harness = await relayHarness(
      key ? { KILN_PLATFORM_BACKUP_KEY: key } : {}
    )
    const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
    return {
      config: harness.config,
      ensure: (config: RelayConfig = harness.config) =>
        run(ensurePlatformBackupKey(config, harness.state)),
      // The Relay started again, with this in its environment.
      restart: async (environmentKey: string | null) => {
        const config = { ...harness.config, platformBackupKey: environmentKey }
        await run(loadPlatformBackupKey(config, harness.state))
        return config
      },
    }
  }

  it("is generated once, and no variable replaces it", async () => {
    const { config, ensure, restart } = await relay()
    const other = { ...config }
    await Promise.all([ensure(), ensure(other)])
    const key = config.platformBackupKey
    expect(key?.length).toBeGreaterThanOrEqual(32)
    expect(other.platformBackupKey).toBe(key)

    expect((await restart(null)).platformBackupKey).toBe(key)
    const changed = await restart("b".repeat(40))
    await ensure(changed)
    expect(changed.platformBackupKey).toBe(key)
  })

  it("starts as KILN_PLATFORM_BACKUP_KEY, and outlives it", async () => {
    const { ensure, restart } = await relay("a".repeat(40))
    await ensure()
    expect((await restart(null)).platformBackupKey).toBe("a".repeat(40))
  })

  it("is the installed Kiln's, even outside platform mode", async () => {
    const { config, ensure } = await relay()
    const installed = newPlatformState(
      config,
      platformInputs({ KILN_URL: "https://kiln.example.test" }),
      "ghcr.io/kiln-site/hearth:latest"
    )
    await Effect.runPromise(writePlatformState(config.dataDirectory, installed))
    await ensure()
    expect(config.platformBackupKey).toBe(installed.secrets.platformBackupKey)
  })

  it("takes the recovery code people save it as", () => {
    expect(
      loadConfig({ KILN_PLATFORM_BACKUP_KEY: `kiln-rk-${"c".repeat(40)}` })
        .platformBackupKey
    ).toBe("c".repeat(40))
  })
})
