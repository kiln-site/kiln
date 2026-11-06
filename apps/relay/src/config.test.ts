import { describe, expect, it } from "vite-plus/test"

import { loadConfig } from "./config.js"

describe("loadConfig", () => {
  it("reads a shared platform database, named in full", () => {
    const container = { KILN_RELAY_PLATFORM_DATABASE_CONTAINER: "kiln-dev-mysql" }
    const name = { KILN_RELAY_PLATFORM_DATABASE_NAME: "s_aaaaaaaaaaaa" }

    expect(loadConfig({ ...container, ...name }).platformDatabase).toEqual({
      container: "kiln-dev-mysql",
      name: "s_aaaaaaaaaaaa",
    })
    expect(loadConfig({}).platformDatabase).toBeNull()
    expect(() => loadConfig(container)).toThrow("must be set together")
    expect(() => loadConfig(name)).toThrow("must be set together")
    expect(() =>
      loadConfig({ ...container, KILN_RELAY_PLATFORM_DATABASE_NAME: "a`b" })
    ).toThrow("letters, numbers, or underscores")
  })

  it("rejects a weak platform recovery key", () => {
    expect(
      loadConfig({
        KILN_PLATFORM_BACKUP_KEY: "a".repeat(32),
        NODE_ENV: "development",
      }).platformBackupKey
    ).toBe("a".repeat(32))
    expect(() =>
      loadConfig({
        KILN_PLATFORM_BACKUP_KEY: "too-short",
        NODE_ENV: "development",
      })
    ).toThrow("KILN_PLATFORM_BACKUP_KEY")
  })

  it("cannot enable development transport or SFTP auth in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).not.toThrow()
    expect(() =>
      loadConfig({
        KILN_RELAY_TLS_MODE: "development",
        NODE_ENV: "production",
      })
    ).toThrow()

    expect(() =>
      loadConfig({
        KILN_RELAY_SFTP_DEV_AUTH: "true",
        NODE_ENV: "production",
      })
    ).toThrow()
  })
})
