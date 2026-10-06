import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import {
  discoverRelayAdvertisedHost,
  discoverRelayGameHost,
  loadConfig,
} from "./config.js"

const publicDns = vi.hoisted(() => ({
  resolve4: async (_hostname: string): Promise<Array<string>> => [],
}))

// Public IP discovery asks OpenDNS; fake that network edge.
vi.mock("node:dns/promises", () => ({
  Resolver: class {
    setServers() {}
    resolve4(hostname: string) {
      return publicDns.resolve4(hostname)
    }
  },
}))

function publicIp(address: string) {
  publicDns.resolve4 = async () => [address]
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("loadConfig", () => {
  it("derives the Brick catalog from the configured repository", () => {
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

  it("validates the browser session limit hierarchy", () => {
    expect(() =>
      loadConfig({
        KILN_RELAY_BROWSER_SESSIONS_MAX: "8",
        KILN_RELAY_BROWSER_SESSIONS_PER_INSTANCE_MAX: "9",
        NODE_ENV: "development",
      })
    ).toThrow("KILN_RELAY_BROWSER_SESSIONS_PER_INSTANCE_MAX")
    expect(() =>
      loadConfig({
        KILN_RELAY_BROWSER_PENDING_HANDSHAKES_MAX: "4",
        KILN_RELAY_BROWSER_PENDING_HANDSHAKES_PER_IP_MAX: "5",
        NODE_ENV: "development",
      })
    ).toThrow("KILN_RELAY_BROWSER_PENDING_HANDSHAKES_PER_IP_MAX")
    const proxy = loadConfig({
      KILN_RELAY_BROWSER_SUBLIMITS_ENFORCE: "true",
      KILN_RELAY_PROXY: "traefik",
      NODE_ENV: "development",
    })
    // Identity sublimits can be enforced behind a proxy, but Relay does not
    // trust forwarded addresses for the pending per-IP sublimit.
    expect(proxy.browserLimits.sublimitsEnforced).toBe(true)
    expect(proxy.proxyMode).toBe("traefik")
  })

  it("rejects invalid browser limit environment values", () => {
    const integerLimits = [
      "KILN_RELAY_BROWSER_FILE_REPLAYS_MAX",
      "KILN_RELAY_BROWSER_OUTBOX_BYTES_MAX",
      "KILN_RELAY_BROWSER_OUTBOX_MESSAGES_MAX",
      "KILN_RELAY_BROWSER_PENDING_FILE_AUTH_MAX",
      "KILN_RELAY_BROWSER_PENDING_HANDSHAKES_MAX",
      "KILN_RELAY_BROWSER_PENDING_HANDSHAKES_PER_IP_MAX",
      "KILN_RELAY_BROWSER_SESSIONS_MAX",
      "KILN_RELAY_BROWSER_SESSIONS_PER_INSTANCE_MAX",
      "KILN_RELAY_BROWSER_SESSIONS_PER_USER_MAX",
      "KILN_RELAY_BROWSER_SESSIONS_PER_USER_INSTANCE_MAX",
    ] as const
    for (const name of integerLimits) {
      expect(() =>
        loadConfig({ [name]: "not-an-integer", NODE_ENV: "development" })
      ).toThrow(name)
    }
    expect(() =>
      loadConfig({
        KILN_RELAY_BROWSER_SUBLIMITS_ENFORCE: "sometimes",
        NODE_ENV: "development",
      })
    ).toThrow()
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
    ).toThrow("KILN_BACKUP_TIMEOUT")
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
    ).toThrow("KILN_RELAY_CRASH_RETRY_LIMIT")
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
    ).toThrow("KILN_RELAY_GAME_PORT_RANGE")
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
    ).toThrow()
    const publicUrl = (url: string) => () =>
      loadConfig({
        KILN_RELAY_PROXY: "coolify",
        KILN_RELAY_PUBLIC_URL: url,
        NODE_ENV: "production",
      })
    expect(publicUrl("https://relay.example.com")).not.toThrow()
    expect(publicUrl("http://relay.example.com")).toThrow()
  })

  it("infers a public address only when no host is configured", async () => {
    vi.stubEnv("KILN_RELAY_DISCOVER_PUBLIC_IP", "")
    publicIp("203.0.113.8")
    const inferred = loadConfig({ NODE_ENV: "development" })
    await expect(discoverRelayAdvertisedHost(inferred)).resolves.toBe(
      "public_ip"
    )
    expect(inferred.advertisedHost).toBe("203.0.113.8")
    expect(inferred.gameHost).toBe("203.0.113.8")
    expect(inferred.browserOrigin).toBe("http://203.0.113.8:4100")

    const configured = loadConfig({
      KILN_RELAY_HOST: "relay.test",
      NODE_ENV: "development",
    })
    await expect(discoverRelayAdvertisedHost(configured)).resolves.toBe(
      "configured"
    )
    expect(configured.advertisedHost).toBe("relay.test")
  })

  it("can explicitly discover a public game address", async () => {
    const config = loadConfig({
      KILN_RELAY_GAME_HOST: " public-ip ",
      KILN_RELAY_HOST: "relay.test",
      NODE_ENV: "development",
    })

    publicIp("203.0.113.11")

    await expect(discoverRelayGameHost(config)).resolves.toBe("public_ip")
    expect(config.advertisedHost).toBe("relay.test")
    expect(config.gameHost).toBe("203.0.113.11")
  })

  it("fails when explicit public game address discovery is unavailable", async () => {
    const config = loadConfig({
      KILN_RELAY_GAME_HOST: "public-ip",
      KILN_RELAY_HOST: "relay.test",
      NODE_ENV: "development",
    })

    publicDns.resolve4 = async () => {
      throw new Error("offline")
    }

    await expect(discoverRelayGameHost(config)).rejects.toThrow(
      "KILN_RELAY_GAME_HOST"
    )
  })

  it("normalizes boolean environment values", async () => {
    vi.stubEnv("KILN_RELAY_DISCOVER_PUBLIC_IP", " false ")
    publicIp("203.0.113.10")
    const config = loadConfig({
      KILN_RELAY_ALLOW_PROVISIONING: " false ",
      KILN_RELAY_DISCOVER_PUBLIC_IP: " false ",
      KILN_RELAY_SFTP_DEV_AUTH: " true ",
      NODE_ENV: "development",
    })
    await expect(discoverRelayAdvertisedHost(config)).resolves.toBe("hostname")
    expect(config.sftpDevAuthentication).toBe(true)
    expect(config.canProvisionInstances).toBe(false)
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

  it("parses and validates ports", () => {
    expect(
      loadConfig({ KILN_RELAY_SFTP_PORT: "22022", NODE_ENV: "development" })
        .sftpPort
    ).toBe(22022)
    expect(() =>
      loadConfig({
        KILN_RELAY_SFTP_PORT: "70000",
        NODE_ENV: "development",
      })
    ).toThrow("KILN_RELAY_SFTP_PORT")
  })

  it("rejects unknown proxy modes and unpinned images", () => {
    expect(() =>
      loadConfig({ KILN_RELAY_PROXY: "caddy", NODE_ENV: "development" })
    ).toThrow("KILN_RELAY_PROXY")
    expect(() =>
      loadConfig({
        KILN_RELAY_TRAEFIK_IMAGE: "example/traefik:latest",
        NODE_ENV: "development",
      })
    ).toThrow("KILN_RELAY_TRAEFIK_IMAGE")
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
