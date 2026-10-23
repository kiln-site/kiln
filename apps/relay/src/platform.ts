/**
 * Platform mode: a Relay that installs and runs Kiln itself.
 *
 * With `KILN_RELAY_MODE=platform`, the Relay creates Hearth, Hearth's MySQL
 * database, and a Valkey cache on its own Docker host, pairs with that
 * Hearth, and keeps the three running. Everything they need is generated
 * once and saved in the Relay's data volume (`platform-state.ts`), so
 * installing is `docker run` of the Relay with one URL.
 *
 * Each pass (`reconcile`) creates what's missing and starts what stopped. It
 * never deletes data: once the database has existed, a missing database
 * volume blocks the pass until an operator chooses what to do. It leaves
 * alone a container that's mid-update, and any container it didn't create.
 *
 * Without platform mode the Relay still reports Kiln's services when they
 * run beside it, deployed with Compose or Coolify, but only reads them.
 */
import { createHash, randomUUID } from "node:crypto"
import { access, readFile } from "node:fs/promises"
import { hostname } from "node:os"
import { join } from "node:path"

import {
  isKilnInstallationId,
  kilnImageRepository,
  type RelayPlatformActionInput,
  type RelayPlatformService,
  type RelayPlatformServiceRole,
  type RelayPlatformStatus,
} from "@workspace/contracts"
import { Effect, Result } from "effect"

import type { RelayConfig } from "./config.js"
import {
  createContainer,
  type ContainerSpec,
} from "./docker-container-spec.js"
import {
  type DockerContainerInspect,
  type DockerEngine,
  type DockerEngineError,
  isDockerNotFound,
} from "./docker-engine.js"
import type { RelayClientRecord } from "./effect/state.js"
import { relayOwnerLabels } from "./relay-resources.js"
import {
  decodePlatformRecoveryKit,
  PLATFORM_STATE_FORMAT_VERSION,
  PlatformError,
  type PlatformNames,
  type PlatformState,
  platformSecret,
  readPlatformState,
  updatePlatformState,
  withPlatformLock,
  writePlatformState,
} from "./platform-state.js"
import { KILN_INSTALLATION_LABEL } from "./update-container.js"

export { PlatformError, type PlatformState } from "./platform-state.js"

export const PLATFORM_ROLE_LABEL = "io.kiln.platform.role"
// A hash of what the Relay creates a service with, apart from its image,
// which Kiln's updates change. When it differs, the Relay recreates it.
export const PLATFORM_SPEC_LABEL = "io.kiln.platform.spec"
const RESOURCE_LABEL = "io.kiln.resource"
const VERSION_LABEL = "org.opencontainers.image.version"

// The resource labels Compose deployments already use, which platform
// backups find the database by.
const resourceLabels: Record<RelayPlatformServiceRole, string> = {
  cache: "hearth-cache",
  database: "hearth-database",
  hearth: "hearth",
}

const DEFAULT_DATABASE_IMAGE = "mysql:8.4"
const DEFAULT_CACHE_IMAGE = "valkey/valkey:9.1.2-alpine"
const HEARTH_CONTAINER_PORT = 3000
const DATABASE_NAME = "hearth"
const DATABASE_USER = "kiln"
// MySQL initializes its data directory on first start, which takes a while
// on slow disks.
const DATABASE_READY_TIMEOUT_MS = 180_000
const PULL_TIMEOUT_MS = 15 * 60_000

/**
 * Hearth settings a Relay in platform mode passes on from its own
 * environment, so they're set in one place. Everything else Hearth needs the
 * Relay generates.
 */
const HEARTH_PASSTHROUGH_ENVIRONMENT = [
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "BETTER_AUTH_URL",
  "KILN_ENABLE_SIGNUPS",
  "KILN_MARKETING_URL",
  "KILN_SUPER_USER_EMAIL",
  "KILN_SUPER_USER_PASSWORD",
  "MCLOGS_API_URL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_LOGS_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_SDK_DISABLED",
  "OTEL_TRACES_EXPORTER",
  "OTEL_TRACES_SAMPLER_ARG",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  "TZ",
] as const

/** What the operator chose, from the Relay's environment. */
export interface PlatformInputs {
  /** First start only: an existing installation's, when moving it here. */
  readonly authSecrets: string | null
  readonly bindAddress: string | null
  readonly cacheImage: string | null | undefined
  readonly databaseImage: string | null
  readonly environment: Readonly<Record<string, string>>
  readonly hearthImage: string | null
  readonly installationId: string | null
  readonly port: number | null
  readonly url: string | null
}

export function platformInputs(
  environment: NodeJS.ProcessEnv = process.env
): PlatformInputs {
  const url = environment.KILN_URL?.trim() || null
  if (url) platformUrl(url)
  const port = environment.KILN_PLATFORM_HEARTH_PORT?.trim()
  const parsedPort = port ? Number(port) : null
  if (
    parsedPort !== null &&
    (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535)
  ) {
    throw new Error("KILN_PLATFORM_HEARTH_PORT must be a valid TCP port")
  }
  const cacheImage = environment.KILN_PLATFORM_CACHE_IMAGE?.trim()
  const installationId = environment.KILN_INSTALLATION_ID?.trim() || null
  if (installationId && !isKilnInstallationId(installationId)) {
    throw new Error(
      "KILN_INSTALLATION_ID must use 1-120 letters, numbers, dots, underscores, or hyphens"
    )
  }
  return {
    authSecrets: environment.BETTER_AUTH_SECRETS?.trim() || null,
    bindAddress: environment.KILN_PLATFORM_HEARTH_BIND?.trim() || null,
    // `none` runs Hearth without a cache; unset means the default.
    cacheImage:
      cacheImage === "none" ? null : cacheImage ? cacheImage : undefined,
    databaseImage: environment.KILN_PLATFORM_DATABASE_IMAGE?.trim() || null,
    environment: Object.fromEntries(
      HEARTH_PASSTHROUGH_ENVIRONMENT.flatMap((name) => {
        const value = environment[name]
        return value === undefined || value === "" ? [] : [[name, value]]
      })
    ),
    hearthImage: environment.KILN_PLATFORM_HEARTH_IMAGE?.trim() || null,
    installationId,
    port: parsedPort,
    url,
  }
}

function platformUrl(value: string): URL {
  const url = Result.getOrThrowWith(
    Result.try(() => new URL(value)),
    () => new Error("KILN_URL must be an absolute http or https URL")
  )
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "KILN_URL must be an http or https URL without credentials, a query, or a fragment"
    )
  }
  return url
}

/** Names of Kiln's services, within the Relay's resource namespace. */
export function platformNames(
  config: Pick<RelayConfig, "resourceNamespace">
): PlatformNames {
  const name = (base: string) =>
    config.resourceNamespace ? `${config.resourceNamespace}-${base}` : base
  return {
    cache: name("kiln-hearth-cache"),
    database: name("kiln-hearth-mysql"),
    databaseVolume: name("kiln-hearth-mysql"),
    hearth: name("kiln-hearth"),
    network: name("kiln-platform"),
  }
}

/**
 * The Hearth image matching the Relay's own: the same tag from the same
 * distribution, such as `:latest-nightly` beside a nightly Relay. A Relay
 * started from a local or pinned image gets Hearth's `:latest`.
 */
export function defaultHearthImage(
  relayImage: string | null,
  gitRepository: string
): string {
  const relayRepository = kilnImageRepository("relay", gitRepository)
  const hearthRepository = kilnImageRepository("hearth", gitRepository)
  const tag = relayImage?.startsWith(`${relayRepository}:`)
    ? relayImage.slice(relayRepository.length + 1)
    : null
  return tag && /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u.test(tag)
    ? `${hearthRepository}:${tag}`
    : `${hearthRepository}:latest`
}

/** A new installation's record, with every secret generated. */
export function newPlatformState(
  config: Pick<
    RelayConfig,
    "advertisedHost" | "platformBackupKey" | "port" | "resourceNamespace"
  >,
  inputs: PlatformInputs,
  hearthImage: string
): PlatformState {
  if (!inputs.url) {
    throw new Error(
      "Set KILN_URL to the address people will open Hearth at, such as https://kiln.example.com or http://203.0.113.10:3000"
    )
  }
  return {
    cache:
      inputs.cacheImage === null
        ? null
        : { image: inputs.cacheImage ?? DEFAULT_CACHE_IMAGE },
    createdAt: new Date().toISOString(),
    database: {
      image: inputs.databaseImage ?? DEFAULT_DATABASE_IMAGE,
      name: DATABASE_NAME,
      user: DATABASE_USER,
    },
    databaseInitializedAt: null,
    formatVersion: PLATFORM_STATE_FORMAT_VERSION,
    hearth: {
      bindAddress: inputs.bindAddress ?? "0.0.0.0",
      environment: inputs.environment,
      image: inputs.hearthImage ?? hearthImage,
      port: inputs.port ?? HEARTH_CONTAINER_PORT,
      url: platformUrl(inputs.url).origin,
    },
    installationId: inputs.installationId ?? randomUUID(),
    names: platformNames(config),
    ownerInvitationIds: [],
    phase: "installing",
    relay: { host: config.advertisedHost, port: config.port },
    secrets: {
      authSecrets: inputs.authSecrets ?? `1:${platformSecret()}`,
      bootstrapToken: platformSecret(),
      databasePassword: platformSecret(),
      databaseRootPassword: platformSecret(),
      platformBackupKey: config.platformBackupKey ?? platformSecret(),
      setupToken: platformSecret(),
    },
  }
}

/**
 * The record with the settings the running Relay was started with. Images
 * are chosen once, at install: Kiln's updates replace Hearth's, and a
 * database engine is never swapped under its data.
 */
export function withPlatformInputs(
  state: PlatformState,
  inputs: PlatformInputs,
  config: Pick<RelayConfig, "advertisedHost" | "port">
): PlatformState {
  const relay = { host: config.advertisedHost, port: config.port }
  const hearth = {
    ...state.hearth,
    bindAddress: inputs.bindAddress ?? state.hearth.bindAddress,
    environment: inputs.environment,
    port: inputs.port ?? state.hearth.port,
    url: inputs.url ? platformUrl(inputs.url).origin : state.hearth.url,
  }
  return JSON.stringify(hearth) === JSON.stringify(state.hearth) &&
    JSON.stringify(relay) === JSON.stringify(state.relay)
    ? state
    : { ...state, hearth, relay }
}

export function platformSetupUrl(state: PlatformState): string {
  const url = new URL("/", state.hearth.url)
  url.searchParams.set("setup", state.secrets.setupToken)
  return url.href
}

/** A copy of the record to keep offline; see `importPlatformKit`. */
export function platformRecoveryKit(state: PlatformState) {
  return {
    exportedAt: new Date().toISOString(),
    formatVersion: 1 as const,
    kind: "kiln-platform-recovery-kit" as const,
    state,
  }
}

interface ServiceSpec {
  readonly role: RelayPlatformServiceRole
  readonly spec: ContainerSpec
}

function serviceSpecs(
  state: PlatformState,
  config: Pick<RelayConfig, "resourceNamespace">
): ReadonlyArray<ServiceSpec> {
  const { names } = state
  const labels = (role: RelayPlatformServiceRole) => ({
    ...relayOwnerLabels(config),
    [KILN_INSTALLATION_LABEL]: state.installationId,
    [PLATFORM_ROLE_LABEL]: role,
    [RESOURCE_LABEL]: resourceLabels[role],
  })
  const database: ContainerSpec = {
    env: {
      MYSQL_DATABASE: state.database.name,
      MYSQL_PASSWORD: state.secrets.databasePassword,
      MYSQL_ROOT_PASSWORD: state.secrets.databaseRootPassword,
      MYSQL_USER: state.database.user,
    },
    healthcheck: {
      command:
        'mysqladmin ping -h 127.0.0.1 -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" --silent',
      intervalMs: 5_000,
      retries: 20,
      startIntervalMs: 1_000,
      startPeriodMs: 60_000,
      timeoutMs: 5_000,
    },
    image: state.database.image,
    labels: labels("database"),
    mounts: [
      {
        source: names.databaseVolume,
        target: "/var/lib/mysql",
        type: "volume",
      },
    ],
    name: names.database,
    network: { aliases: [names.database], name: names.network },
    restart: "unless-stopped",
  }
  const cache: ContainerSpec | null = state.cache && {
    command: ["valkey-server", "--save", "", "--appendonly", "no"],
    healthcheck: {
      command: "valkey-cli ping | grep -q PONG",
      intervalMs: 5_000,
      retries: 20,
      startIntervalMs: 1_000,
      startPeriodMs: 10_000,
      timeoutMs: 3_000,
    },
    image: state.cache.image,
    labels: labels("cache"),
    name: names.cache,
    network: { aliases: [names.cache], name: names.network },
    restart: "unless-stopped",
    tmpfs: { "/data": "rw" },
  }
  const hearth: ContainerSpec = {
    env: {
      KILN_URL: state.hearth.url,
      KILN_INSTALLATION_ID: state.installationId,
      KILN_ENVIRONMENT: "prod",
      KILN_SETUP_TOKEN: state.secrets.setupToken,
      DB_HOST: names.database,
      DB_PORT: "3306",
      DB_NAME: state.database.name,
      DB_USERNAME: state.database.user,
      DB_PASSWORD: state.secrets.databasePassword,
      ...(state.cache && { CACHE_HOST: names.cache, CACHE_PORT: "6379" }),
      BETTER_AUTH_SECRETS: state.secrets.authSecrets,
      KILN_RELAY_BOOTSTRAP_TOKEN: state.secrets.bootstrapToken,
      KILN_RELAY_HOST: state.relay.host,
      KILN_RELAY_PORT: String(state.relay.port),
      ...Object.fromEntries(
        Object.entries(state.hearth.environment).sort(([left], [right]) =>
          left.localeCompare(right)
        )
      ),
    },
    image: state.hearth.image,
    labels: labels("hearth"),
    name: names.hearth,
    network: { aliases: [names.hearth], name: names.network },
    ports: [
      {
        containerPort: HEARTH_CONTAINER_PORT,
        hostIp: state.hearth.bindAddress,
        hostPort: state.hearth.port,
        protocol: "tcp",
      },
    ],
    restart: "unless-stopped",
  }
  return [
    { role: "database", spec: withSpecLabel(database) },
    ...(cache ? [{ role: "cache" as const, spec: withSpecLabel(cache) }] : []),
    { role: "hearth", spec: withSpecLabel(hearth) },
  ]
}

function withSpecLabel(spec: ContainerSpec): ContainerSpec {
  const { image: _image, ...configuration } = spec
  return {
    ...spec,
    labels: {
      ...spec.labels,
      [PLATFORM_SPEC_LABEL]: createHash("sha256")
        .update(JSON.stringify(configuration))
        .digest("hex")
        .slice(0, 32),
    },
  }
}

export interface PlatformPassResult {
  /** Why the pass stopped short, or null once everything is running. */
  readonly issue: string | null
  /** Whether it stopped for something only an operator can resolve. */
  readonly blocked: boolean
  readonly state: PlatformState | null
}

export interface PlatformContext {
  readonly config: RelayConfig
  readonly engine: DockerEngine
  /**
   * Joins this process's container to Kiln's network as the Relay. Only the
   * running Relay does: a command from a recovery container must not take
   * over the Relay's name.
   */
  readonly attachRelay?: boolean
  /**
   * Runs before Hearth is created or started, so a pairing invitation is
   * waiting for it. Returns a new invitation's ID, to record as the
   * installed Hearth's.
   */
  readonly beforeHearth?: Effect.Effect<string | null>
}

const passed = (state: PlatformState | null): PlatformPassResult => ({
  blocked: false,
  issue: null,
  state,
})
const waiting = (
  state: PlatformState | null,
  issue: string
): PlatformPassResult => ({ blocked: false, issue, state })
const blocked = (
  state: PlatformState | null,
  issue: string
): PlatformPassResult => ({ blocked: true, issue, state })

/**
 * One pass over Kiln's services. Takes the installation lock, so passes from
 * the running Relay and from `kiln-relay platform` never overlap.
 */
export const reconcilePlatform = Effect.fn("Relay.platform.reconcile")(
  function* (context: PlatformContext) {
    const { config, engine } = context
    return yield* withPlatformLock(
      config.dataDirectory,
      Effect.gen(function* () {
        let state = yield* readPlatformState(config.dataDirectory)
        if (!state) return blocked(null, "This Relay hasn't installed Kiln")
        const specs = serviceSpecs(state, config)
        const spec = (role: RelayPlatformServiceRole) =>
          specs.find((candidate) => candidate.role === role)?.spec

        const networkIssue = yield* ensureNetwork(engine, state, config)
        if (networkIssue) return blocked(state, networkIssue)
        if (context.attachRelay) yield* attachRelay(engine, state)

        const volume = yield* inspectOptional(
          engine.inspectVolume(state.names.databaseVolume)
        )
        if (
          volume &&
          volume.Labels?.[KILN_INSTALLATION_LABEL] !== state.installationId
        ) {
          return blocked(
            state,
            `A volume named ${state.names.databaseVolume} already exists and doesn't belong to this installation. Start the Relay with another KILN_RELAY_RESOURCE_NAMESPACE.`
          )
        }
        if (!volume && state.databaseInitializedAt) {
          return blocked(
            state,
            `Hearth's database volume ${state.names.databaseVolume} is missing. Restore it, or run \`kiln-relay platform recover --confirm ${state.installationId}\` to start an empty database and restore a platform backup into it.`
          )
        }
        if (!volume) {
          yield* engine.createVolume({
            labels: {
              ...relayOwnerLabels(config),
              [KILN_INSTALLATION_LABEL]: state.installationId,
              [RESOURCE_LABEL]: resourceLabels.database,
            },
            name: state.names.databaseVolume,
          })
        }

        for (const role of ["database", "cache"] as const) {
          const service = spec(role)
          if (!service) continue
          const issue = yield* ensureService(engine, config, state, service)
          if (issue) return blocked(state, issue)
        }
        const databaseReady = yield* waitUntilHealthy(
          engine,
          state.names.database,
          DATABASE_READY_TIMEOUT_MS
        )
        if (!databaseReady) {
          return waiting(state, "Hearth's database isn't healthy yet")
        }
        if (!state.databaseInitializedAt) {
          state = { ...state, databaseInitializedAt: new Date().toISOString() }
          yield* writePlatformState(config.dataDirectory, state)
        }

        if (state.phase === "maintenance") {
          yield* stopForMaintenance(engine, config, state)
          return passed(state)
        }

        const invitationId = yield* context.beforeHearth ?? Effect.succeed(null)
        if (invitationId && !state.ownerInvitationIds.includes(invitationId)) {
          state = {
            ...state,
            ownerInvitationIds: [...state.ownerInvitationIds, invitationId].slice(
              -OWNER_INVITATIONS_KEPT
            ),
          }
          yield* writePlatformState(config.dataDirectory, state)
        }
        const hearth = spec("hearth")
        if (hearth) {
          const issue = yield* ensureService(engine, config, state, hearth)
          if (issue) return blocked(state, issue)
        }
        if (state.phase === "installing") {
          if (!(yield* waitUntilHealthy(engine, state.names.hearth, 180_000))) {
            return waiting(state, "Hearth is starting")
          }
          state = { ...state, phase: "ready" }
          yield* writePlatformState(config.dataDirectory, state)
        }
        return passed(state)
      })
    )
  },
  Effect.catch((cause) =>
    Effect.succeed(
      waiting(null, cause instanceof Error ? cause.message : String(cause))
    )
  )
)

const ensureNetwork = Effect.fnUntraced(function* (
  engine: DockerEngine,
  state: PlatformState,
  config: Pick<RelayConfig, "resourceNamespace">
) {
  const existing = yield* inspectOptional(
    engine.inspectNetwork(state.names.network)
  )
  if (existing) {
    return existing.Labels?.[KILN_INSTALLATION_LABEL] === state.installationId
      ? null
      : `A network named ${state.names.network} already exists and doesn't belong to this installation. Start the Relay with another KILN_RELAY_RESOURCE_NAMESPACE.`
  }
  yield* engine.createNetwork({
    labels: {
      ...relayOwnerLabels(config),
      [KILN_INSTALLATION_LABEL]: state.installationId,
      [PLATFORM_ROLE_LABEL]: "network",
    },
    name: state.names.network,
  })
  return null
})

/**
 * Joins the Relay's own container to Kiln's network under its advertised
 * host, the name its certificate is for, so Hearth connects to it there.
 */
const attachRelay = Effect.fnUntraced(function* (
  engine: DockerEngine,
  state: PlatformState
) {
  const alias = state.relay.host
  const own = yield* ownContainer(engine)
  if (!own) {
    return yield* new PlatformError({
      reason:
        "Platform mode needs the Relay to run in a Docker container on the host it installs Kiln on",
    })
  }
  const endpoint = own.NetworkSettings?.Networks?.[state.names.network]
  if (endpoint?.Aliases?.includes(alias)) return
  if (endpoint) {
    yield* engine.disconnectNetwork(state.names.network, own.Id, {
      force: true,
    })
  }
  yield* engine.connectNetwork(state.names.network, own.Id, {
    aliases: [alias],
  })
})

/** The Relay's own container, by the hostname Docker gave it. */
export const ownContainer = Effect.fnUntraced(function* (engine: DockerEngine) {
  const name = hostname()
  const direct = yield* inspectOptional(engine.inspectContainer(name))
  if (direct) return direct
  // A hostname set with `--hostname` isn't a container reference.
  const running = yield* engine.listContainers()
  const inspected = yield* engine.inspectContainers(running.map((c) => c.Id))
  return inspected.find((c) => c.Config.Hostname === name) ?? null
})

/**
 * Creates a service that's missing, recreates one whose settings changed,
 * and starts one that stopped. Returns why it couldn't, or null.
 */
const ensureService = Effect.fnUntraced(function* (
  engine: DockerEngine,
  config: Pick<RelayConfig, "dataDirectory">,
  state: PlatformState,
  service: ContainerSpec
) {
  if (yield* updateRunning(config.dataDirectory, service.name)) return null
  const existing = yield* inspectOptional(
    engine.inspectContainer(service.name)
  )
  if (!existing) {
    yield* createAndStart(engine, service)
    return null
  }
  const labels = existing.Config.Labels ?? {}
  if (
    labels[KILN_INSTALLATION_LABEL] !== state.installationId ||
    !labels[PLATFORM_ROLE_LABEL]
  ) {
    return `A container named ${service.name} already exists and doesn't belong to this installation. Rename or remove it, or start the Relay with another KILN_RELAY_RESOURCE_NAMESPACE.`
  }
  if (labels[PLATFORM_SPEC_LABEL] !== service.labels?.[PLATFORM_SPEC_LABEL]) {
    // Keep the image it runs: an update may have moved it on.
    yield* engine.stopContainer(existing.Id, { seconds: 30, timeout: 45_000 })
    yield* engine.removeContainer(existing.Id, { force: true, timeout: 60_000 })
    yield* createAndStart(engine, { ...service, image: existing.Config.Image })
    yield* Effect.logInfo(`Recreated ${service.name} with its new settings`)
    return null
  }
  if (!existing.State.Running && !existing.State.Restarting) {
    yield* engine.startContainer(existing.Id, { timeout: 120_000 })
  }
  return null
})

function createAndStart(engine: DockerEngine, spec: ContainerSpec) {
  return createContainer(engine, spec, { pullTimeout: PULL_TIMEOUT_MS }).pipe(
    Effect.tap((created) =>
      engine.startContainer(created.Id, { timeout: 120_000 })
    ),
    Effect.tap(() => Effect.logInfo(`Started ${spec.name}`))
  )
}

const stopForMaintenance = Effect.fnUntraced(function* (
  engine: DockerEngine,
  config: Pick<RelayConfig, "dataDirectory">,
  state: PlatformState
) {
  if (yield* updateRunning(config.dataDirectory, state.names.hearth)) return
  const hearth = yield* inspectOptional(
    engine.inspectContainer(state.names.hearth)
  )
  if (!hearth?.State.Running && !hearth?.State.Restarting) return
  if (hearth.Config.Labels?.[KILN_INSTALLATION_LABEL] !== state.installationId) {
    return
  }
  yield* engine.stopContainer(hearth.Id, { seconds: 30, timeout: 45_000 })
})

/** Whether Kiln's updater holds the container: it's being replaced. */
function updateRunning(dataDirectory: string, container: string) {
  return Effect.tryPromise(() =>
    access(join(dataDirectory, "updates", `${container}.lock`))
  ).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false))
  )
}

function waitUntilHealthy(
  engine: DockerEngine,
  container: string,
  timeoutMs: number
) {
  const deadline = Date.now() + timeoutMs
  return Effect.gen(function* () {
    while (true) {
      const inspected = yield* inspectOptional(
        engine.inspectContainer(container)
      )
      const health = inspected?.State.Health?.Status
      if (inspected?.State.Running && (!health || health === "healthy")) {
        return true
      }
      if (Date.now() >= deadline) return false
      yield* Effect.sleep(1_000)
    }
  })
}

function inspectOptional<A>(effect: Effect.Effect<A, DockerEngineError>) {
  return effect.pipe(
    Effect.map((value): A | null => value),
    Effect.catchIf(isDockerNotFound, () => Effect.succeed(null))
  )
}

// ------------------------------------------------------------------ status

export interface PlatformReadContext {
  readonly config: RelayConfig
  readonly engine: DockerEngine
  /** The last pass's problem, reported until a pass gets past it. */
  readonly issue: string | null
  readonly blocked: boolean
}

/**
 * Whether the Hearth client may restart and repair Kiln's services: it was
 * paired through an invitation this Relay made for the Hearth it installed.
 */
export function isPlatformOwner(
  state: PlatformState | null,
  client: Pick<RelayClientRecord, "invitationId" | "role"> | null
): boolean {
  return (
    state !== null &&
    client !== null &&
    client.role === "full_access" &&
    state.ownerInvitationIds.includes(client.invitationId)
  )
}

export const platformStatus = Effect.fn("Relay.platform.status")(function* (
  context: PlatformReadContext,
  client: Pick<RelayClientRecord, "invitationId" | "role"> | null
) {
  const { config, engine } = context
  const state =
    config.mode === "platform"
      ? yield* readPlatformState(config.dataDirectory)
      : null
  const containers = yield* platformContainers(engine, config, state)
  const canManage = isPlatformOwner(state, client)
  const updating = new Set<string>()
  for (const role of ["hearth", "database", "cache"] as const) {
    const name = state?.names[role]
    if (name && (yield* updateRunning(config.dataDirectory, name))) {
      updating.add(role)
    }
  }
  const roles: ReadonlyArray<RelayPlatformServiceRole> = state
    ? state.cache
      ? ["hearth", "database", "cache"]
      : ["hearth", "database"]
    : (["hearth", "database", "cache"] as const).filter((role) =>
        containers.has(role)
      )
  const services = roles.map(
    (role): RelayPlatformService =>
      serviceStatus(
        role,
        containers.get(role) ?? null,
        updating.has(role),
        canManage
      )
  )
  return {
    canManage,
    checkedAt: new Date().toISOString(),
    hearthUrl: state?.hearth.url ?? null,
    installationId: state?.installationId ?? config.installationId,
    issue: state ? context.issue : null,
    management: state ? "relay" : "external",
    phase: !state ? "ready" : context.blocked ? "blocked" : state.phase,
    services,
  } satisfies RelayPlatformStatus
})

function serviceStatus(
  role: RelayPlatformServiceRole,
  container: DockerContainerInspect | null,
  updating: boolean,
  canManage: boolean
): RelayPlatformService {
  const health = container?.State.Health?.Status
  return {
    actions: canManage && container ? ["restart"] : [],
    container: container ? container.Name.replace(/^\//u, "") : null,
    health:
      health === "healthy" || health === "starting" || health === "unhealthy"
        ? health
        : null,
    image: container?.Config.Image ?? null,
    role,
    startedAt:
      container?.State.Running && validDate(container.State.StartedAt)
        ? new Date(container.State.StartedAt).toISOString()
        : null,
    state: updating
      ? "updating"
      : !container
        ? "missing"
        : container.State.Restarting
          ? "restarting"
          : !container.State.Running
            ? "stopped"
            : health === "starting"
              ? "starting"
              : health === "unhealthy"
                ? "unhealthy"
                : "running",
    version: container?.Config.Labels?.[VERSION_LABEL]?.slice(0, 100) || null,
  }
}

function validDate(value: string | undefined): value is string {
  return Boolean(value) && Number.isFinite(Date.parse(value ?? ""))
}

/**
 * Kiln's service containers on this host: the ones this Relay installed, or,
 * without an installation of its own, Compose or Coolify containers labeled
 * for its installation.
 */
const platformContainers = Effect.fnUntraced(function* (
  engine: DockerEngine,
  config: Pick<RelayConfig, "installationId">,
  state: PlatformState | null
) {
  const found = new Map<RelayPlatformServiceRole, DockerContainerInspect>()
  if (state) {
    for (const role of ["hearth", "database", "cache"] as const) {
      const inspected = yield* inspectOptional(
        engine.inspectContainer(state.names[role])
      )
      if (
        inspected &&
        inspected.Config.Labels?.[KILN_INSTALLATION_LABEL] ===
          state.installationId
      ) {
        found.set(role, inspected)
      }
    }
    return found
  }
  if (!config.installationId) return found
  const listed = yield* engine.listContainers({
    all: true,
    filters: {
      label: [`${KILN_INSTALLATION_LABEL}=${config.installationId}`],
    },
  })
  for (const role of ["hearth", "database", "cache"] as const) {
    const match = listed.find(
      (container) => container.Labels?.[RESOURCE_LABEL] === resourceLabels[role]
    )
    if (!match) continue
    const inspected = yield* inspectOptional(engine.inspectContainer(match.Id))
    if (inspected) found.set(role, inspected)
  }
  return found
})

/** Whether Kiln's services run beside this Relay without it managing them. */
export const externalPlatformPresent = Effect.fn(
  "Relay.platform.externalPresent"
)(function* (engine: DockerEngine, config: Pick<RelayConfig, "installationId">) {
  if (!config.installationId) return false
  const listed = yield* engine.listContainers({
    filters: {
      label: [
        `${KILN_INSTALLATION_LABEL}=${config.installationId}`,
        `${RESOURCE_LABEL}=${resourceLabels.hearth}`,
      ],
    },
  })
  return listed.length > 0
})

const MAX_LOG_LINE_CHARACTERS = 8_192

export const platformLogs = Effect.fn("Relay.platform.logs")(function* (
  context: PlatformReadContext,
  role: RelayPlatformServiceRole,
  lines: number
) {
  const { config, engine } = context
  const state =
    config.mode === "platform"
      ? yield* readPlatformState(config.dataDirectory)
      : null
  const container = (yield* platformContainers(engine, config, state)).get(role)
  if (!container) {
    return yield* new PlatformError({
      reason: `Kiln's ${role} container isn't on this Relay's host`,
    })
  }
  const collected: Array<string> = []
  yield* engine.containerLogLines(
    container.Id,
    { tail: lines, timeout: 15_000, tty: Boolean(container.Config.Tty) },
    (line) => {
      collected.push(
        line.length > MAX_LOG_LINE_CHARACTERS
          ? `${line.slice(0, MAX_LOG_LINE_CHARACTERS)}…`
          : line
      )
    }
  )
  return { lines: collected.slice(-lines), role }
})

// ----------------------------------------------------------------- actions

/**
 * A restart or repair Hearth asked for. Only the Hearth this Relay installed
 * may ask; the caller checks with `isPlatformOwner` first.
 */
export const platformAction = Effect.fn("Relay.platform.action")(function* (
  context: PlatformContext,
  input: RelayPlatformActionInput
) {
  const { config, engine } = context
  if (input.action === "repair") return yield* reconcilePlatform(context)
  const state = yield* readPlatformState(config.dataDirectory)
  if (!state) {
    return yield* new PlatformError({ reason: "This Relay hasn't installed Kiln" })
  }
  const name = state.names[input.role]
  if (yield* updateRunning(config.dataDirectory, name)) {
    return yield* new PlatformError({
      reason: `${name} is being updated; try again once the update finishes`,
    })
  }
  const container = yield* inspectOptional(engine.inspectContainer(name))
  if (
    !container ||
    container.Config.Labels?.[KILN_INSTALLATION_LABEL] !== state.installationId
  ) {
    return yield* new PlatformError({
      reason: `${name} is missing; repair Kiln's services to recreate it`,
    })
  }
  const restart = engine.restartContainer(container.Id, {
    seconds: 30,
    timeout: 90_000,
  })
  if (input.role === "hearth") {
    // Hearth is the one asking: answer before it goes down.
    yield* Effect.sleep(1_000).pipe(
      Effect.andThen(restart),
      Effect.catch((cause) => Effect.logError("Hearth restart failed", cause)),
      Effect.forkDetach
    )
  } else {
    yield* restart
  }
  return passed(state)
})

// --------------------------------------------------------------- lifecycle

export interface PlatformStartup {
  /** The installation, or null when this Relay doesn't run Kiln. */
  readonly state: PlatformState | null
  /** Why platform mode didn't start, when it was asked for. */
  readonly refused: string | null
}

/**
 * Loads, or on first start creates, the installation record, and points the
 * Relay's configuration at it: its installation ID, bootstrap token, and
 * platform backup key. Runs before pairing, so the bootstrap invitation uses
 * the token Hearth will be given.
 *
 * A Relay that already belongs to an installation (it has paired with a
 * Hearth, or adopted an installation ID) never creates a second one.
 */
export const startPlatform = Effect.fn("Relay.platform.start")(function* (
  config: RelayConfig,
  engine: DockerEngine,
  input: {
    readonly environment?: NodeJS.ProcessEnv
    readonly pairedClients: number
    /** Only the running Relay saves its environment into the record. */
    readonly saveInputs: boolean
  }
) {
  const existing = yield* readPlatformState(config.dataDirectory)
  if (config.mode !== "platform") {
    if (existing) {
      yield* Effect.logWarning(
        "This Relay installed Kiln, but KILN_RELAY_MODE isn't platform, so it leaves Hearth and its database as they are. Set KILN_RELAY_MODE=platform to manage them again."
      )
    }
    return { refused: null, state: null } satisfies PlatformStartup
  }
  const inputs = platformInputs(input.environment)
  let state = existing
  if (!state) {
    // An ID the operator set is the one to install with; one adopted from
    // a Hearth means this Relay already serves an installation.
    const adopted = config.installationId && !config.installationIdConfigured
    if (input.pairedClients > 0 || adopted) {
      return {
        refused:
          "Platform mode installs Kiln only on a new Relay. This one already belongs to an installation, so it keeps running as a Relay node.",
        state: null,
      } satisfies PlatformStartup
    }
    if (!input.saveInputs) {
      return {
        refused: "Kiln isn't installed on this Relay yet",
        state: null,
      } satisfies PlatformStartup
    }
    const own = yield* ownContainer(engine).pipe(
      Effect.catch(() => Effect.succeed(null))
    )
    const relayImage = own?.Config.Image ?? null
    const created = newPlatformState(
      config,
      inputs,
      defaultHearthImage(relayImage, config.gitRepository)
    )
    state = yield* withPlatformLock(
      config.dataDirectory,
      Effect.gen(function* () {
        // Another process may have installed it while this one waited.
        const raced = yield* readPlatformState(config.dataDirectory)
        if (raced) return raced
        yield* writePlatformState(config.dataDirectory, created)
        return created
      })
    )
    yield* Effect.logInfo(
      `Installing Kiln ${state.installationId}: Hearth will be at ${state.hearth.url}`
    )
  } else if (input.saveInputs) {
    const next = withPlatformInputs(state, inputs, config)
    if (next !== state) {
      state = yield* updatePlatformState(config.dataDirectory, (current) =>
        withPlatformInputs(current, inputs, config)
      )
    }
  }
  applyPlatformConfig(config, state)
  return { refused: null, state } satisfies PlatformStartup
})

function applyPlatformConfig(config: RelayConfig, state: PlatformState) {
  if (config.installationId && config.installationId !== state.installationId) {
    console.warn(
      `KILN_INSTALLATION_ID ${config.installationId} differs from the installed Kiln's ${state.installationId}; using ${state.installationId}`
    )
  }
  config.installationId = state.installationId
  config.installationIdConfigured = true
  // Hearth is given the record's token, so the Relay must expect it.
  config.bootstrapToken = state.secrets.bootstrapToken
  config.platformBackupKey ??= state.secrets.platformBackupKey
  // Players reach game servers at Hearth's host unless told otherwise.
  if (config.gameHostSource === "relay") {
    config.gameHost = new URL(state.hearth.url).hostname
    config.gameHostSource = "configured"
  }
}

// The latest few. Each new one is made only while no Hearth has paired, so
// older ones expired unused, except the one the installed Hearth paired by.
const OWNER_INVITATIONS_KEPT = 16

/** Records a pairing invitation as the installed Hearth's. */
export function addOwnerInvitation(
  dataDirectory: string,
  invitationId: string
) {
  return updatePlatformState(dataDirectory, (state) =>
    state.ownerInvitationIds.includes(invitationId)
      ? state
      : {
          ...state,
          ownerInvitationIds: [...state.ownerInvitationIds, invitationId].slice(
            -OWNER_INVITATIONS_KEPT
          ),
        }
  )
}

// --------------------------------------------------------------------- CLI

const CLI_USAGE = `Usage: kiln-relay platform <command>

  status                         Show Kiln's services and any problem
  setup-url                      Print the link that creates Hearth's administrator
  repair                         Create what's missing and start what stopped, now
  stop-hearth                    Hold Hearth stopped; its database keeps running
  start-hearth                   Let Hearth run again
  recover --confirm <id>         Start an empty database after its volume was lost
  export-kit                     Print the recovery kit (secrets) as JSON
  import-kit <path>              Install from a recovery kit on a new Relay`

/**
 * `kiln-relay platform …`, for an operator at the Relay's console. These work
 * without Hearth, and in a recovery container that shares the Relay's data
 * volume and Docker socket.
 */
export const runPlatformCli = Effect.fn("Relay.platform.cli")(function* (
  args: ReadonlyArray<string>,
  context: PlatformContext,
  print: (text: string) => void
) {
  const { config } = context
  const command = args[1]
  const state = yield* readPlatformState(config.dataDirectory)
  if (command === "import-kit") {
    const path = args[2]
    if (!path) return yield* new PlatformError({ reason: CLI_USAGE })
    if (state) {
      return yield* new PlatformError({
        reason: "This Relay already has an installation; import a kit on a new Relay",
      })
    }
    const imported = yield* importPlatformKit(config, path)
    print(
      `Imported Kiln ${imported.installationId}. Start the Relay with KILN_RELAY_MODE=platform: it creates an empty database and holds Hearth stopped. Then:\n` +
        `  kiln-relay platform-backup restore <backup> --confirm ${imported.installationId}\n` +
        `  kiln-relay platform start-hearth`
    )
    return
  }
  if (!state) {
    return yield* new PlatformError({
      reason:
        "This Relay hasn't installed Kiln. Start it with KILN_RELAY_MODE=platform to install, or import a recovery kit.",
    })
  }
  switch (command) {
    case "status": {
      const status = yield* platformStatus(
        { blocked: false, config, engine: context.engine, issue: null },
        null
      )
      print(
        [
          `Installation ${state.installationId} (${state.phase})`,
          `Hearth       ${state.hearth.url}`,
          ...status.services.map(
            (service) =>
              `${service.role.padEnd(12)} ${service.state}${service.image ? `  ${service.image}` : ""}`
          ),
        ].join("\n")
      )
      return
    }
    case "setup-url":
      print(platformSetupUrl(state))
      return
    case "repair": {
      const result = yield* reconcilePlatform(context)
      print(result.issue ?? "Kiln's services are running")
      return
    }
    case "stop-hearth":
    case "start-hearth": {
      const phase = command === "stop-hearth" ? "maintenance" : "ready"
      yield* updatePlatformState(config.dataDirectory, (current) =>
        current.phase === phase ? current : { ...current, phase }
      )
      const result = yield* reconcilePlatform(context)
      print(
        result.issue ??
          (phase === "maintenance"
            ? "Hearth is stopped and stays stopped until `kiln-relay platform start-hearth`"
            : "Hearth is starting")
      )
      return
    }
    case "recover": {
      const confirmIndex = args.indexOf("--confirm")
      if (args[confirmIndex + 1] !== state.installationId || confirmIndex < 0) {
        return yield* new PlatformError({
          reason: `This starts Hearth's database empty. Confirm with --confirm ${state.installationId}`,
        })
      }
      yield* updatePlatformState(config.dataDirectory, (current) => ({
        ...current,
        databaseInitializedAt: null,
        phase: "maintenance",
      }))
      const result = yield* reconcilePlatform(context)
      print(
        result.issue ??
          `Hearth's database is empty and Hearth is held stopped. Restore a platform backup with \`kiln-relay platform-backup restore <backup> --confirm ${state.installationId}\`, then run \`kiln-relay platform start-hearth\`.`
      )
      return
    }
    case "export-kit":
      print(JSON.stringify(platformRecoveryKit(state), null, 2))
      return
    default:
      return yield* new PlatformError({ reason: CLI_USAGE })
  }
})

const importPlatformKit = Effect.fnUntraced(function* (
  config: RelayConfig,
  path: string
) {
  const text = yield* Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) =>
      new PlatformError({ reason: `Can't read ${path}`, cause }),
  })
  const kit = yield* decodePlatformRecoveryKit(text).pipe(
    Effect.mapError(
      (cause) =>
        new PlatformError({
          reason: "That file isn't a Kiln recovery kit",
          cause,
        })
    )
  )
  const state: PlatformState = {
    ...kit.state,
    // A new host has none of the old services; the database starts empty
    // for a platform backup to be restored into.
    databaseInitializedAt: null,
    names: platformNames(config),
    // The new Relay pairs with Hearth through its own invitation.
    ownerInvitationIds: [],
    phase: "maintenance",
  }
  yield* withPlatformLock(
    config.dataDirectory,
    Effect.gen(function* () {
      if (yield* readPlatformState(config.dataDirectory)) {
        return yield* new PlatformError({
          reason: "This Relay already has an installation",
        })
      }
      yield* writePlatformState(config.dataDirectory, state)
    })
  )
  return state
})
