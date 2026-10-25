import { readFileSync } from "node:fs"
import { Resolver } from "node:dns/promises"
import { isIP } from "node:net"
import { hostname } from "node:os"
import { Effect, Result } from "effect"

import type {
  BrickReadiness,
  RelayInstancePortAllocation,
  RelayInstancePortProtocol,
  RelayInstanceTailscale,
  RelayJoinLink,
  ResourceLimits,
} from "@workspace/contracts"
import {
  decodeRelayJoinLink,
  isKilnInstallationId,
  kilnGitRepositoryRawUrl,
  resolveKilnGitRepository,
} from "@workspace/contracts"

export interface RelayInstanceConfig {
  brickFormat?: string
  brickId?: string
  brickConsoleStopCommands?: ReadonlyArray<string>
  brickNetworkMode?: "direct" | "minecraft-backend"
  brickPrimaryPort?: number
  brickPrimaryPortProtocol?: RelayInstancePortProtocol
  brickReadiness?: BrickReadiness
  brickSupportsSrv?: boolean
  brickSource?: string
  brickSnapshotSha256?: string
  connectAddress: string
  directory: string
  // The server's folder on the Relay's host, its /server bind mount's source.
  hostDirectory?: string
  game: string
  id: string
  shortId: string
  implementation: string
  javaVersion: string
  limits: ResourceLimits
  name: string
  ports: Array<RelayInstancePortAllocation>
  publicHost?: string
  publicPort?: number
  service: string
  tailscale: RelayInstanceTailscale
  variables?: Record<string, boolean | number | string>
  version: string
  managedByRelay: boolean
}

export type RelayTlsMode = "development" | "external" | "managed"
/**
 * `node` runs game servers, Apps, and databases for a Hearth. `platform` also
 * installs and runs Kiln itself on this host: Hearth, its database, and its
 * cache. See platform.ts.
 */
export type RelayMode = "node" | "platform"
export type RelayProxyMode = "coolify" | "hearth" | "none" | "traefik"
/**
 * What serves Hearth in platform mode, beside its own published port:
 * bundled Traefik with HTTPS, Coolify's Traefik, or nothing.
 */
export type RelayPlatformProxy = "coolify" | "none" | "traefik"

export interface RelayPlatformEdge {
  /** The host in `KILN_URL`: a domain, or an IP address. */
  readonly host: string
  /** Kiln's network, which Traefik joins to reach Hearth. */
  readonly network: string
  readonly upstream: string
}
export type RelayGameHostSource = "configured" | "public_ip" | "relay"

/**
 * A Hearth that proved the container it runs in, and what it found beside
 * it then: the database and cache its DB_HOST and CACHE_HOST reached, the
 * database it uses (DB_NAME), and a digest of each secret in its
 * BETTER_AUTH_SECRETS. Coolify removes Hearth's container when it stops
 * Hearth and recreates it under a new ID, so these find Kiln's services,
 * and a Hearth that hasn't connected yet, without it.
 */
export interface ProvenHearth {
  readonly cache: ProvenContainer | null
  readonly containerId: string
  readonly database: ProvenContainer | null
  readonly databaseName: string | null
  readonly installationId: string
  readonly secretDigests: ReadonlyArray<string>
}

/**
 * A container by name, and where it keeps its data: each volume
 * (`volume:<name>`) or host folder (`bind:<path>`) and the path it's
 * mounted at. One recreated under the name is only taken for it with the
 * same data in the same places.
 */
export interface ProvenContainer {
  readonly mounts: ReadonlyArray<{
    readonly destination: string
    readonly source: string
  }>
  readonly name: string
}

export interface RelayConfig {
  advertisedHost: string
  advertisedHostInferred: boolean
  backupTimeoutMs: number
  brickCatalogUrl: string
  bootstrapToken: string | null
  browserOrigin: string
  // From KILN_RELAY_JOIN: the join link from Hearth's Add Relay dialog this
  // Relay pairs with Hearth by (effect/join.ts). It holds a secret.
  join: RelayJoinLink | null
  browserLimits: {
    fileReplayEntries: number
    outboxBytes: number
    outboxMessages: number
    pendingFileAuthentications: number
    pendingHandshakes: number
    pendingHandshakesPerIp: number
    sessions: number
    sessionsPerInstance: number
    sessionsPerUser: number
    sessionsPerUserInstance: number
    sublimitsEnforced: boolean
  }
  canProvisionInstances: boolean
  coolifyPublicOrigin: string | null
  connectDomain: string
  connectPort: number
  directBrowserOrigin: string
  directPublicPort: number
  discoveredPublicIp: string | null
  dockerSocket: string
  dataDirectory: string
  // Whether Hearth may open shells on, and browse the files of, the host the
  // Relay runs on. Docker access already amounts to root there; this lets an
  // operator keep it out of the panel.
  hostAccess: boolean
  // Where the host's filesystem is mounted; Files are off when it isn't.
  hostRootDirectory: string
  gameHost: string
  gamePortRange: {
    end: number
    start: number
  }
  gameHostSource: RelayGameHostSource
  gitRepository: string
  healthPort: number
  host: string
  // From KILN_INSTALLATION_ID, or else the ID Hearth gave this Relay, which
  // it saves and loads at startup.
  installationId: string | null
  // Whether KILN_INSTALLATION_ID set it, so Hearth's ID doesn't replace it.
  installationIdConfigured: boolean
  /**
   * The Hearth that last proved the container it runs in, which the Relay
   * saves and loads at startup. While it's for this installation, Kiln's
   * services deployed without Kiln's labels, as Coolify does, are found
   * from it.
   */
  provenHearth: ProvenHearth | null
  managedLabel: string
  mclogsApiUrl: string
  mode: RelayMode
  /**
   * The Relay's own container, from KILN_RELAY_CONTAINER, for when platform
   * mode can't identify it from its mounts (Podman, Docker in Docker).
   */
  selfContainer: string | null
  // The Syft binary the Relay inventories its host and images with, in its
  // own image, where its helpers run it too.
  syftPath: string
  serverIdLabel: string
  nodeId: string
  nodeName: string
  port: number
  platformBackupKey: string | null
  /**
   * Hearth behind bundled Traefik, by the host people open it at; set from
   * the installation record once platform mode starts.
   */
  platformEdge: RelayPlatformEdge | null
  platformProxy: RelayPlatformProxy
  publicPort: number
  proxyMode: RelayProxyMode
  resourceNamespace: string | null
  rootDirectory: string
  runtimeRecovery: {
    initialDelayMs: number
    maxRetries: number
    stabilityMs: number
  }
  sftpDevAuthentication: boolean
  sftpPort: number
  tlsCertificatePath: string | null
  tlsKeyPath: string | null
  tlsMode: RelayTlsMode
  /** An ACME directory other than Let's Encrypt's, such as its staging one. */
  traefikAcmeCaServer: string | null
  traefikAcmeEmail: string | null
  traefikImage: string
}

export function loadConfig(
  configuredEnvironment: NodeJS.ProcessEnv = process.env
): RelayConfig {
  const mode = relayMode(configuredEnvironment)
  const environment =
    mode === "platform"
      ? platformEnvironment(configuredEnvironment)
      : configuredEnvironment
  const dataDirectory = environment.KILN_RELAY_DATA_DIR?.trim() || "/data"
  const proxyMode = relayProxyMode(environment)
  const port = parsePort(environment, "KILN_RELAY_PORT", 4100)
  const sftpPort = parsePort(environment, "KILN_RELAY_SFTP_PORT", 2022)
  // The image's native healthcheck parses this too; accept only plain digits
  // so both always agree on the port.
  if (!/^\d*$/u.test(environment.KILN_RELAY_HEALTH_PORT?.trim() ?? "")) {
    throw new Error("KILN_RELAY_HEALTH_PORT must be a valid TCP port")
  }
  const healthPort = parsePort(environment, "KILN_RELAY_HEALTH_PORT", 4101)
  if (healthPort === port || healthPort === sftpPort) {
    throw new Error(
      "KILN_RELAY_HEALTH_PORT must differ from KILN_RELAY_PORT and KILN_RELAY_SFTP_PORT"
    )
  }
  const coolifyPublicOrigin = relayCoolifyPublicOrigin(environment, port)
  if (
    proxyMode === "coolify" &&
    !coolifyPublicOrigin &&
    !environment.KILN_RELAY_HOST?.trim()
  ) {
    throw new Error(
      "Coolify proxy mode requires KILN_RELAY_HOST or a Coolify-provided public URL"
    )
  }
  const advertisedHost =
    environment.KILN_RELAY_HOST?.trim() ||
    (coolifyPublicOrigin ? new URL(coolifyPublicOrigin).hostname : null) ||
    hostname() ||
    "localhost"
  const configuredGameHost = environment.KILN_RELAY_GAME_HOST?.trim()
  const gameHostSource: RelayGameHostSource = !configuredGameHost
    ? "relay"
    : configuredGameHost.toLowerCase() === "public-ip"
      ? "public_ip"
      : "configured"
  const gameHost =
    configuredGameHost && configuredGameHost.toLowerCase() !== "public-ip"
      ? configuredGameHost
      : advertisedHost
  const directPublicPort = parsePort(
    environment,
    "KILN_RELAY_PUBLIC_PORT",
    port
  )
  const publicPort =
    proxyMode === "traefik" || proxyMode === "coolify"
      ? coolifyPublicOrigin
        ? effectiveUrlPort(new URL(coolifyPublicOrigin))
        : 443
      : directPublicPort
  const tlsMode = relayTlsMode(environment)
  const installationId = optionalInstallationId(environment)
  const resourceNamespace = optionalDockerIdentifier(
    environment,
    "KILN_RELAY_RESOURCE_NAMESPACE"
  )
  const directBrowserOrigin = relayBrowserOrigin(
    tlsMode,
    advertisedHost,
    directPublicPort
  )
  const gitRepository = resolveKilnGitRepository(
    environment.KILN_GIT_REPO || environment.KILN_DEFAULT_GIT_REPO
  )
  // Hearth owns active catalogs. Preserve only the old local file URL so
  // already-provisioned file-backed instances can be read during upgrades.
  const legacyFileCatalogUrl = Result.getOrNull(
    Result.try(() => new URL(environment.KILN_BRICKS_CATALOG_URL?.trim() ?? ""))
  )
  return {
    advertisedHost,
    advertisedHostInferred:
      !environment.KILN_RELAY_HOST?.trim() && !coolifyPublicOrigin,
    backupTimeoutMs:
      positiveIntegerEnvironment(environment, "KILN_BACKUP_TIMEOUT", 60) *
      60_000,
    brickCatalogUrl:
      legacyFileCatalogUrl?.protocol === "file:"
        ? legacyFileCatalogUrl.href
        : kilnGitRepositoryRawUrl(gitRepository, "apps/bricks/catalog.yml"),
    bootstrapToken: bootstrapToken(environment),
    join: joinLink(environment),
    browserOrigin:
      proxyMode === "traefik"
        ? `https://${formatUrlHost(advertisedHost)}`
        : proxyMode === "coolify"
          ? (coolifyPublicOrigin ?? `https://${formatUrlHost(advertisedHost)}`)
          : directBrowserOrigin,
    browserLimits: relayBrowserLimits(environment),
    canProvisionInstances: booleanEnvironment(
      environment.KILN_RELAY_ALLOW_PROVISIONING,
      true
    ),
    coolifyPublicOrigin,
    connectDomain: "test",
    connectPort: 25_565,
    directBrowserOrigin,
    directPublicPort,
    discoveredPublicIp: null,
    dockerSocket: "/var/run/docker.sock",
    dataDirectory,
    hostAccess: booleanEnvironment(environment.KILN_RELAY_HOST_ACCESS, true),
    hostRootDirectory: environment.KILN_RELAY_HOST_ROOT?.trim() || "/host",
    gameHost,
    gamePortRange: relayGamePortRange(environment),
    gameHostSource,
    gitRepository,
    healthPort,
    host: environment.KILN_RELAY_BIND_HOST?.trim() || "0.0.0.0",
    installationId,
    installationIdConfigured: installationId !== null,
    provenHearth: null,
    managedLabel: "kiln.relay.managed=true",
    mclogsApiUrl:
      environment.MCLOGS_API_URL?.trim() || "https://api.mclo.gs/1/log",
    mode,
    selfContainer: environment.KILN_RELAY_CONTAINER?.trim() || null,
    syftPath: environment.KILN_RELAY_SYFT_PATH?.trim() || "/usr/local/bin/syft",
    nodeId: "kiln-relay",
    nodeName: environment.KILN_RELAY_NAME?.trim() || "",
    port,
    platformBackupKey: optionalPlatformBackupKey(environment),
    platformEdge: null,
    platformProxy: mode === "platform" ? platformProxy(environment) : "none",
    publicPort,
    proxyMode,
    resourceNamespace,
    rootDirectory: `${dataDirectory}/instances`,
    runtimeRecovery: {
      initialDelayMs:
        integerEnvironment(
          environment,
          "KILN_RELAY_CRASH_RETRY_DELAY_SECONDS",
          5,
          0,
          300
        ) * 1_000,
      maxRetries: integerEnvironment(
        environment,
        "KILN_RELAY_CRASH_RETRY_LIMIT",
        2,
        0,
        10
      ),
      stabilityMs:
        integerEnvironment(
          environment,
          "KILN_RELAY_CRASH_STABILITY_SECONDS",
          300,
          15,
          3_600
        ) * 1_000,
    },
    serverIdLabel: "kiln.server.id",
    sftpDevAuthentication: sftpDevAuthentication(environment),
    sftpPort,
    tlsCertificatePath: environment.KILN_RELAY_TLS_CERT_FILE?.trim() || null,
    tlsKeyPath: environment.KILN_RELAY_TLS_KEY_FILE?.trim() || null,
    tlsMode,
    traefikAcmeCaServer: acmeCaServer(environment),
    traefikAcmeEmail: environment.KILN_RELAY_ACME_EMAIL?.trim() || null,
    traefikImage: traefikImage(environment),
  }
}

function relayMode(environment: NodeJS.ProcessEnv): RelayMode {
  const value = environment.KILN_RELAY_MODE?.trim() || "node"
  if (value === "node" || value === "platform") return value
  throw new Error("KILN_RELAY_MODE must be node or platform")
}

/**
 * A Relay that hosts Kiln is reached by Hearth on Kiln's own Docker network,
 * under this name, which its certificate is issued for. Browsers reach it
 * through Hearth, so it needs no public address of its own.
 */
export const PLATFORM_RELAY_HOST = "kiln-relay"

function platformEnvironment(
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const host = environment.KILN_RELAY_HOST?.trim() || PLATFORM_RELAY_HOST
  if (isIP(host)) {
    throw new Error(
      "With KILN_RELAY_MODE=platform, KILN_RELAY_HOST must be a hostname: Hearth reaches the Relay by that name on Kiln's network"
    )
  }
  return {
    ...environment,
    KILN_RELAY_HOST: host,
    KILN_RELAY_PROXY: environment.KILN_RELAY_PROXY?.trim() || "hearth",
  }
}

function relayBrowserLimits(environment: NodeJS.ProcessEnv) {
  const sessions = integerEnvironment(
    environment,
    "KILN_RELAY_BROWSER_SESSIONS_MAX",
    512,
    1,
    100_000
  )
  const sessionsPerInstance = integerEnvironment(
    environment,
    "KILN_RELAY_BROWSER_SESSIONS_PER_INSTANCE_MAX",
    256,
    1,
    sessions
  )
  const sessionsPerUser = integerEnvironment(
    environment,
    "KILN_RELAY_BROWSER_SESSIONS_PER_USER_MAX",
    64,
    1,
    sessions
  )
  const sessionsPerUserInstance = integerEnvironment(
    environment,
    "KILN_RELAY_BROWSER_SESSIONS_PER_USER_INSTANCE_MAX",
    16,
    1,
    Math.min(sessionsPerInstance, sessionsPerUser)
  )
  const pendingHandshakes = integerEnvironment(
    environment,
    "KILN_RELAY_BROWSER_PENDING_HANDSHAKES_MAX",
    64,
    1,
    10_000
  )
  return {
    fileReplayEntries: integerEnvironment(
      environment,
      "KILN_RELAY_BROWSER_FILE_REPLAYS_MAX",
      65_536,
      1,
      1_000_000
    ),
    outboxBytes: integerEnvironment(
      environment,
      "KILN_RELAY_BROWSER_OUTBOX_BYTES_MAX",
      2 * 1024 * 1024,
      64 * 1024,
      64 * 1024 * 1024
    ),
    outboxMessages: integerEnvironment(
      environment,
      "KILN_RELAY_BROWSER_OUTBOX_MESSAGES_MAX",
      256,
      8,
      16_384
    ),
    pendingFileAuthentications: integerEnvironment(
      environment,
      "KILN_RELAY_BROWSER_PENDING_FILE_AUTH_MAX",
      16,
      1,
      1_024
    ),
    pendingHandshakes,
    pendingHandshakesPerIp: integerEnvironment(
      environment,
      "KILN_RELAY_BROWSER_PENDING_HANDSHAKES_PER_IP_MAX",
      16,
      1,
      pendingHandshakes
    ),
    sessions,
    sessionsPerInstance,
    sessionsPerUser,
    sessionsPerUserInstance,
    sublimitsEnforced: booleanEnvironment(
      environment.KILN_RELAY_BROWSER_SUBLIMITS_ENFORCE,
      true
    ),
  }
}

function optionalPlatformBackupKey(
  environment: NodeJS.ProcessEnv
): string | null {
  const key = environment.KILN_PLATFORM_BACKUP_KEY?.trim()
  if (!key) return null
  if (Buffer.byteLength(key, "utf8") < 32) {
    throw new Error("KILN_PLATFORM_BACKUP_KEY must be at least 32 bytes")
  }
  return key
}

function optionalInstallationId(environment: NodeJS.ProcessEnv): string | null {
  const value = environment.KILN_INSTALLATION_ID?.trim()
  if (!value) return null
  if (!isKilnInstallationId(value)) {
    throw new Error(
      "KILN_INSTALLATION_ID must use 1-120 letters, numbers, dots, underscores, or hyphens"
    )
  }
  return value
}

function optionalDockerIdentifier(
  environment: NodeJS.ProcessEnv,
  name: string
): string | null {
  const value = environment[name]?.trim()
  if (!value) return null
  if (!/^[a-z0-9][a-z0-9_.-]{0,47}$/u.test(value)) {
    throw new Error(
      `${name} must be at most 48 lowercase letters, numbers, dots, underscores, or hyphens`
    )
  }
  return value
}

function relayProxyMode(environment: NodeJS.ProcessEnv): RelayProxyMode {
  const value = environment.KILN_RELAY_PROXY?.trim() || "none"
  if (
    value === "none" ||
    value === "hearth" ||
    value === "traefik" ||
    value === "coolify"
  ) {
    return value
  }
  throw new Error("KILN_RELAY_PROXY must be none, hearth, traefik, or coolify")
}

function platformProxy(environment: NodeJS.ProcessEnv): RelayPlatformProxy {
  const value = environment.KILN_PLATFORM_PROXY?.trim() || "none"
  if (value === "none" || value === "traefik" || value === "coolify") {
    return value
  }
  throw new Error("KILN_PLATFORM_PROXY must be none, traefik, or coolify")
}

function acmeCaServer(environment: NodeJS.ProcessEnv): string | null {
  const value = environment.KILN_RELAY_ACME_CA_SERVER?.trim()
  if (!value) return null
  const url = Result.getOrNull(Result.try(() => new URL(value)))
  if (url?.protocol !== "https:") {
    throw new Error("KILN_RELAY_ACME_CA_SERVER must be an https URL")
  }
  return url.href
}

function relayCoolifyPublicOrigin(
  environment: NodeJS.ProcessEnv,
  relayPort: number
): string | null {
  const configuredUrl = environment.KILN_RELAY_PUBLIC_URL?.trim()
  if (configuredUrl) return parseCoolifyPublicOrigin(configuredUrl)

  const configuredHost = environment.KILN_RELAY_HOST?.trim()
  if (configuredHost) {
    return parseCoolifyPublicOrigin(`https://${formatUrlHost(configuredHost)}`)
  }

  const generatedServiceUrls = Object.entries(environment)
    .filter(([name]) =>
      new RegExp(`^SERVICE_(?:URL|FQDN)_.+_${relayPort}$`, "u").test(name)
    )
    .map(([, value]) => value)
  const raw = [
    environment[`SERVICE_URL_KILN_RELAY_${relayPort}`],
    environment[`SERVICE_FQDN_KILN_RELAY_${relayPort}`],
    ...generatedServiceUrls,
    environment.COOLIFY_URL,
    environment.COOLIFY_FQDN,
  ]
    .flatMap((value) => value?.split(",") ?? [])
    .map((value) => value.trim())
    .find(Boolean)
  if (!raw) return null
  const url = new URL(parseCoolifyPublicOrigin(raw))
  // In a Coolify domain, the suffix selects the private container port; the
  // public proxy still serves HTTPS on 443.
  if (url.port === String(relayPort)) url.port = ""
  return url.origin
}

function parseCoolifyPublicOrigin(raw: string): string {
  const withScheme = raw.includes("://") ? raw : `https://${raw}`
  const url = Result.try(() => new URL(withScheme)).pipe(
    Result.getOrThrowWith(
      (cause) => new Error("The Coolify Relay public URL is invalid", { cause })
    )
  )
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "The Coolify Relay public URL must be an HTTPS origin without credentials, a path, query, or fragment"
    )
  }
  return url.origin
}

function effectiveUrlPort(url: URL): number {
  if (url.port) return Number(url.port)
  return url.protocol === "https:" ? 443 : 80
}

function traefikImage(environment: NodeJS.ProcessEnv): string {
  const value =
    environment.KILN_RELAY_TRAEFIK_IMAGE?.trim() || "traefik:v3.7.13"
  if (!/^traefik(?:@sha256:[a-f0-9]{64}|:[A-Za-z0-9._-]+)$/u.test(value)) {
    throw new Error(
      "KILN_RELAY_TRAEFIK_IMAGE must use an official pinned Traefik tag or digest"
    )
  }
  return value
}

export const discoverRelayAdvertisedHostEffect = Effect.fn(
  "RelayConfig.discoverAdvertisedHost"
)(function* (config: RelayConfig) {
  if (!config.advertisedHostInferred) return "configured"
  if (!booleanEnvironment(process.env.KILN_RELAY_DISCOVER_PUBLIC_IP, true)) {
    return "hostname"
  }
  const address = yield* discoverAddress().pipe(
    Effect.catch(() => Effect.succeed(null))
  )
  if (!address) return "hostname"

  config.advertisedHost = address
  config.discoveredPublicIp = address
  if (config.gameHostSource === "relay") config.gameHost = address
  config.directBrowserOrigin = relayBrowserOrigin(
    config.tlsMode,
    address,
    config.directPublicPort
  )
  config.browserOrigin =
    config.proxyMode === "traefik"
      ? `https://${formatUrlHost(address)}`
      : config.proxyMode === "coolify"
        ? (config.coolifyPublicOrigin ?? `https://${formatUrlHost(address)}`)
        : config.directBrowserOrigin
  return "public_ip"
})

export function discoverRelayAdvertisedHost(
  config: RelayConfig
): Promise<"configured" | "hostname" | "public_ip"> {
  return Effect.runPromise(discoverRelayAdvertisedHostEffect(config))
}

export const discoverRelayGameHostEffect = Effect.fn(
  "RelayConfig.discoverGameHost"
)(function* (config: RelayConfig) {
  if (config.gameHostSource === "relay") {
    config.gameHost = config.advertisedHost
    return "relay"
  }
  if (config.gameHostSource === "configured") return "configured"

  const address = yield* discoverAddress().pipe(
    Effect.filterOrFail(
      (value) => value.length > 0,
      () => new Error("Public DNS returned no address")
    ),
    Effect.mapError(
      (cause) =>
        new Error(
          "KILN_RELAY_GAME_HOST=public-ip could not discover a public IPv4 address",
          { cause }
        )
    )
  )
  config.discoveredPublicIp = address
  config.gameHost = address
  return "public_ip"
})

export function discoverRelayGameHost(
  config: RelayConfig
): Promise<RelayGameHostSource> {
  return Effect.runPromise(discoverRelayGameHostEffect(config))
}

function relayBrowserOrigin(
  tlsMode: RelayTlsMode,
  advertisedHost: string,
  publicPort: number
): string {
  const scheme = tlsMode === "development" ? "http" : "https"
  const defaultPort = scheme === "https" ? 443 : 80
  return `${scheme}://${formatUrlHost(advertisedHost)}${publicPort === defaultPort ? "" : `:${publicPort}`}`
}

function discoverAddress() {
  return Effect.tryPromise({
    try: discoverPublicIp,
    catch: (cause) => cause,
  }).pipe(Effect.timeout("2 seconds"))
}

async function discoverPublicIp(): Promise<string> {
  const resolver = new Resolver()
  resolver.setServers(["208.67.222.222", "208.67.220.220"])
  const addresses = await resolver.resolve4("myip.opendns.com")
  const address = addresses[0]
  if (!address) throw new Error("Public DNS returned no address")
  return address
}

function joinLink(environment: NodeJS.ProcessEnv): RelayJoinLink | null {
  const value = environment.KILN_RELAY_JOIN?.trim()
  if (!value) return null
  const link = decodeRelayJoinLink(value)
  if (!link) {
    throw new Error(
      "KILN_RELAY_JOIN must be the join link from Hearth's Add Relay dialog"
    )
  }
  return link
}

function bootstrapToken(environment: NodeJS.ProcessEnv): string | null {
  const inline = environment.KILN_RELAY_BOOTSTRAP_TOKEN?.trim()
  const file = environment.KILN_RELAY_BOOTSTRAP_TOKEN_FILE?.trim()
  if (inline && file) {
    throw new Error(
      "Configure only one of KILN_RELAY_BOOTSTRAP_TOKEN or KILN_RELAY_BOOTSTRAP_TOKEN_FILE"
    )
  }
  const value = file ? readFileSync(file, "utf8").trim() : inline
  return highEntropySecret(
    value,
    file ? "Relay bootstrap token file" : "KILN_RELAY_BOOTSTRAP_TOKEN"
  )
}

function parsePort(
  environment: NodeJS.ProcessEnv,
  name: string,
  defaultPort: number
): number {
  const configured = environment[name]?.trim()
  const port = Number(configured || defaultPort)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a valid TCP port`)
  }
  return port
}

function integerEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const configured = environment[name]?.trim()
  const value = Number(configured || fallback)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function positiveIntegerEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number {
  const configured = environment[name]?.trim()
  const value = Number(configured || fallback)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function relayGamePortRange(environment: NodeJS.ProcessEnv): {
  end: number
  start: number
} {
  const configured =
    environment.KILN_RELAY_GAME_PORT_RANGE?.trim() || "30000-39999"
  const match = configured.match(/^(\d{1,5})-(\d{1,5})$/u)
  const start = Number(match?.[1])
  const end = Number(match?.[2])
  if (
    !match ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end > 65_535 ||
    start > end
  ) {
    throw new Error(
      "KILN_RELAY_GAME_PORT_RANGE must be an ascending port range such as 30000-39999"
    )
  }
  return { end, start }
}

function relayTlsMode(environment: NodeJS.ProcessEnv): RelayTlsMode {
  const fallback =
    environment.NODE_ENV === "production" ? "managed" : "development"
  const value = environment.KILN_RELAY_TLS_MODE?.trim() || fallback
  if (value !== "development" && value !== "external" && value !== "managed") {
    throw new Error(
      "KILN_RELAY_TLS_MODE must be development, external, or managed"
    )
  }
  if (value === "development" && environment.NODE_ENV === "production") {
    throw new Error("Development Relay TLS cannot be used in production")
  }
  if (
    value === "external" &&
    (!environment.KILN_RELAY_TLS_CERT_FILE?.trim() ||
      !environment.KILN_RELAY_TLS_KEY_FILE?.trim())
  ) {
    throw new Error(
      "External Relay TLS requires KILN_RELAY_TLS_CERT_FILE and KILN_RELAY_TLS_KEY_FILE"
    )
  }
  return value
}

function sftpDevAuthentication(environment: NodeJS.ProcessEnv): boolean {
  const enabled = booleanEnvironment(
    environment.KILN_RELAY_SFTP_DEV_AUTH,
    environment.NODE_ENV !== "production"
  )
  if (enabled && environment.NODE_ENV === "production") {
    throw new Error("Development SFTP authentication cannot run in production")
  }
  return enabled
}

function booleanEnvironment(value: string | undefined, fallback: boolean) {
  const normalized = value?.trim()
  if (!normalized) return fallback
  if (normalized === "true") return true
  if (normalized === "false") return false
  throw new Error(`Expected true or false, received ${value}`)
}

function highEntropySecret(
  value: string | undefined,
  name: string
): string | null {
  const secret = value?.trim() || null
  if (secret && Buffer.byteLength(secret) < 32) {
    throw new Error(`${name} must contain at least 32 bytes`)
  }
  return secret
}

function formatUrlHost(value: string): string {
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value
}

export function relayStateDatabasePath(
  config: Pick<RelayConfig, "dataDirectory">
): string {
  return `${config.dataDirectory}/network/relay.sqlite`
}
