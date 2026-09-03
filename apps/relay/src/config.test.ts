import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vite-plus/test"

import {
  discoverRelayAdvertisedHost,
  discoverRelayGameHost,
  loadConfig,
} from "./config.js"

describe("loadConfig", () => {
  it("derives the default Brick catalog from the configured repository", () => {
    const defaults = loadConfig({ NODE_ENV: "development" })
    expect(defaults.gitRepository).toBe("https://github.com/kiln-site/kiln")
    expect(defaults.brickCatalogUrl).toBe(
      "https://raw.githubusercontent.com/kiln-site/kiln/main/apps/bricks/catalog.yml"
    )

    const fork = loadConfig({
      KILN_BRICKS_CATALOG_URL: "https://attacker.test/catalog.yml",
      KILN_GIT_REPO: "example/kiln-fork",
      NODE_ENV: "development",
    })
    expect(fork.gitRepository).toBe("https://github.com/example/kiln-fork")
    expect(fork.brickCatalogUrl).toBe(
      "https://raw.githubusercontent.com/example/kiln-fork/main/apps/bricks/catalog.yml"
    )

    expect(
      loadConfig({
        KILN_BRICKS_CATALOG_URL: "file:///opt/kiln/catalog.yml",
        NODE_ENV: "development",
      }).brickCatalogUrl
    ).toBe("file:///opt/kiln/catalog.yml")
  })

  it("defaults the Relay and SFTP ports", () => {
    const config = loadConfig({ NODE_ENV: "development" })

    expect(config.port).toBe(4100)
    expect(config.publicPort).toBe(4100)
    expect(config.sftpPort).toBe(2022)
    expect(config.gamePortRange).toEqual({ end: 39_999, start: 30_000 })
    expect(config.tlsMode).toBe("development")
    expect(config.sftpDevAuthentication).toBe(true)
    expect(config.mclogsApiUrl).toBe("https://api.mclo.gs/1/log")
    expect(config.backupTimeoutMs).toBe(60 * 60_000)
    expect(config.runtimeRecovery).toEqual({
      initialDelayMs: 5_000,
      maxRetries: 2,
      stabilityMs: 300_000,
    })
  })

  it("configures the backup timeout in minutes", () => {
    expect(
      loadConfig({
        KILN_BACKUP_TIMEOUT: "90",
        NODE_ENV: "development",
      }).backupTimeoutMs
    ).toBe(90 * 60_000)
    expect(() =>
      loadConfig({ KILN_BACKUP_TIMEOUT: "0", NODE_ENV: "development" })
    ).toThrow("KILN_BACKUP_TIMEOUT must be a positive integer")
  })

  it("configures bounded server crash recovery", () => {
    const config = loadConfig({
      KILN_RELAY_CRASH_RETRY_DELAY_SECONDS: "10",
      KILN_RELAY_CRASH_RETRY_LIMIT: "4",
      KILN_RELAY_CRASH_STABILITY_SECONDS: "600",
      NODE_ENV: "development",
    })

    expect(config.runtimeRecovery).toEqual({
      initialDelayMs: 10_000,
      maxRetries: 4,
      stabilityMs: 600_000,
    })
    expect(() =>
      loadConfig({
        KILN_RELAY_CRASH_RETRY_LIMIT: "11",
        NODE_ENV: "development",
      })
    ).toThrow("KILN_RELAY_CRASH_RETRY_LIMIT must be an integer from 0 to 10")
  })

  it("keeps the platform recovery key optional but rejects weak keys", () => {
    expect(loadConfig({ NODE_ENV: "development" }).platformBackupKey).toBeNull()
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
    ).toThrow("KILN_PLATFORM_BACKUP_KEY must be at least 32 bytes")
  })

  it("validates the managed game port range", () => {
    expect(
      loadConfig({
        KILN_RELAY_GAME_PORT_RANGE: "42000-42999",
        NODE_ENV: "development",
      }).gamePortRange
    ).toEqual({ end: 42_999, start: 42_000 })
    expect(() =>
      loadConfig({
        KILN_RELAY_GAME_PORT_RANGE: "43000-42000",
        NODE_ENV: "development",
      })
    ).toThrow("must be an ascending port range")
  })

  it("uses an independent advertised port", () => {
    const config = loadConfig({
      KILN_RELAY_HOST: "relay.test",
      KILN_RELAY_PORT: "4100",
      KILN_RELAY_PUBLIC_PORT: "8443",
      NODE_ENV: "development",
    })

    expect(config.port).toBe(4100)
    expect(config.publicPort).toBe(8443)
    expect(config.browserOrigin).toBe("http://relay.test:8443")
  })

  it("uses the Relay host for game traffic unless overridden", () => {
    const fallback = loadConfig({
      KILN_RELAY_HOST: "relay.test",
      NODE_ENV: "development",
    })
    expect(fallback.gameHost).toBe("relay.test")
    expect(fallback.gameHostSource).toBe("relay")

    const configured = loadConfig({
      KILN_RELAY_GAME_HOST: "games.test",
      KILN_RELAY_HOST: "relay.test",
      NODE_ENV: "development",
    })
    expect(configured.gameHost).toBe("games.test")
    expect(configured.gameHostSource).toBe("configured")
  })

  it("only elides the selected scheme's default port", () => {
    const config = loadConfig({
      KILN_RELAY_HOST: "relay.test",
      KILN_RELAY_PUBLIC_PORT: "443",
      NODE_ENV: "development",
    })

    expect(config.browserOrigin).toBe("http://relay.test:443")
  })

  it("uses the standard HTTPS edge for bundled Traefik", () => {
    const config = loadConfig({
      KILN_RELAY_HOST: "relay.example.com",
      KILN_RELAY_PROXY: "traefik",
      NODE_ENV: "development",
    })

    expect(config.proxyMode).toBe("traefik")
    expect(config.publicPort).toBe(443)
    expect(config.browserOrigin).toBe("https://relay.example.com")
    expect(config.directPublicPort).toBe(4100)
    expect(config.directBrowserOrigin).toBe("http://relay.example.com:4100")
    expect(config.traefikImage).toBe("traefik:v3.6.6")
  })

  it("configures bundled Traefik Hearth origins", () => {
    const config = loadConfig({
      KILN_HEARTH_INTERNAL_URL: " http://hearth:3000 ",
      KILN_HEARTH_PUBLIC_URL: " https://hearth.example.com ",
      KILN_RELAY_PROXY: "traefik",
      NODE_ENV: "production",
    })

    expect(config.hearthInternalOrigin).toBe("http://hearth:3000")
    expect(config.hearthPublicOrigin).toBe("https://hearth.example.com")
  })

  it("requires paired, scheme-constrained Hearth origins", () => {
    expect(() =>
      loadConfig({
        KILN_HEARTH_PUBLIC_URL: "https://hearth.example.com",
        NODE_ENV: "production",
      })
    ).toThrow("must be configured together")
    expect(() =>
      loadConfig({
        KILN_HEARTH_INTERNAL_URL: "https://hearth:3000",
        KILN_HEARTH_PUBLIC_URL: "https://hearth.example.com",
        NODE_ENV: "production",
      })
    ).toThrow("KILN_HEARTH_INTERNAL_URL must be a private HTTP origin")
    expect(() =>
      loadConfig({
        KILN_HEARTH_INTERNAL_URL: "http://hearth:3000/admin",
        KILN_HEARTH_PUBLIC_URL: "https://hearth.example.com",
        NODE_ENV: "production",
      })
    ).toThrow("KILN_HEARTH_INTERNAL_URL must be a private HTTP origin")
    expect(() =>
      loadConfig({
        KILN_HEARTH_INTERNAL_URL: "http://hearth:3000",
        KILN_HEARTH_PUBLIC_URL: "http://hearth.example.com",
        NODE_ENV: "production",
      })
    ).toThrow("KILN_HEARTH_PUBLIC_URL must be a HTTPS origin")
  })

  it("uses Coolify's public HTTPS origin and keeps port 4100 private", () => {
    const config = loadConfig({
      KILN_RELAY_PROXY: "coolify",
      SERVICE_URL_KILN_RELAY_4100: "https://relay.example.com:4100",
      NODE_ENV: "production",
    })

    expect(config.proxyMode).toBe("coolify")
    expect(config.advertisedHost).toBe("relay.example.com")
    expect(config.advertisedHostInferred).toBe(false)
    expect(config.port).toBe(4100)
    expect(config.publicPort).toBe(443)
    expect(config.browserOrigin).toBe("https://relay.example.com")
    expect(config.coolifyPublicOrigin).toBe("https://relay.example.com")
  })

  it("prefers an explicit Coolify host over generated service URLs", () => {
    const config = loadConfig({
      COOLIFY_FQDN: "relay.example.com:4100",
      COOLIFY_URL: "https://relay.example.com:4100",
      KILN_RELAY_HOST: "relay.example.com",
      KILN_RELAY_PROXY: "coolify",
      NODE_ENV: "production",
    })

    expect(config.publicPort).toBe(443)
    expect(config.browserOrigin).toBe("https://relay.example.com")
    expect(config.coolifyPublicOrigin).toBe("https://relay.example.com")
  })

  it("preserves an explicit nonstandard public Coolify port", () => {
    const config = loadConfig({
      KILN_RELAY_HOST: "relay.example.com",
      KILN_RELAY_PROXY: "coolify",
      KILN_RELAY_PUBLIC_URL: "https://relay.example.com:8443",
      NODE_ENV: "production",
    })

    expect(config.publicPort).toBe(8443)
    expect(config.browserOrigin).toBe("https://relay.example.com:8443")
    expect(config.coolifyPublicOrigin).toBe("https://relay.example.com:8443")
  })

  it("requires a trusted public origin for Coolify mode", () => {
    expect(() =>
      loadConfig({ KILN_RELAY_PROXY: "coolify", NODE_ENV: "production" })
    ).toThrow("requires KILN_RELAY_HOST or a Coolify-provided public URL")
    expect(() =>
      loadConfig({
        KILN_RELAY_PROXY: "coolify",
        KILN_RELAY_PUBLIC_URL: "http://relay.example.com",
        NODE_ENV: "production",
      })
    ).toThrow("must be an HTTPS origin")
  })

  it("infers a public address only when no host is configured", async () => {
    const inferred = loadConfig({ NODE_ENV: "development" })
    await expect(
      discoverRelayAdvertisedHost(inferred, {}, async () => "203.0.113.8")
    ).resolves.toBe("public_ip")
    expect(inferred.advertisedHost).toBe("203.0.113.8")
    expect(inferred.gameHost).toBe("203.0.113.8")
    expect(inferred.browserOrigin).toBe("http://203.0.113.8:4100")

    const configured = loadConfig({
      KILN_RELAY_HOST: "relay.test",
      NODE_ENV: "development",
    })
    await expect(
      discoverRelayAdvertisedHost(configured, {}, async () => "203.0.113.9")
    ).resolves.toBe("configured")
    expect(configured.advertisedHost).toBe("relay.test")
  })

  it("can explicitly discover a public game address", async () => {
    const config = loadConfig({
      KILN_RELAY_GAME_HOST: " public-ip ",
      KILN_RELAY_HOST: "relay.test",
      NODE_ENV: "development",
    })

    await expect(
      discoverRelayGameHost(config, async () => "203.0.113.11")
    ).resolves.toBe("public_ip")
    expect(config.advertisedHost).toBe("relay.test")
    expect(config.gameHost).toBe("203.0.113.11")
  })

  it("fails when explicit public game address discovery is unavailable", async () => {
    const config = loadConfig({
      KILN_RELAY_GAME_HOST: "public-ip",
      KILN_RELAY_HOST: "relay.test",
      NODE_ENV: "development",
    })

    await expect(
      discoverRelayGameHost(config, async () => {
        throw new Error("offline")
      })
    ).rejects.toThrow(
      "KILN_RELAY_GAME_HOST=public-ip could not discover a public IPv4 address"
    )
  })

  it("accepts a custom SFTP port", () => {
    const config = loadConfig({
      KILN_RELAY_SFTP_PORT: "22022",
      NODE_ENV: "development",
    })

    expect(config.sftpPort).toBe(22022)
  })

  it("normalizes boolean environment values", async () => {
    const config = loadConfig({
      KILN_RELAY_ALLOW_PROVISIONING: " false ",
      KILN_RELAY_DISCOVER_PUBLIC_IP: " false ",
      KILN_RELAY_SFTP_DEV_AUTH: " true ",
      NODE_ENV: "development",
    })
    await expect(
      discoverRelayAdvertisedHost(
        config,
        { KILN_RELAY_DISCOVER_PUBLIC_IP: " false " },
        async () => "203.0.113.10"
      )
    ).resolves.toBe("hostname")
    expect(config.sftpDevAuthentication).toBe(true)
    expect(config.canProvisionInstances).toBe(false)
    expect(loadConfig({ NODE_ENV: "development" }).canProvisionInstances).toBe(
      true
    )
  })

  it("scopes Docker resources and updates to a development installation", () => {
    const config = loadConfig({
      KILN_INSTALLATION_ID: "hearth-feature-a1b2c3",
      KILN_RELAY_RESOURCE_NAMESPACE: "hearth-feature-a1b2c3",
      NODE_ENV: "development",
    })

    expect(config.installationId).toBe("hearth-feature-a1b2c3")
    expect(config.resourceNamespace).toBe("hearth-feature-a1b2c3")
    expect(config.projectName).toBe("hearth-feature-a1b2c3-mc-servers")
  })

  it("rejects unsafe Docker scope identifiers", () => {
    expect(() =>
      loadConfig({
        KILN_RELAY_RESOURCE_NAMESPACE: "Feature Branch",
        NODE_ENV: "development",
      })
    ).toThrow("KILN_RELAY_RESOURCE_NAMESPACE")
  })

  it("rejects invalid ports", () => {
    expect(() =>
      loadConfig({
        KILN_RELAY_SFTP_PORT: "70000",
        NODE_ENV: "development",
      })
    ).toThrow("KILN_RELAY_SFTP_PORT must be a valid TCP port")
  })

  it("rejects unknown proxy modes and unpinned images", () => {
    expect(() =>
      loadConfig({ KILN_RELAY_PROXY: "caddy", NODE_ENV: "development" })
    ).toThrow("KILN_RELAY_PROXY must be none, hearth, traefik, or coolify")
    expect(() =>
      loadConfig({
        KILN_RELAY_TRAEFIK_IMAGE: "example/traefik:latest",
        NODE_ENV: "development",
      })
    ).toThrow("official pinned Traefik")
  })

  it("cannot enable development transport or SFTP auth in production", () => {
    expect(() =>
      loadConfig({
        KILN_RELAY_TLS_MODE: "development",
        NODE_ENV: "production",
      })
    ).toThrow("Development Relay TLS cannot be used in production")

    expect(() =>
      loadConfig({
        KILN_RELAY_SFTP_DEV_AUTH: "true",
        NODE_ENV: "production",
      })
    ).toThrow("Development SFTP authentication cannot run in production")
  })

  it("reads a one-time bootstrap token from a Docker secret", () => {
    const directory = mkdtempSync(join(tmpdir(), "kiln-relay-config-"))
    const tokenFile = join(directory, "bootstrap-token")
    writeFileSync(tokenFile, "a".repeat(32))
    try {
      expect(
        loadConfig({
          KILN_RELAY_BOOTSTRAP_TOKEN_FILE: tokenFile,
          NODE_ENV: "development",
        }).bootstrapToken
      ).toBe("a".repeat(32))
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })
})
