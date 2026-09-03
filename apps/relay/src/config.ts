import { readFileSync } from "node:fs"
import { Resolver } from "node:dns/promises"
import { hostname } from "node:os"
import { Effect, Result } from "effect"

import type {
  BrickReadiness,
  RelayInstancePortAllocation,
  RelayInstancePortProtocol,
  RelayInstanceTailscale,
} from "@workspace/contracts"
import {
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
  game: string
  id: string
  shortId: string
  implementation: string
  javaVersion: string
  limits: {
    diskBytes: number
    memoryBytes: number
  }
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
export type RelayProxyMode = "coolify" | "hearth" | "none" | "traefik"
export type RelayGameHostSource = "configured" | "public_ip" | "relay"

export interface RelayConfig {
  advertisedHost: string
  advertisedHostInferred: boolean
  backupTimeoutMs: number
  brickCatalogUrl: string
  bootstrapToken: string | null
  browserOrigin: string
  canProvisionInstances: boolean
  coolifyPublicOrigin: string | null
  composeFile: string
  connectDomain: string
  connectPort: number
  directBrowserOrigin: string
  directPublicPort: number
  discoveredPublicIp: string | null
  dockerSocket: string
  dataDirectory: string
  gameHost: string
  gamePortRange: {
    end: number
    start: number
  }
  gameHostSource: RelayGameHostSource
  gitRepository: string
  hearthInternalOrigin: string | null
  hearthPublicOrigin: string | null
  host: string
  installationId: string | null
  managedLabel: string
  mclogsApiUrl: string
  serverIdLabel: string
  nodeId: string
  nodeName: string
  port: number
  platformBackupKey: string | null
  publicPort: number
  projectDirectory: string
  projectName: string
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
  traefikAcmeEmail: string | null
  traefikImage: string
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env
): RelayConfig {
  const dataDirectory = environment.KILN_RELAY_DATA_DIR?.trim() || "/data"
  const proxyMode = relayProxyMode(environment)
  const port = parsePort(environment, "KILN_RELAY_PORT", 4100)
  const coolifyPublicOrigin = relayCoolifyPublicOrigin(environment, port)
  const hearthPublicOrigin = optionalHearthOrigin(
    environment.KILN_HEARTH_PUBLIC_URL,
    "KILN_HEARTH_PUBLIC_URL",
    "https:"
  )
  const hearthInternalOrigin = optionalHearthOrigin(
    environment.KILN_HEARTH_INTERNAL_URL,
    "KILN_HEARTH_INTERNAL_URL",
    "http:"
  )
  if (Boolean(hearthPublicOrigin) !== Boolean(hearthInternalOrigin)) {
    throw new Error(
      "KILN_HEARTH_PUBLIC_URL and KILN_HEARTH_INTERNAL_URL must be configured together"
    )
  }
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
  const installationId = optionalDockerIdentifier(
    environment,
    "KILN_INSTALLATION_ID"
  )
  const resourceNamespace = optionalDockerIdentifier(
    environment,
    "KILN_RELAY_RESOURCE_NAMESPACE"
  )
  const directBrowserOrigin = relayBrowserOrigin(
    tlsMode,
    advertisedHost,
    directPublicPort
  )
  const gitRepository = resolveKilnGitRepository(environment.KILN_GIT_REPO)
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
    browserOrigin:
      proxyMode === "traefik"
        ? `https://${formatUrlHost(advertisedHost)}`
        : proxyMode === "coolify"
          ? (coolifyPublicOrigin ?? `https://${formatUrlHost(advertisedHost)}`)
          : directBrowserOrigin,
    canProvisionInstances: booleanEnvironment(
      environment.KILN_RELAY_ALLOW_PROVISIONING,
      true
    ),
    coolifyPublicOrigin,
    composeFile: `${dataDirectory}/instances/compose.yaml`,
    connectDomain: "test",
    connectPort: 25_565,
    directBrowserOrigin,
    directPublicPort,
    discoveredPublicIp: null,
    dockerSocket: "/var/run/docker.sock",
    dataDirectory,
    gameHost,
    gamePortRange: relayGamePortRange(environment),
    gameHostSource,
    gitRepository,
    hearthInternalOrigin,
    hearthPublicOrigin,
    host: environment.KILN_RELAY_BIND_HOST?.trim() || "0.0.0.0",
    installationId,
    managedLabel: "kiln.relay.managed=true",
    mclogsApiUrl:
      environment.MCLOGS_API_URL?.trim() || "https://api.mclo.gs/1/log",
    nodeId: "kiln-relay",
    nodeName: environment.KILN_RELAY_NAME?.trim() || "",
    port,
    platformBackupKey: optionalPlatformBackupKey(environment),
    publicPort,
    projectDirectory: `${dataDirectory}/instances`,
    projectName: resourceNamespace
      ? `${resourceNamespace}-mc-servers`
      : "mc-servers",
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
    sftpPort: parsePort(environment, "KILN_RELAY_SFTP_PORT", 2022),
    tlsCertificatePath: environment.KILN_RELAY_TLS_CERT_FILE?.trim() || null,
    tlsKeyPath: environment.KILN_RELAY_TLS_KEY_FILE?.trim() || null,
    tlsMode,
    traefikAcmeEmail: environment.KILN_RELAY_ACME_EMAIL?.trim() || null,
    traefikImage: traefikImage(environment),
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

function optionalHearthOrigin(
  raw: string | undefined,
  name: "KILN_HEARTH_INTERNAL_URL" | "KILN_HEARTH_PUBLIC_URL",
  protocol: "http:" | "https:"
): string | null {
  const value = raw?.trim()
  if (!value) return null
  const description = protocol === "http:" ? "private HTTP" : "HTTPS"
  const parsed = Result.try(() => new URL(value))
  if (Result.isFailure(parsed)) {
    throw new Error(`${name} must be a valid ${description} origin`, {
      cause: parsed.failure,
    })
  }
  const url = parsed.success
  if (
    url.protocol !== protocol ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${name} must be a ${description} origin without credentials, a path, query, or fragment`
    )
  }
  return url.origin
}

function effectiveUrlPort(url: URL): number {
  if (url.port) return Number(url.port)
  return url.protocol === "https:" ? 443 : 80
}

function traefikImage(environment: NodeJS.ProcessEnv): string {
  const value = environment.KILN_RELAY_TRAEFIK_IMAGE?.trim() || "traefik:v3.6.6"
  if (!/^traefik(?:@sha256:[a-f0-9]{64}|:[A-Za-z0-9._-]+)$/u.test(value)) {
    throw new Error(
      "KILN_RELAY_TRAEFIK_IMAGE must use an official pinned Traefik tag or digest"
    )
  }
  return value
}

export const discoverRelayAdvertisedHostEffect = Effect.fn(
  "RelayConfig.discoverAdvertisedHost"
)(function* (
  config: RelayConfig,
  environment: NodeJS.ProcessEnv = process.env,
  discover: () => Promise<string> = discoverPublicIp
) {
  if (!config.advertisedHostInferred) return "configured"
  if (!booleanEnvironment(environment.KILN_RELAY_DISCOVER_PUBLIC_IP, true)) {
    return "hostname"
  }
  const address = yield* discoverAddress(discover).pipe(
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
  config: RelayConfig,
  environment: NodeJS.ProcessEnv = process.env,
  discover: () => Promise<string> = discoverPublicIp
): Promise<"configured" | "hostname" | "public_ip"> {
  return Effect.runPromise(
    discoverRelayAdvertisedHostEffect(config, environment, discover)
  )
}

export const discoverRelayGameHostEffect = Effect.fn(
  "RelayConfig.discoverGameHost"
)(function* (
  config: RelayConfig,
  discover: () => Promise<string> = discoverPublicIp
) {
  if (config.gameHostSource === "relay") {
    config.gameHost = config.advertisedHost
    return "relay"
  }
  if (config.gameHostSource === "configured") return "configured"

  const address = yield* discoverAddress(discover).pipe(
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
  config: RelayConfig,
  discover: () => Promise<string> = discoverPublicIp
): Promise<RelayGameHostSource> {
  return Effect.runPromise(discoverRelayGameHostEffect(config, discover))
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

function discoverAddress(discover: () => Promise<string>) {
  return Effect.tryPromise({
    try: discover,
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
