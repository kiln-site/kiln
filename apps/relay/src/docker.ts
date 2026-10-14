import { createHash } from "node:crypto"
import { existsSync, readdirSync } from "node:fs"
import { statfs } from "node:fs/promises"
import { request } from "node:http"
import { Socket } from "node:net"
import { hostname } from "node:os"
import { basename, relative, resolve } from "node:path"
import { Effect, Option, Queue, Result, Semaphore, Stream } from "effect"

import {
  DATABASE_CONNECTION_LABEL_PREFIX,
  type DatabaseConnections,
  type DatabaseConnectionSnapshot,
} from "./database-connections.js"
import { command } from "./command.js"
import {
  DockerEngine,
  DockerEngineError,
  type DockerLogOptions,
} from "./docker-engine.js"
import type { BrickCatalog } from "./bricks.js"
import { directoryApparentSizeEffect } from "./disk-usage.js"
import { ensuringPromise } from "./effect/promise.js"
import type {
  RelayStateStore,
  RelayStoredLifecycleSession,
} from "./effect/state.js"
import type {
  BrickReadiness,
  BrickVariableValue,
  RelayConsole,
  RelayConsoleCompletion,
  RelayConsoleLine,
  RelayDesiredState,
  RelayInstanceRecovery,
  RelayInstance,
  RelayInstanceLifecycleEvent,
  RelayInstanceLifecycleState,
  RelayInstanceResources,
  RelaySftpPublicationStatus,
} from "@workspace/contracts"
import {
  builtinTailscaleBrickId,
  brickConsoleSchema,
  brickReadinessSchema,
  brickVariableValuesSchema,
  DEFAULT_INSTANCE_DISK_LIMIT_BYTES,
  relayInstanceLifecycleEventTime as lifecycleEventTime,
  relayInstanceTailscaleSchema,
} from "@workspace/contracts"

import type { RelayConfig, RelayInstanceConfig } from "./config.js"
import {
  relayOwnsLabels,
  relayResourceNames,
  type RelayResourceNames,
} from "./relay-resources.js"
import {
  discoverPortAllocations,
  isManagedPortLabel,
} from "./port-allocations.js"
import {
  INSTALLATION_MARKER_LABEL,
  installationMarkerName,
} from "./installation-marker.js"
import {
  INSTANCE_STARTUP_READINESS_TIMEOUT_MS,
  INSTANCE_STOP_TIMEOUT_SECONDS,
  instanceStateReason,
  observedInstancePowerState,
  type InstancePowerAction,
  type InstancePowerTransition,
  type ObservedInstancePowerState,
} from "./power-state.js"
import {
  matchingReadyLogLine,
  parseConsoleCompletion,
  parseConsoleLine,
  parseConsoleOutput,
  type ParsedConsoleLine,
} from "./console-parsing.js"
import { procNetTcpHasListener } from "./docker-port-parsing.js"
import { legacyDiskLimitAssignments } from "./resource-quotas.js"
import { WEB_ROUTE_LABEL_PREFIX } from "./web-route-labels.js"
import type { RelayWebRouteLabelSnapshot } from "./web-route-labels.js"
import type { RuntimeRecoveryManager } from "./runtime-recovery.js"

interface DockerInspect {
  Config: {
    AttachStdin?: boolean
    AttachStdout?: boolean
    Image: string
    Labels: Record<string, string | undefined> | null
    OpenStdin?: boolean
    Tty?: boolean
  }
  Id: string
  HostConfig?: {
    Memory?: number
    PortBindings?: DockerPortBindings
    RestartPolicy?: {
      Name?: string
    }
  }
  Mounts: Array<{
    Destination: string
    Source: string
    RW: boolean
  }>
  Name: string
  NetworkSettings?: {
    Networks?: Record<
      string,
      {
        IPAddress?: string
      }
    >
    Ports?: DockerPortBindings
  }
  State: {
    ExitCode: number
    Health?: {
      Status: string
    }
    OOMKilled: boolean
    Restarting: boolean
    Running: boolean
    FinishedAt: string
    StartedAt: string
    Status: string
  }
}

interface DockerRecreateInspect {
  Config: Record<string, unknown> & {
    ExposedPorts?: Record<string, Record<string, never>>
    Labels?: Record<string, string> | null
  }
  HostConfig: Record<string, unknown> & {
    NetworkMode?: string
    PortBindings?: DockerPortBindings
  }
  NetworkSettings?: {
    Networks?: Record<
      string,
      {
        Aliases?: Array<string> | null
      }
    >
  }
  State: {
    Running: boolean
    StartedAt: string
  }
}

interface DiscoveredInstance {
  config: RelayInstanceConfig
  container: DockerInspect
}

interface ConsoleTarget {
  component: "coredns" | "tailscale" | null
  container: DockerInspect
}

interface LogTarget {
  component: ConsoleTarget["component"]
  id: string
  since: string | undefined
  tty: boolean
}

export interface DockerConsoleSession {
  readonly history: (
    limit?: number,
    signal?: AbortSignal
  ) => Promise<RelayConsole>
  readonly stream: (
    signal: AbortSignal,
    limit?: number
  ) => AsyncIterable<RelayConsoleLine>
}

interface DockerStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number }
    online_cpus?: number
    system_cpu_usage?: number
  }
  precpu_stats?: {
    cpu_usage?: { total_usage?: number }
    system_cpu_usage?: number
  }
  memory_stats?: {
    limit?: number
    stats?: {
      inactive_file?: number
      total_inactive_file?: number
    }
    usage?: number
  }
  networks?: Record<
    string,
    {
      rx_bytes?: number
      tx_bytes?: number
    }
  >
}

export type DockerPortBindings = Record<
  string,
  Array<{ HostIp?: string; HostPort?: string }> | null | undefined
>

export interface DockerPortConfiguration {
  bindings: DockerPortBindings
  labels: Readonly<Record<string, string>>
}

export interface RelaySftpPublication {
  port: number
  status: RelaySftpPublicationStatus
}

export function relaySftpPublicationFromBindings(
  bindings: DockerPortBindings,
  containerPort: number
): RelaySftpPublication {
  const candidates = (bindings[`${containerPort}/tcp`] ?? []).flatMap(
    (candidate) => {
      const port = Number(candidate.HostPort)
      return Number.isInteger(port) && port >= 1 && port <= 65_535
        ? [{ hostIp: candidate.HostIp ?? "", port }]
        : []
    }
  )
  if (candidates.length === 0) {
    return { port: containerPort, status: "not_published" }
  }
  const publiclyBound = candidates.find(
    (candidate) => !isLoopbackAddress(candidate.hostIp)
  )
  if (publiclyBound) {
    return { port: publiclyBound.port, status: "published" }
  }
  return { port: candidates[0]?.port ?? containerPort, status: "loopback_only" }
}

export const inspectRelaySftpPublicationEffect = Effect.fn(
  "relay.sftp.publication.inspect"
)(function* (
  containerPort: number,
  containerName: string,
  inspectHostConfig: (container: string) => Effect.Effect<unknown, unknown>
) {
  return yield* inspectHostConfig(containerName).pipe(
    Effect.flatMap((hostConfig) =>
      Effect.try({
        try: () => decodeDockerSftpInspect(hostConfig),
        catch: (cause) => cause,
      })
    ),
    Effect.map((inspected) =>
      inspected.networkMode === "host"
        ? unknownRelaySftpPublication(containerPort)
        : relaySftpPublicationFromBindings(inspected.bindings, containerPort)
    ),
    Effect.catch(() =>
      Effect.succeed(unknownRelaySftpPublication(containerPort))
    )
  )
})

function unknownRelaySftpPublication(port: number): RelaySftpPublication {
  return { port, status: "unknown" }
}

function decodeDockerSftpInspect(parsed: unknown): {
  bindings: DockerPortBindings
  networkMode: string
} {
  if (!isUnknownRecord(parsed)) throw new Error("Invalid Docker port bindings")
  const networkMode = parsed.NetworkMode
  if (typeof networkMode !== "string") {
    throw new Error("Invalid Docker network mode")
  }
  const portBindings = parsed.PortBindings
  if (portBindings === null || portBindings === undefined) {
    return { bindings: {}, networkMode }
  }
  if (!isUnknownRecord(portBindings)) {
    throw new Error("Invalid Docker port bindings")
  }

  const bindings: DockerPortBindings = {}
  for (const [port, candidates] of Object.entries(portBindings)) {
    if (candidates === null) {
      bindings[port] = null
      continue
    }
    if (!Array.isArray(candidates)) {
      throw new Error("Invalid Docker port binding candidates")
    }
    bindings[port] = candidates.map((candidate) => {
      if (!isUnknownRecord(candidate)) {
        throw new Error("Invalid Docker port binding")
      }
      const hostIp = candidate.HostIp
      const hostPort = candidate.HostPort
      if (hostIp !== undefined && typeof hostIp !== "string") {
        throw new Error("Invalid Docker host IP")
      }
      if (hostPort !== undefined && typeof hostPort !== "string") {
        throw new Error("Invalid Docker host port")
      }
      return {
        ...(hostIp === undefined ? {} : { HostIp: hostIp }),
        ...(hostPort === undefined ? {} : { HostPort: hostPort }),
      }
    })
  }
  return { bindings, networkMode }
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isLoopbackAddress(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
  return (
    normalized === "::1" ||
    normalized.startsWith("127.") ||
    normalized.startsWith("::ffff:127.")
  )
}

function publicConnectAddress(host: string, port: number): string {
  const formattedHost =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
  return `${formattedHost}:${port}`
}

function instancePublicHost(input: {
  discoveredPublicIp?: string | null
  gameHost: string
  instanceHost?: string
  relayHost: string
}): string {
  return (
    input.gameHost.trim() ||
    input.instanceHost?.trim() ||
    input.discoveredPublicIp?.trim() ||
    input.relayHost.trim()
  )
}

function instanceConnectAddress(input: {
  discoveredPublicIp?: string | null
  gameHost?: string
  publicPort?: number
  relayHost?: string
  tailscaleHost?: string
}): string {
  const tailscaleHost = input.tailscaleHost?.trim()
  if (tailscaleHost) return tailscaleHost

  const publicHost =
    input.gameHost?.trim() ||
    input.discoveredPublicIp?.trim() ||
    input.relayHost?.trim()
  if (publicHost && input.publicPort) {
    return publicConnectAddress(publicHost, input.publicPort)
  }
  return "Error: Relay did not report a published game port"
}

interface ResourceCacheEntry {
  lastAttempt: number
  pending: boolean
  value: RelayInstanceResources | null
}

interface DiskUsageCacheEntry {
  lastAttempt: number
  pending: boolean
  usedBytes: number | null
}

interface InstanceReadiness {
  ready: boolean
  readyAt?: string
}

const CONSOLE_TTY_COLUMNS = 120
const CONSOLE_TTY_ROWS = 40
const MAX_SHARED_CONSOLE_BYTES = 10 * 1024 * 1024
export const MAX_CONSOLE_HISTORY_LINES = 5_000
// Console history kept from one read, and by each console browsers follow,
// in characters; the newest output is kept and the history says it was
// truncated.
export const MAX_CONSOLE_HISTORY_CHARACTERS = 16 * 1024 * 1024
const STARTUP_READINESS_LOG_LINES = 1_000
const RESOURCE_HISTORY_WINDOW_MS = 6 * 60_000
const DISK_USAGE_REFRESH_MS = 60_000
const DISCOVERY_TIMEOUT_MS = 30_000

function diskQuotaExceeded(
  usedBytes: number,
  limitBytes: number,
  running: boolean
): boolean {
  return running && usedBytes > limitBytes
}

function initialDiskUsageCacheEntry(): DiskUsageCacheEntry {
  return {
    lastAttempt: 0,
    pending: false,
    usedBytes: null,
  }
}

export class DockerDriver {
  readonly #bricks: BrickCatalog
  readonly #brickReadinessCache = new Map<string, BrickReadiness | null>()
  readonly #config: RelayConfig
  readonly #resources: RelayResourceNames
  #cachedDockerVersion: string | null | undefined
  readonly #consoleLocks = new Map<string, Promise<void>>()
  readonly #consoleSizeStarts = new Map<string, string>()
  readonly #consoleSizePending = new Map<string, Promise<void>>()
  readonly #diskUsageCache = new Map<string, DiskUsageCacheEntry>()
  readonly #engine: DockerEngine
  readonly #powerTransitions = new Map<string, InstancePowerTransition>()
  readonly #runtimeRecovery: RuntimeRecoveryManager
  readonly #lifecycleSessions = new Map<string, RelayStoredLifecycleSession>()
  #lifecycleSessionsInitialization: Promise<void> | null = null
  readonly #diskUsageSemaphore = Semaphore.makeUnsafe(1)
  #relayStartedAt: Promise<string | null> | undefined
  #relaySftpPublication: Promise<RelaySftpPublication> | undefined
  readonly #resourceCache = new Map<string, ResourceCacheEntry>()
  readonly #resourceHistory = new Map<string, Array<RelayInstanceResources>>()
  readonly #state: RelayStateStore["Service"]

  constructor(
    config: RelayConfig,
    runtimeRecovery: RuntimeRecoveryManager,
    bricks: BrickCatalog,
    state: RelayStateStore["Service"],
    readonly databaseConnections: DatabaseConnections
  ) {
    this.#bricks = bricks
    this.#config = config
    this.#engine = new DockerEngine(config.dockerSocket)
    this.#resources = relayResourceNames(config)
    this.#runtimeRecovery = runtimeRecovery
    this.#state = state
  }

  async inspectInstances(): Promise<Array<RelayInstance>> {
    await this.#initializeLifecycleSessions()
    const discovered = await this.#discover()
    const lifecycleSessionUpdates: Array<Promise<void>> = []
    const activeContainerIds = new Set(
      discovered.map(({ container }) => container.Id)
    )
    const activeInstanceIds = new Set(discovered.map(({ config }) => config.id))
    for (const containerId of this.#resourceCache.keys()) {
      if (!activeContainerIds.has(containerId))
        this.#resourceCache.delete(containerId)
    }
    for (const containerId of this.#consoleSizeStarts.keys()) {
      if (!activeContainerIds.has(containerId))
        this.#consoleSizeStarts.delete(containerId)
    }
    for (const instanceId of this.#diskUsageCache.keys()) {
      if (!activeInstanceIds.has(instanceId))
        this.#diskUsageCache.delete(instanceId)
    }
    for (const instanceId of this.#brickReadinessCache.keys()) {
      if (!activeInstanceIds.has(instanceId))
        this.#brickReadinessCache.delete(instanceId)
    }
    for (const instanceId of this.#resourceHistory.keys()) {
      if (!activeInstanceIds.has(instanceId))
        this.#resourceHistory.delete(instanceId)
    }
    for (const instanceId of this.#powerTransitions.keys()) {
      if (!activeInstanceIds.has(instanceId))
        this.#powerTransitions.delete(instanceId)
    }
    for (const instanceId of this.#lifecycleSessions.keys()) {
      if (!activeInstanceIds.has(instanceId)) {
        this.#lifecycleSessions.delete(instanceId)
        lifecycleSessionUpdates.push(this.#deleteLifecycleSession(instanceId))
      }
    }
    await runEffect(
      Effect.forEach(
        discovered,
        ({ config, container }) =>
          config.managedByRelay
            ? promiseEffect(() => this.#ensureConsoleSize(container)).pipe(
                Effect.ignore
              )
            : Effect.void,
        { concurrency: "unbounded", discard: true }
      )
    )
    await runEffect(
      Effect.forEach(
        discovered,
        ({ config, container }) => {
          if (
            !config.managedByRelay ||
            container.HostConfig?.RestartPolicy?.Name === "no"
          ) {
            return Effect.void
          }
          return this.#engine
            .setRestartPolicy(config.service, "no")
            .pipe(Effect.ignore)
        },
        { concurrency: "unbounded", discard: true }
      )
    )
    const now = Date.now()
    const readiness = new Map<string, boolean>()
    const readyAt = new Map<string, string>()
    await Promise.all(
      discovered.map(async ({ config, container }) => {
        const transition = this.#powerTransitions.get(config.id)
        const lifecycleSession = this.#lifecycleSessions.get(config.id)
        const lifecycleSessionMatches =
          lifecycleEventTime(lifecycleSession?.events ?? [], "started") ===
          container.State.StartedAt
        if (
          lifecycleSessionMatches &&
          lifecycleEventTime(lifecycleSession?.events ?? [], "ready") &&
          container.State.Running
        ) {
          readiness.set(config.id, true)
          return
        }
        const brickReadiness = await this.#brickReadiness(config)
        const startedAt = Date.parse(container.State.StartedAt)
        const startedRecently =
          Number.isFinite(startedAt) &&
          now - startedAt < INSTANCE_STARTUP_READINESS_TIMEOUT_MS
        const readinessProbe =
          !container.State.Running &&
          brickReadiness !== undefined &&
          !lifecycleEventTime(lifecycleSession?.events ?? [], "ready")
            ? "historical"
            : instanceReadinessProbe({
                hasHealthCheck: container.State.Health !== undefined,
                hasLogReadiness: brickReadiness !== undefined,
                running: container.State.Running,
                startedRecently,
                transitionAction: transition?.action,
              })
        if (!readinessProbe) return
        const result = await this.#instanceReady(
          config,
          container,
          readinessProbe,
          brickReadiness
        )
        if (!result) return
        readiness.set(config.id, result.ready)
        if (result.readyAt) readyAt.set(config.id, result.readyAt)
      })
    )

    const runtimeRecoveries = await runEffect(
      this.#runtimeRecovery.reconcile(
        discovered.map(({ config, container }) => {
          const marker = installationMarkerName(
            container.Config.Labels?.[INSTALLATION_MARKER_LABEL]
          )
          const transition = this.#powerTransitions.get(config.id)
          const ready =
            observedInstancePowerState(
              container.State,
              transition,
              now,
              readiness.get(config.id)
            ).observedState === "running"
          return {
            dockerRestartConfigured:
              container.HostConfig?.RestartPolicy?.Name !== undefined &&
              container.HostConfig.RestartPolicy.Name !== "no",
            exitCode: container.State.ExitCode,
            finishedAt: container.State.FinishedAt,
            installationReady:
              !marker ||
              existsSync(
                resolve(this.#config.rootDirectory, config.directory, marker)
              ),
            instanceId: config.id,
            managedByRelay: config.managedByRelay,
            oomKilled: container.State.OOMKilled,
            ready,
            restarting: container.State.Restarting,
            running: container.State.Running,
            service: config.service,
            startedAt: container.State.StartedAt,
            transitionActive: transition !== undefined,
          }
        })
      )
    )

    const instances = discovered.map(({ config, container }) => {
      const transition = this.#powerTransitions.get(config.id)
      const recoveryState = runtimeRecoveries.get(config.id)
      const desiredState: RelayDesiredState = recoveryState
        ? recoveryState.desiredState
        : transition
          ? transition.action === "stop" || transition.action === "kill"
            ? "stopped"
            : "running"
          : container.State.Running
            ? "running"
            : "stopped"
      const inspectedPowerState = observedInstancePowerState(
        container.State,
        transition,
        now,
        readiness.get(config.id)
      )
      const powerState: ObservedInstancePowerState = recoveryState?.recovery
        ? {
            observedState:
              recoveryState.recovery.phase === "failed" ? "failed" : "starting",
            transitionComplete: inspectedPowerState.transitionComplete,
          }
        : inspectedPowerState
      if (powerState.transitionComplete) {
        this.#powerTransitions.delete(config.id)
      }
      const previousLifecycleSession = this.#lifecycleSessions.get(config.id)
      const lifecycleSession = observedLifecycleSession({
        container,
        instanceId: config.id,
        now,
        observedReadyAt: readyAt.get(config.id),
        observedState: powerState.observedState,
        previous: previousLifecycleSession,
        recovery: recoveryState?.recovery ?? null,
        transition,
      })
      if (lifecycleSession) {
        this.#lifecycleSessions.set(config.id, lifecycleSession)
        if (!sameLifecycleSession(previousLifecycleSession, lifecycleSession)) {
          lifecycleSessionUpdates.push(
            this.#persistLifecycleSession(lifecycleSession)
          )
        }
      } else if (previousLifecycleSession) {
        this.#lifecycleSessions.delete(config.id)
        lifecycleSessionUpdates.push(this.#deleteLifecycleSession(config.id))
      }
      const resources = this.#resourcesFor({ config, container })

      return {
        ...config,
        brickSupportsSrv: config.brickSupportsSrv ?? false,
        containerId: container.Id.slice(0, 12),
        desiredState,
        observedState: powerState.observedState,
        stateReason: instanceStateReason(
          container.State,
          powerState.observedState,
          readiness.get(config.id),
          recoveryState?.recovery,
          desiredState
        ),
        savedDatabaseConnections: [
          ...this.databaseConnections.saved(config.id),
        ],
        databaseConnectionWarnings: this.databaseConnections
          .issues(config.id)
          .map(
            (issue) =>
              `${issue.databaseId ?? "Database connections"}: ${issue.message}`
          ),
        recovery: recoveryState?.recovery ?? null,
        lifecycle: lifecycleSession?.events ?? [],
        status:
          recoveryStatus(recoveryState?.recovery, now) ??
          (powerState.observedState === "running"
            ? "Running"
            : powerState.observedState === "starting"
              ? "Starting"
              : powerState.observedState === "stopping"
                ? "Stopping"
                : powerState.observedState === "failed" &&
                    container.State.Running
                  ? "Unhealthy"
                  : `Exited (${container.State.ExitCode})`),
        resources,
      }
    })

    await Promise.all(lifecycleSessionUpdates)

    return instances.sort((a, b) =>
      `${a.implementation}-${a.version}`.localeCompare(
        `${b.implementation}-${b.version}`,
        undefined,
        { numeric: true }
      )
    )
  }

  async findInstance(id: string): Promise<RelayInstanceConfig | null> {
    const found = (await this.#discover()).find((item) =>
      matchesInstanceId(item.config, id)
    )
    return found?.config ?? null
  }

  async publishedHostPorts(
    protocol: "tcp" | "udp",
    range: { end: number; start: number }
  ): Promise<Set<number>> {
    const publishedPort =
      range.start === range.end
        ? `${range.start}/${protocol}`
        : `${range.start}-${range.end}/${protocol}`
    const containers = await runEffect(
      this.#engine.listContainers({ filters: { publish: [publishedPort] } })
    )
    return new Set(
      containers.flatMap((container) =>
        (container.Ports ?? []).flatMap((port) =>
          port.Type === protocol && port.PublicPort ? [port.PublicPort] : []
        )
      )
    )
  }

  resourceHistory(instanceId: string): Array<RelayInstanceResources> {
    const history = this.#resourceHistory.get(instanceId) ?? []
    const cutoff = Date.now() - RESOURCE_HISTORY_WINDOW_MS
    return history.filter((sample) => Date.parse(sample.sampledAt) >= cutoff)
  }

  async recordProvisionedState(
    instanceId: string,
    desiredState: RelayDesiredState
  ): Promise<void> {
    await runEffect(
      this.#runtimeRecovery.recordProvisioned(instanceId, desiredState)
    )
  }

  async forgetRecoveryState(instanceId: string): Promise<void> {
    this.#lifecycleSessions.delete(instanceId)
    await Promise.all([
      runEffect(this.#runtimeRecovery.forget(instanceId)),
      this.#deleteLifecycleSession(instanceId),
      this.databaseConnections.forgetInstance(instanceId),
    ])
  }

  async databaseConnectionSnapshots(): Promise<
    Array<DatabaseConnectionSnapshot>
  > {
    return (await this.#discover())
      .filter(({ config }) => config.managedByRelay)
      .map(({ config, container }) => ({
        instanceId: config.id,
        service: config.service,
        labels: container.Config.Labels ?? {},
        networks: Object.keys(container.NetworkSettings?.Networks ?? {}),
      }))
  }

  async webRouteLabelSnapshots(): Promise<Array<RelayWebRouteLabelSnapshot>> {
    return (await this.#discover()).map(({ config, container }) => ({
      instanceId: config.id,
      labels: container.Config.Labels ?? {},
      service: config.service,
    }))
  }

  async runAction(
    instance: RelayInstanceConfig,
    action: InstancePowerAction
  ): Promise<RelayInstance> {
    if (
      instance.managedByRelay &&
      (action === "start" || action === "restart")
    ) {
      await this.databaseConnections.reconcile(instance.id, instance.service)
    }
    const discovered = await this.#findDiscovered(instance.id)
    await this.#initializeLifecycleSessions()
    const lifecycleSessionBeforeTransition = this.#lifecycleSessions.get(
      instance.id
    )
    const previousRecovery = instance.managedByRelay
      ? await runEffect(
          this.#runtimeRecovery.recordPowerAction(instance.id, action)
        )
      : null
    const transition: InstancePowerTransition = {
      action,
      commandCompleted: false,
      initialStartedAt: discovered.container.State.Running
        ? discovered.container.State.StartedAt
        : null,
      requestedAt: Date.now(),
    }
    this.#powerTransitions.set(instance.id, transition)
    if (action !== "start") {
      await this.#recordStoppingSession(
        instance.id,
        discovered.container,
        transition
      )
    }

    await runEffect(
      promiseEffect(async () => {
        const timeout =
          action === "start"
            ? 120_000
            : action === "restart"
              ? (INSTANCE_STOP_TIMEOUT_SECONDS + 60) * 1_000
              : (INSTANCE_STOP_TIMEOUT_SECONDS + 15) * 1_000
        if (instance.managedByRelay) {
          const engine = this.#engine
          await runEffect(
            Effect.gen(function* () {
              yield* engine.setRestartPolicy(instance.service, "no")
              const options = {
                seconds: INSTANCE_STOP_TIMEOUT_SECONDS,
                timeout,
              }
              yield* action === "start"
                ? engine.startContainer(instance.service, { timeout })
                : action === "stop"
                  ? engine.stopContainer(instance.service, options)
                  : action === "restart"
                    ? engine.restartContainer(instance.service, options)
                    : engine.killContainer(instance.service, { timeout })
            })
          )
        } else {
          const common = this.#composeArguments()
          const actionArguments =
            action === "start"
              ? ["up", "--detach", "--no-deps", instance.service]
              : action === "stop" || action === "restart"
                ? [
                    action,
                    "--timeout",
                    String(INSTANCE_STOP_TIMEOUT_SECONDS),
                    instance.service,
                  ]
                : [action, instance.service]

          await command("docker", [...common, ...actionArguments], {
            cwd: this.#config.projectDirectory,
            timeout,
          })
        }
      }).pipe(
        Effect.onError(() =>
          Effect.all(
            [
              Effect.sync(() => {
                if (this.#powerTransitions.get(instance.id) === transition) {
                  this.#powerTransitions.delete(instance.id)
                }
              }),
              instance.managedByRelay
                ? this.#runtimeRecovery
                    .restore(instance.id, previousRecovery)
                    .pipe(Effect.ignore)
                : Effect.void,
              action !== "start"
                ? promiseEffect(() =>
                    this.#restoreLifecycleSession(
                      instance.id,
                      lifecycleSessionBeforeTransition
                    )
                  ).pipe(Effect.ignore)
                : Effect.void,
            ],
            { discard: true }
          )
        )
      )
    )

    if (this.#powerTransitions.get(instance.id) === transition) {
      this.#powerTransitions.set(instance.id, {
        ...transition,
        commandCompleted: true,
      })
    }

    const current = await this.inspectInstances()
    const updated = current.find((item) => item.id === instance.id)
    if (!updated) throw new Error(`Instance ${instance.id} disappeared`)
    return updated
  }

  async recreateOwnedInstance(
    instance: RelayInstanceConfig,
    routeLabels: Readonly<Record<string, string>>,
    edgeNetwork: string | null,
    action: "start" | "restart" | "stop",
    portConfiguration?: DockerPortConfiguration
  ): Promise<RelayInstance> {
    if (!instance.managedByRelay) {
      throw new Error("Relay can only recreate containers it created")
    }

    const current = await runEffect(
      this.#engine.inspectContainer<DockerRecreateInspect>(instance.service)
    )

    const labels = { ...current.Config.Labels }
    for (const label of Object.keys(labels)) {
      if (
        label.startsWith("traefik.http.") ||
        label === "traefik.enable" ||
        label === "traefik.docker.network" ||
        label.startsWith(WEB_ROUTE_LABEL_PREFIX)
      ) {
        delete labels[label]
      }
    }
    Object.assign(labels, routeLabels)
    for (const label of Object.keys(labels)) {
      if (label.startsWith(DATABASE_CONNECTION_LABEL_PREFIX))
        delete labels[label]
    }
    Object.assign(labels, await this.databaseConnections.labels(instance.id))
    if (portConfiguration) {
      for (const label of Object.keys(labels)) {
        if (isManagedPortLabel(label)) delete labels[label]
      }
      Object.assign(labels, portConfiguration.labels)
    }

    const primaryNetwork = Object.hasOwn(
      current.NetworkSettings?.Networks ?? {},
      this.#resources.gameNetwork
    )
      ? this.#resources.gameNetwork
      : current.HostConfig.NetworkMode
    if (!primaryNetwork || primaryNetwork === "default") {
      throw new Error(
        `Relay cannot safely recreate ${instance.name} without its primary Docker network`
      )
    }

    const exposedPorts =
      portConfiguration === undefined
        ? current.Config.ExposedPorts
        : Object.fromEntries(
            Object.keys(portConfiguration.bindings).map((binding) => [
              binding,
              {},
            ])
          )
    const portBindings =
      portConfiguration === undefined
        ? current.HostConfig.PortBindings
        : portConfiguration.bindings
    const runtimeRecovery = this.#runtimeRecovery
    const previousRecovery = await runEffect(
      runtimeRecovery.recordPowerAction(instance.id, action)
    )
    const transition: InstancePowerTransition = {
      action,
      commandCompleted: false,
      initialStartedAt: current.State.Running ? current.State.StartedAt : null,
      requestedAt: Date.now(),
    }
    this.#powerTransitions.set(instance.id, transition)
    const backupName = `${instance.service}-kiln-backup-${Date.now()}`
    const engine = this.#engine
    let replacementCreated = false
    await runEffect(
      Effect.gen(function* () {
        if (current.State.Running) {
          yield* engine.stopContainer(instance.service, {
            seconds: INSTANCE_STOP_TIMEOUT_SECONDS,
            timeout: (INSTANCE_STOP_TIMEOUT_SECONDS + 15) * 1_000,
          })
        }
        yield* engine.renameContainer(instance.service, backupName)
      }).pipe(
        Effect.onError(() =>
          Effect.all(
            [
              Effect.sync(() => {
                if (this.#powerTransitions.get(instance.id) === transition) {
                  this.#powerTransitions.delete(instance.id)
                }
              }),
              runtimeRecovery
                .restore(instance.id, previousRecovery)
                .pipe(Effect.ignore),
            ],
            { discard: true }
          )
        )
      )
    )

    const clearTransition = () => {
      if (this.#powerTransitions.get(instance.id) === transition) {
        this.#powerTransitions.delete(instance.id)
      }
    }
    await runEffect(
      promiseEffect(async () => {
        await runEffect(
          engine.createContainer(instance.service, {
            ...current.Config,
            ExposedPorts: exposedPorts,
            HostConfig: {
              ...current.HostConfig,
              NetworkMode: primaryNetwork,
              PortBindings: portBindings,
              RestartPolicy: { Name: "no" },
            },
            Labels: labels,
            NetworkingConfig: {
              EndpointsConfig: {
                [primaryNetwork]: {
                  Aliases: recreatedNetworkAliases(
                    current.NetworkSettings?.Networks?.[primaryNetwork]
                      ?.Aliases,
                    instance.service
                  ),
                },
              },
            },
          })
        )
        replacementCreated = true
        const secondaryNetworks = portConfiguration
          ? Object.keys(current.NetworkSettings?.Networks ?? {}).filter(
              (network) =>
                network !== primaryNetwork &&
                !this.databaseConnections.isDatabaseNetwork(network)
            )
          : edgeNetwork
            ? [edgeNetwork]
            : []
        for (const network of new Set(secondaryNetworks)) {
          await runEffect(
            engine.connectNetwork(network, instance.service, {
              aliases: recreatedNetworkAliases(
                current.NetworkSettings?.Networks?.[network]?.Aliases,
                instance.service
              ),
            })
          )
        }
        await this.databaseConnections.reconcile(instance.id, instance.service)
        if (action !== "stop") {
          await runEffect(
            engine.startContainer(instance.service, { timeout: 120_000 })
          )
        }
        if (this.#powerTransitions.get(instance.id) === transition) {
          this.#powerTransitions.set(instance.id, {
            ...transition,
            commandCompleted: true,
          })
        }
      }).pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            if (replacementCreated) {
              yield* engine
                .removeContainer(instance.service, { force: true })
                .pipe(Effect.ignore)
            }
            yield* engine
              .renameContainer(backupName, instance.service)
              .pipe(Effect.ignore)
            if (current.State.Running) {
              yield* engine
                .startContainer(instance.service, { timeout: 120_000 })
                .pipe(Effect.ignore)
            }
            yield* Effect.sync(clearTransition)
            yield* runtimeRecovery
              .restore(instance.id, previousRecovery)
              .pipe(Effect.ignore)
            return yield* Effect.fail(
              new Error(
                `Kiln could not ${portConfiguration ? "apply port allocations to" : "apply web routes to"} ${instance.name}; the previous container was restored.`,
                { cause }
              )
            )
          })
        )
      )
    )
    await runEffect(
      engine.removeContainer(backupName, { force: true, timeout: 90_000 }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            console.warn(
              `Kiln ${portConfiguration ? "applied port allocations to" : "applied web routes to"} ${instance.name}, but could not remove backup container ${backupName}.`,
              cause
            )
          })
        )
      )
    )

    const updated = (await this.inspectInstances()).find(
      (item) => item.id === instance.id
    )
    if (!updated) throw new Error(`Instance ${instance.id} disappeared`)
    return updated
  }

  async console(
    instance: RelayInstanceConfig,
    limit = 2_000
  ): Promise<RelayConsole> {
    const session = await this.consoleSession(instance.id)
    return session.history(limit)
  }

  async consoleSession(
    instanceId: string,
    signal?: AbortSignal
  ): Promise<DockerConsoleSession> {
    const discovered = await this.#findDiscovered(instanceId, signal)
    const targets = await this.#consoleTargets(
      discovered.config,
      discovered,
      signal
    )
    return this.#consoleSessionFor(
      discovered.config.id,
      discovered.container,
      targets
    )
  }

  // The console of any one container, such as a database's, read the same
  // way as a server's.
  async containerConsoleSession(
    resourceId: string,
    containerId: string,
    signal?: AbortSignal
  ): Promise<DockerConsoleSession> {
    const container = await Effect.runPromise(
      this.#engine.inspectContainer<DockerInspect>(containerId),
      { signal }
    )
    return this.#consoleSessionFor(resourceId, container, [
      { component: null, container },
    ])
  }

  // `container` is the one whose start begins the session.
  #consoleSessionFor(
    resourceId: string,
    container: DockerInspect,
    targets: ReadonlyArray<ConsoleTarget>
  ): DockerConsoleSession {
    return {
      history: (limit = 2_000, historySignal) =>
        this.#consoleHistory(
          resourceId,
          container,
          targets,
          limit,
          historySignal
        ),
      stream: (signal, limit = 200) =>
        this.#streamConsoleTargets(
          targets.map((target) => ({
            component: target.component,
            id: target.container.Id,
            since: logsSince(target.container.State.StartedAt),
            tty: target.container.Config.Tty ?? false,
          })),
          signal,
          limit
        ),
    }
  }

  async #consoleHistory(
    resourceId: string,
    container: DockerInspect,
    targets: ReadonlyArray<ConsoleTarget>,
    limit: number,
    signal?: AbortSignal
  ): Promise<RelayConsole> {
    const boundedLimit = Math.min(
      Math.max(limit, 100),
      MAX_CONSOLE_HISTORY_LINES
    )
    const startedAt = consoleStartedAt(container)
    let cut = false
    const results = await Promise.all(
      targets.map(async (target) => {
        // Read as it arrives, keeping the newest output within the limit,
        // rather than buffering output of any size.
        const kept: Array<{ characters: number; line: ParsedConsoleLine }> = []
        let characters = 0
        const limit = MAX_CONSOLE_HISTORY_CHARACTERS / targets.length
        await Effect.runPromise(
          this.#engine.containerLogLines(
            target.container.Id,
            {
              since: logsSince(target.container.State.StartedAt),
              tail: boundedLimit,
              timeout: 15_000,
              tty: target.container.Config.Tty ?? false,
            },
            (raw) => {
              const line = parseConsoleLine(raw)
              if (!line) return
              kept.push({ characters: raw.length, line })
              characters += raw.length
              while (characters > limit && kept.length > 1) {
                characters -= kept.shift()!.characters
                cut = true
              }
            }
          ),
          { signal }
        )
        return kept.map(({ line }) => prefixConsoleLine(line, target.component))
      })
    )
    const rawLines = results
      .flat()
      .sort(compareConsoleLines)
      .slice(-boundedLimit)
    const occurrences = new Map<string, number>()

    return {
      instanceId: resourceId,
      lifecycle: startedAt ? [{ state: "started", time: startedAt }] : [],
      lines: rawLines.map((line) => {
        const hash = consoleLineHash(line)
        const occurrence = occurrences.get(hash) ?? 0
        occurrences.set(hash, occurrence + 1)
        return { ...line, id: `${hash}-${occurrence}` }
      }),
      truncated: cut || rawLines.length >= boundedLimit,
    }
  }

  async consoleLog(instance: RelayInstanceConfig): Promise<DockerConsoleLog> {
    const discovered = await this.#findDiscovered(instance.id)
    const targets = await this.#consoleTargets(instance, discovered)
    const results = await Promise.all(
      targets.map(async (target) => ({
        target,
        result: await runEffect(
          this.#engine.containerLogs(target.container.Id, {
            maxBytes: MAX_SHARED_CONSOLE_BYTES + 1024,
            since: logsSince(target.container.State.StartedAt),
            timeout: 30_000,
            tty: target.container.Config.Tty ?? false,
          })
        ),
      }))
    )
    const lines = results
      .flatMap(({ result, target }) =>
        parseConsoleOutput(result).map((line) =>
          prefixConsoleLine(line, target.component)
        )
      )
      .sort(compareConsoleLines)
      .map((line) => line.text)
    const content = lines.join("\n")
    const size = Buffer.byteLength(content)
    if (size > MAX_SHARED_CONSOLE_BYTES) {
      throw new Error(
        `Console log exceeds the ${MAX_SHARED_CONSOLE_BYTES} byte sharing limit`
      )
    }
    if (!content) throw new Error("The current console session is empty")

    return {
      instanceId: instance.id,
      path: "console.log",
      content,
      size,
    }
  }

  streamConsole(
    instance: RelayInstanceConfig,
    signal: AbortSignal,
    limit = 200
  ): AsyncIterable<RelayConsoleLine> {
    const openSession = () => this.consoleSession(instance.id, signal)
    return (async function* () {
      const session = await openSession()
      yield* session.stream(signal, limit)
    })()
  }

  #streamConsoleTargets(
    targets: ReadonlyArray<LogTarget>,
    signal: AbortSignal,
    limit: number
  ): AsyncIterable<RelayConsoleLine> {
    const engine = this.#engine
    return Stream.toAsyncIterable(
      Stream.callback<RelayConsoleLine, unknown>((queue) =>
        Effect.gen(function* () {
          const boundedLimit = Math.min(
            Math.max(limit, 100),
            MAX_CONSOLE_HISTORY_LINES
          )
          const lineId = followedConsoleLineIds()

          const queueLine = (
            value: string,
            component: ConsoleTarget["component"]
          ) => {
            const parsed = parseConsoleLine(value)
            if (!parsed) return
            const prefixed = prefixConsoleLine(parsed, component)
            Queue.offerUnsafe(queue, {
              ...prefixed,
              id: lineId(prefixed),
            })
          }
          // Aborting ends the stream; closing it interrupts the requests.
          const stop = () => Queue.endUnsafe(queue)
          if (signal.aborted) return stop()
          signal.addEventListener("abort", stop, { once: true })
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => signal.removeEventListener("abort", stop))
          )
          // Each log ends when its container stops; the stream ends with all.
          yield* Effect.forEach(
            targets,
            (target) =>
              engine.containerLogLines(
                target.id,
                {
                  follow: true,
                  since: target.since,
                  tail: Math.ceil(boundedLimit / targets.length),
                  timeout: null,
                  tty: target.tty,
                },
                (line) => queueLine(line, target.component)
              ),
            { concurrency: "unbounded", discard: true }
          )
          stop()
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              Queue.failCauseUnsafe(queue, cause)
            })
          )
        )
      )
    )
  }

  async sendCommand(
    instance: RelayInstanceConfig,
    input: string
  ): Promise<void> {
    const stopCommands = await this.#consoleStopCommands(instance)
    const intentionalStop = isIntentionalServerStopCommand(stopCommands, input)
    const previousRecovery = intentionalStop
      ? await runEffect(
          this.#runtimeRecovery.recordPowerAction(instance.id, "stop")
        )
      : null
    await runEffect(
      promiseEffect(() =>
        this.#withConsoleLock(instance.id, async () => {
          const discovered = await this.#findDiscovered(instance.id)
          if (!discovered.container.State.Running) {
            throw new Error(`${instance.name} is not running`)
          }
          await this.#writeConsoleInput(discovered.container.Id, `${input}\n`)
        })
      ).pipe(
        Effect.onError(() =>
          intentionalStop
            ? this.#runtimeRecovery
                .restore(instance.id, previousRecovery)
                .pipe(Effect.ignore)
            : Effect.void
        )
      )
    )
  }

  async #consoleStopCommands(
    instance: RelayInstanceConfig
  ): Promise<ReadonlyArray<string>> {
    const bricks = this.#bricks
    return runEffect(
      resolveConsoleStopCommands({
        configured: instance.brickConsoleStopCommands,
        instanceId: instance.id,
        load: async (source) =>
          (await bricks.recipe(source, instance.brickSnapshotSha256)).console
            ?.stopCommands ?? [],
        source: instance.brickSource,
      })
    )
  }

  async completeCommand(
    instance: RelayInstanceConfig,
    input: string,
    cursor: number
  ): Promise<RelayConsoleCompletion> {
    const emptyResult: RelayConsoleCompletion = {
      instanceId: instance.id,
      supported: false,
      completedPrefix: null,
      suggestions: [],
    }
    const implementation = (instance.brickId ?? instance.implementation)
      .trim()
      .toLowerCase()
    if (!["paper", "folia", "purpur"].includes(implementation)) {
      return emptyResult
    }

    return this.#withConsoleLock(instance.id, async () => {
      const discovered = await this.#findDiscovered(instance.id)
      const { Config: containerConfig, State: state } = discovered.container
      if (
        !state.Running ||
        !containerConfig.Tty ||
        !containerConfig.OpenStdin ||
        !containerConfig.AttachStdin ||
        !containerConfig.AttachStdout
      ) {
        return emptyResult
      }

      const prefix = input.slice(0, cursor)
      const output = await this.#probeConsoleCompletion(
        discovered.container.Id,
        prefix
      )
      const completion = parseConsoleCompletion(prefix, output)
      return {
        instanceId: instance.id,
        supported: true,
        ...completion,
      }
    })
  }

  async dockerVersion(): Promise<string | null> {
    if (this.#cachedDockerVersion !== undefined) {
      return this.#cachedDockerVersion
    }
    const result = await runEffect(this.#engine.version().pipe(Effect.option))
    this.#cachedDockerVersion = Option.isSome(result)
      ? result.value.Version.trim() || null
      : null
    return this.#cachedDockerVersion
  }

  relayStartedAt(): Promise<string | null> {
    this.#relayStartedAt ??= this.#inspectRelayStartedAt()
    return this.#relayStartedAt
  }

  relaySftpPublication(port: number): Promise<RelaySftpPublication> {
    this.#relaySftpPublication ??= runEffect(
      inspectRelaySftpPublicationEffect(port, hostname(), (container) =>
        this.#engine
          .inspectContainer(container, { timeout: 2_500 })
          .pipe(Effect.map((inspected) => inspected.HostConfig))
      )
    )
    return this.#relaySftpPublication
  }

  async #inspectRelayStartedAt(): Promise<string | null> {
    return runEffect(
      this.#engine.inspectContainer(hostname(), { timeout: 2_500 }).pipe(
        Effect.map((container) => {
          const timestamp = Date.parse(container.State.StartedAt)
          return Number.isFinite(timestamp)
            ? new Date(timestamp).toISOString()
            : null
        }),
        Effect.catch(() => Effect.succeed(null))
      )
    )
  }

  async #withConsoleLock<T>(
    instanceId: string,
    action: () => Promise<T>
  ): Promise<T> {
    const previous = this.#consoleLocks.get(instanceId) ?? Promise.resolve()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise
    })
    const waitForPrevious = runEffect(
      promiseEffect(() => previous).pipe(Effect.ignore)
    )
    const current = waitForPrevious.then(() => gate)
    this.#consoleLocks.set(instanceId, current)
    await waitForPrevious
    return runEffect(
      promiseEffect(action).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            release()
            if (this.#consoleLocks.get(instanceId) === current) {
              this.#consoleLocks.delete(instanceId)
            }
          })
        )
      )
    )
  }

  async #writeConsoleInput(containerId: string, input: string): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const attachPath = `/containers/${encodeURIComponent(containerId)}/attach?stream=1&stdin=1&stdout=0&stderr=0`
      const attachRequest = request({
        socketPath: this.#config.dockerSocket,
        path: attachPath,
        method: "POST",
        headers: { Connection: "Upgrade", Upgrade: "tcp" },
      })
      let settled = false
      const settle = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) rejectPromise(error)
        else resolvePromise()
      }
      const timer = setTimeout(() => {
        attachRequest.destroy(new Error("Docker attach timed out"))
      }, 5_000)

      attachRequest.on("upgrade", (_response, socket) => {
        socket.write(input, (error) => {
          if (error) {
            socket.destroy()
            settle(error)
            return
          }
          setTimeout(() => {
            socket.destroy()
            settle()
          }, 30)
        })
      })
      attachRequest.on("response", (response) => {
        response.resume()
        settle(
          new Error(`Docker attach returned HTTP ${response.statusCode ?? 500}`)
        )
      })
      attachRequest.on("error", (error) => settle(error))
      attachRequest.end()
    })
  }

  async #ensureConsoleSize(container: DockerInspect): Promise<void> {
    const { Id: containerId, Config: config, State: state } = container
    if (!state.Running || !config.Tty) return
    if (this.#consoleSizeStarts.get(containerId) === state.StartedAt) return

    const pending = this.#consoleSizePending.get(containerId)
    if (pending) {
      await pending
      if (this.#consoleSizeStarts.get(containerId) === state.StartedAt) return
    }

    const resize = ensuringPromise(
      async () => {
        await this.#resizeConsole(containerId)
        this.#consoleSizeStarts.set(containerId, state.StartedAt)
      },
      () => this.#consoleSizePending.delete(containerId)
    )
    this.#consoleSizePending.set(containerId, resize)
    await resize
  }

  async #resizeConsole(containerId: string): Promise<void> {
    await runEffect(
      this.#engine.resizeContainer(containerId, {
        columns: CONSOLE_TTY_COLUMNS,
        rows: CONSOLE_TTY_ROWS,
      })
    )
  }

  async #probeConsoleCompletion(
    containerId: string,
    prefix: string
  ): Promise<string> {
    return new Promise<string>((resolvePromise, rejectPromise) => {
      const attachPath = `/containers/${encodeURIComponent(containerId)}/attach?stream=1&stdin=1&stdout=1&stderr=1`
      const attachRequest = request({
        socketPath: this.#config.dockerSocket,
        path: attachPath,
        method: "POST",
        headers: { Connection: "Upgrade", Upgrade: "tcp" },
      })
      let output = ""
      let capturing = false
      let settled = false
      let attachReadyTimer: ReturnType<typeof setTimeout> | null = null
      let clearLineTimer: ReturnType<typeof setTimeout> | null = null
      let quietTimer: ReturnType<typeof setTimeout> | null = null
      let hardTimer: ReturnType<typeof setTimeout> | null = null
      const requestTimer = setTimeout(() => {
        attachRequest.destroy(new Error("Docker completion attach timed out"))
      }, 5_000)

      const settle = (value: string, error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(requestTimer)
        if (attachReadyTimer) clearTimeout(attachReadyTimer)
        if (clearLineTimer) clearTimeout(clearLineTimer)
        if (quietTimer) clearTimeout(quietTimer)
        if (hardTimer) clearTimeout(hardTimer)
        if (error) rejectPromise(error)
        else resolvePromise(value)
      }

      attachRequest.on("upgrade", (_response, socket) => {
        clearTimeout(requestTimer)
        const finish = () => {
          if (settled) return
          capturing = false
          socket.write("\u0015")
          setTimeout(() => {
            socket.destroy()
            settle(output)
          }, 20)
        }
        socket.on("data", (chunk: Buffer) => {
          if (!capturing) return
          output += chunk.toString("utf8")
          if (output.length >= 65_536) {
            output = output.slice(0, 65_536)
            finish()
            return
          }
          if (quietTimer) clearTimeout(quietTimer)
          quietTimer = setTimeout(finish, 120)
        })
        socket.on("error", (error) => settle("", error))
        // Docker reports the upgraded attach socket before the container TTY is
        // ready to consume input. Paper silently drops a probe sent immediately.
        attachReadyTimer = setTimeout(() => {
          if (settled) return
          socket.write("\u0015", (clearError) => {
            if (clearError) settle("", clearError)
          })
          clearLineTimer = setTimeout(() => {
            if (settled) return
            output = ""
            capturing = true
            socket.write(`${prefix}\t`, (error) => {
              if (error) settle("", error)
            })
            hardTimer = setTimeout(finish, 800)
          }, 25)
        }, 50)
      })
      attachRequest.on("response", (response) => {
        response.resume()
        settle(
          "",
          new Error(`Docker attach returned HTTP ${response.statusCode ?? 500}`)
        )
      })
      attachRequest.on("error", (error) => settle("", error))
      attachRequest.end()
    })
  }

  async #instanceReady(
    instance: RelayInstanceConfig,
    container: DockerInspect,
    probe: InstanceReadinessProbe,
    brickReadiness: BrickReadiness | undefined
  ): Promise<InstanceReadiness | undefined> {
    if (brickReadiness) {
      return this.#startupLogReady(brickReadiness, container, probe)
    }
    const ready = await this.#primaryPortReady(instance, container)
    return ready === undefined ? undefined : { ready }
  }

  async #startupLogReady(
    readiness: BrickReadiness,
    container: DockerInspect,
    probe: InstanceReadinessProbe
  ): Promise<InstanceReadiness | undefined> {
    const historical = probe === "historical"
    const logWindow = historical
      ? historicalReadinessLogWindow(container.State.StartedAt)
      : {
          since: logsSince(container.State.StartedAt),
          tail: STARTUP_READINESS_LOG_LINES,
        }
    return runEffect(
      this.#engine
        .containerLogs(container.Id, {
          ...logWindow,
          timeout: historical ? 15_000 : 2_000,
          tty: container.Config.Tty ?? false,
        })
        .pipe(
          Effect.map((result) => {
            const match = matchingReadyLogLine(
              parseConsoleOutput(result),
              readiness.logs
            )
            return match
              ? {
                  ready: true,
                  readyAt: match.timestamp ?? new Date().toISOString(),
                }
              : { ready: false }
          }),
          Effect.catch(() => Effect.succeed(undefined))
        )
    )
  }

  async #primaryPortReady(
    instance: RelayInstanceConfig,
    container: DockerInspect
  ): Promise<boolean | undefined> {
    const protocol =
      instance.brickPrimaryPortProtocol ??
      (instance.brickNetworkMode === "minecraft-backend" ? "tcp" : undefined)
    const port = instance.brickPrimaryPort
    if ((protocol !== "tcp" && protocol !== "both") || !port) return undefined

    const addresses = Object.values(
      container.NetworkSettings?.Networks ?? {}
    ).flatMap(({ IPAddress: address }) => (address ? [address] : []))
    const minecraft = instance.brickNetworkMode === "minecraft-backend"
    const probe = minecraft ? minecraftStatusReady : tcpPortOpen
    const attempts = await Promise.all(
      addresses.map((address) => probe(address, port))
    )
    if (attempts.some(Boolean)) return true

    if (minecraft) {
      const ready = await minecraftStatusReadyInContainer(
        this.#engine,
        container.Id,
        port
      )
      if (ready !== undefined) return ready
    }
    const listening = await containerPortListening(
      this.#engine,
      container.Id,
      port
    )
    return listening ?? (attempts.length > 0 ? false : undefined)
  }

  async #initializeLifecycleSessions(): Promise<void> {
    this.#lifecycleSessionsInitialization ??= runEffect(
      this.#state.listLifecycleSessions()
    ).then((sessions) => {
      for (const session of sessions) {
        this.#lifecycleSessions.set(session.instanceId, session)
      }
    })
    await this.#lifecycleSessionsInitialization
  }

  #persistLifecycleSession(
    session: RelayStoredLifecycleSession
  ): Promise<void> {
    return runEffect(this.#state.setLifecycleSession(session))
  }

  async #recordStoppingSession(
    instanceId: string,
    container: DockerInspect,
    transition: InstancePowerTransition
  ): Promise<void> {
    const session = observedLifecycleSession({
      container,
      instanceId,
      now: transition.requestedAt,
      observedReadyAt: undefined,
      observedState: "stopping",
      previous: this.#lifecycleSessions.get(instanceId),
      recovery: null,
      transition,
    })
    if (!session) return
    this.#lifecycleSessions.set(instanceId, session)
    await this.#persistLifecycleSession(session)
  }

  async #restoreLifecycleSession(
    instanceId: string,
    session: RelayStoredLifecycleSession | undefined
  ): Promise<void> {
    if (session) {
      this.#lifecycleSessions.set(instanceId, session)
      await this.#persistLifecycleSession(session)
      return
    }
    this.#lifecycleSessions.delete(instanceId)
    await this.#deleteLifecycleSession(instanceId)
  }

  #deleteLifecycleSession(instanceId: string): Promise<void> {
    return runEffect(this.#state.deleteLifecycleSession(instanceId))
  }

  async #brickReadiness(
    instance: RelayInstanceConfig
  ): Promise<BrickReadiness | undefined> {
    if (instance.brickReadiness) return instance.brickReadiness
    const cached = this.#brickReadinessCache.get(instance.id)
    if (cached !== undefined) return cached ?? undefined
    const bricks = this.#bricks
    const source = instance.brickSource
    if (!source) {
      this.#brickReadinessCache.set(instance.id, null)
      return undefined
    }

    const readiness = await runEffect(
      promiseEffect(
        async () =>
          (await bricks.recipe(source, instance.brickSnapshotSha256)).readiness
      ).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not recover legacy Brick readiness", {
            cause,
            instanceId: instance.id,
            source,
          }).pipe(Effect.as(undefined))
        )
      )
    )
    this.#brickReadinessCache.set(instance.id, readiness ?? null)
    return readiness
  }

  #resourcesFor(instance: DiscoveredInstance): RelayInstanceResources | null {
    const key = instance.container.Id
    const now = Date.now()
    const cached = this.#resourceCache.get(key) ?? {
      lastAttempt: 0,
      pending: false,
      value: null,
    }

    if (
      instance.container.State.Running &&
      !cached.pending &&
      now - cached.lastAttempt >= 1_500
    ) {
      cached.lastAttempt = now
      cached.pending = true
      this.#resourceCache.set(key, cached)
      Effect.runFork(
        promiseEffect(() => this.#sampleResources(instance, cached.value)).pipe(
          Effect.tap((resources) =>
            Effect.sync(() => {
              cached.value = resources
              this.#recordResourceHistory(instance.config.id, resources)
            })
          ),
          // Resource sampling is observational. Keep the last healthy value so
          // a slow Docker stats response can never take down the Relay snapshot.
          Effect.ignore,
          Effect.ensuring(
            Effect.sync(() => {
              cached.lastAttempt = Date.now()
              cached.pending = false
            })
          )
        )
      )
    } else if (!instance.container.State.Running) {
      cached.value = null
      this.#resourceCache.set(key, cached)
    }

    return cached.value
  }

  async #sampleResources(
    instance: DiscoveredInstance,
    previous: RelayInstanceResources | null
  ): Promise<RelayInstanceResources> {
    const directory = resolve(
      this.#config.rootDirectory,
      instance.config.directory
    )
    const [stats, filesystem] = await Promise.all([
      this.#dockerStats(instance.container.Id),
      statfs(directory),
    ])
    const instanceStorageUsed = this.#directoryUsageFor(instance)
    const cpuCurrent = stats.cpu_stats?.cpu_usage?.total_usage ?? 0
    const cpuPrevious = stats.precpu_stats?.cpu_usage?.total_usage ?? 0
    const systemCurrent = stats.cpu_stats?.system_cpu_usage ?? 0
    const systemPrevious = stats.precpu_stats?.system_cpu_usage ?? 0
    const cpuDelta = cpuCurrent - cpuPrevious
    const systemDelta = systemCurrent - systemPrevious
    const onlineCpus = Math.max(stats.cpu_stats?.online_cpus ?? 1, 1)
    const cpuCapacityPercent = onlineCpus * 100
    const cpuPercent =
      cpuDelta > 0 && systemDelta > 0
        ? (cpuDelta / systemDelta) * onlineCpus * 100
        : 0

    const memoryTotal = Math.max(
      instance.config.limits.memoryBytes || stats.memory_stats?.limit || 0,
      0
    )
    const memoryCache = Math.max(
      stats.memory_stats?.stats?.total_inactive_file ??
        stats.memory_stats?.stats?.inactive_file ??
        0,
      0
    )
    const memoryUsed = Math.max(
      Math.min((stats.memory_stats?.usage ?? 0) - memoryCache, memoryTotal),
      0
    )
    const nodeStorageTotal = filesystem.blocks * filesystem.bsize
    const nodeStorageAvailable = filesystem.bavail * filesystem.bsize
    const nodeStorageUsed = Math.max(nodeStorageTotal - nodeStorageAvailable, 0)
    const storageLimit = instance.config.limits.diskBytes
    const network = Object.values(stats.networks ?? {}).reduce(
      (total, current) => ({
        receivedBytes: total.receivedBytes + (current.rx_bytes ?? 0),
        sentBytes: total.sentBytes + (current.tx_bytes ?? 0),
      }),
      { receivedBytes: 0, sentBytes: 0 }
    )
    const sampledAt = Date.now()
    const previousSampledAt = previous
      ? Date.parse(previous.sampledAt)
      : Number.NaN
    const elapsedSeconds = Number.isFinite(previousSampledAt)
      ? Math.max((sampledAt - previousSampledAt) / 1_000, 0)
      : 0
    const receivedBytesPerSecond =
      previous?.network && elapsedSeconds > 0
        ? Math.max(
            (network.receivedBytes - previous.network.receivedBytes) /
              elapsedSeconds,
            0
          )
        : 0
    const sentBytesPerSecond =
      previous?.network && elapsedSeconds > 0
        ? Math.max(
            (network.sentBytes - previous.network.sentBytes) / elapsedSeconds,
            0
          )
        : 0

    return {
      sampledAt: new Date(sampledAt).toISOString(),
      cpu: {
        capacityPercent: cpuCapacityPercent,
        percent: roundPercent(cpuPercent),
      },
      memory: {
        totalBytes: memoryTotal,
        usedBytes: memoryUsed,
        percent: roundPercent(percentOf(memoryUsed, memoryTotal)),
      },
      storage: {
        totalBytes: storageLimit,
        usedBytes: instanceStorageUsed,
        percent:
          instanceStorageUsed === null
            ? null
            : roundPercent(percentOf(instanceStorageUsed, storageLimit)),
        nodeTotalBytes: nodeStorageTotal,
        nodeUsedBytes: nodeStorageUsed,
        nodePercent: roundPercent(percentOf(nodeStorageUsed, nodeStorageTotal)),
      },
      network: {
        ...network,
        receivedBytesPerSecond,
        sentBytesPerSecond,
      },
    }
  }

  #directoryUsageFor(instance: DiscoveredInstance): number | null {
    const now = Date.now()
    const cached =
      this.#diskUsageCache.get(instance.config.id) ??
      initialDiskUsageCacheEntry()
    if (!cached.pending && now - cached.lastAttempt >= DISK_USAGE_REFRESH_MS) {
      cached.lastAttempt = now
      cached.pending = true
      this.#diskUsageCache.set(instance.config.id, cached)
      const directory = resolve(
        this.#config.rootDirectory,
        instance.config.directory
      )
      const findCurrent = () => this.#findDiscovered(instance.config.id)
      const engine = this.#engine
      const refresh = Effect.gen(function* () {
        const usedBytes = yield* directoryApparentSizeEffect(directory)
        cached.usedBytes = usedBytes
        const current = yield* promiseEffect(findCurrent).pipe(
          Effect.catch(() => Effect.succeed(null))
        )
        if (
          current &&
          diskQuotaExceeded(
            usedBytes,
            current.config.limits.diskBytes,
            current.container.State.Running
          )
        ) {
          yield* Effect.sync(() => {
            console.warn(
              `Stopping ${current.config.name}: disk usage exceeded its configured quota`
            )
          })
          yield* engine.stopContainer(current.config.service, {
            seconds: INSTANCE_STOP_TIMEOUT_SECONDS,
            timeout: (INSTANCE_STOP_TIMEOUT_SECONDS + 15) * 1_000,
          })
        }
      }).pipe(
        // Keep the last healthy value. Directory scans race with normal game
        // writes and should never make resource sampling fail.
        Effect.catch(() => Effect.void),
        Effect.ensuring(
          Effect.sync(() => {
            cached.lastAttempt = Date.now()
            cached.pending = false
          })
        )
      )
      Effect.runFork(this.#diskUsageSemaphore.withPermits(1)(refresh))
    }
    return cached.usedBytes
  }

  #recordResourceHistory(
    instanceId: string,
    resources: RelayInstanceResources
  ): void {
    const timestamp = Date.parse(resources.sampledAt)
    const cutoff = timestamp - RESOURCE_HISTORY_WINDOW_MS
    const history = this.#resourceHistory.get(instanceId) ?? []
    this.#resourceHistory.set(
      instanceId,
      [...history, resources].filter(
        (sample) => Date.parse(sample.sampledAt) >= cutoff
      )
    )
  }

  async #dockerStats(containerId: string): Promise<DockerStats> {
    return (await runEffect(
      this.#engine.containerStats(containerId)
    )) as DockerStats
  }

  async #findDiscovered(
    id: string,
    signal?: AbortSignal
  ): Promise<DiscoveredInstance> {
    const found = (await this.#discover(signal)).find((item) =>
      matchesInstanceId(item.config, id)
    )
    if (!found) throw new Error(`Instance ${id} is no longer managed by Kiln`)
    return found
  }

  async #consoleTargets(
    instance: RelayInstanceConfig,
    discovered: DiscoveredInstance,
    signal?: AbortSignal
  ): Promise<Array<ConsoleTarget>> {
    if (instance.brickId !== builtinTailscaleBrickId) {
      return [{ component: null, container: discovered.container }]
    }
    const companionName = this.#resources.tailscaleStackDnsContainer(
      instance.id
    )
    const companion = await Effect.runPromise(
      this.#engine
        .inspectContainer<DockerInspect>(companionName)
        .pipe(Effect.catch(() => Effect.succeed(null))),
      { signal }
    )
    return [
      { component: "tailscale", container: discovered.container },
      ...(companion
        ? [{ component: "coredns" as const, container: companion }]
        : []),
    ]
  }

  // Runs on every snapshot: one listing, then one inspect per server, all on
  // the Docker socket.
  async #discover(signal?: AbortSignal): Promise<Array<DiscoveredInstance>> {
    const engine = this.#engine
    const config = this.#config
    const containers = await Effect.runPromise(
      Effect.gen(function* () {
        const listed = yield* engine.listContainers({
          all: true,
          filters: { label: [config.managedLabel] },
        })
        const ids = listed.flatMap((container) =>
          container.Labels?.["kiln.resource.kind"] !== "database" &&
          relayOwnsLabels(config, container.Labels)
            ? [container.Id]
            : []
        )
        return yield* engine.inspectContainers<DockerInspect>(ids)
      }).pipe(
        // One budget for the whole listing, as `docker inspect a b c` had.
        Effect.timeoutOrElse({
          duration: DISCOVERY_TIMEOUT_MS,
          orElse: () =>
            Effect.fail(
              new DockerEngineError({
                operation: "discover containers",
                reason: `Docker did not list Kiln's containers within ${DISCOVERY_TIMEOUT_MS} ms`,
              })
            ),
        })
      ),
      { signal }
    )
    if (containers.length === 0) return []
    const diskLimitCandidates = containers.map((container) => ({
      configuredLimitBytes: optionalNonnegativeIntegerLabel(
        container.Config.Labels?.["kiln.instance.disk-bytes"]
      ),
      id:
        container.Config.Labels?.[this.#config.serverIdLabel]?.toLowerCase() ??
        container.Id,
    }))
    const hasLegacyDiskLimit = diskLimitCandidates.some(
      ({ configuredLimitBytes }) =>
        configuredLimitBytes === null || configuredLimitBytes === 0
    )
    const filesystem = hasLegacyDiskLimit
      ? await statfs(this.#config.rootDirectory)
      : null
    const diskLimits = legacyDiskLimitAssignments(
      diskLimitCandidates,
      filesystem
        ? filesystem.blocks * filesystem.bsize
        : Number.MAX_SAFE_INTEGER
    )
    const discovered = containers.map((container) => ({
      container,
      config: this.#instanceConfig(
        container,
        diskLimits.get(
          container.Config.Labels?.[
            this.#config.serverIdLabel
          ]?.toLowerCase() ?? container.Id
        ) ?? DEFAULT_INSTANCE_DISK_LIMIT_BYTES
      ),
    }))
    const fullIds = new Set<string>()
    const shortIds = new Set<string>()
    for (const { config } of discovered) {
      if (fullIds.has(config.id)) {
        throw new Error(`Duplicate kiln.server.id ${config.id}`)
      }
      if (shortIds.has(config.shortId)) {
        throw new Error(
          `The first 8 characters of kiln.server.id must be unique; ${config.shortId} is duplicated`
        )
      }
      fullIds.add(config.id)
      shortIds.add(config.shortId)
    }
    return discovered
  }

  #instanceConfig(
    container: DockerInspect,
    diskLimitBytes: number
  ): RelayInstanceConfig {
    const labels = container.Config.Labels ?? {}
    const configuredMount = labels["kiln.instance.mount"]
    const serverMount = container.Mounts.find(
      (mount) =>
        (mount.Destination === configuredMount ||
          mount.Destination === "/server" ||
          mount.Destination === "/data") &&
        mount.RW
    )
    if (!serverMount) {
      throw new Error(`${container.Name} has no writable /server bind mount`)
    }

    const directory = resolve(serverMount.Source)
    const owned = labels["kiln.relay.owned"] === "true"
    const ownedDirectory = labels["kiln.instance.directory"]
    const usesOwnedDirectory = Boolean(
      owned && ownedDirectory && /^[a-f0-9]{40}$/iu.test(ownedDirectory)
    )
    let relativeDirectory =
      usesOwnedDirectory && ownedDirectory
        ? ownedDirectory
        : relative(this.#config.rootDirectory, directory)
    if (
      !usesOwnedDirectory &&
      (!relativeDirectory ||
        relativeDirectory.startsWith("..") ||
        resolve(this.#config.rootDirectory, relativeDirectory) !== directory)
    ) {
      const mountedDirectory = basename(directory)
      if (!existsSync(resolve(this.#config.rootDirectory, mountedDirectory))) {
        throw new Error(
          `${container.Name} mounts a directory outside the Relay data directory`
        )
      }
      relativeDirectory = mountedDirectory
    }
    const directoryName = basename(directory)
    const name = labels["kiln.instance.name"] ?? directoryName
    const parsed = name.match(/^([a-z][a-z0-9-]*)-(\d.*)$/u)
    const brickId = labels["kiln.brick.id"]
    const validBrickId =
      brickId && /^[a-z0-9][a-z0-9.-]{0,63}$/u.test(brickId)
        ? brickId
        : undefined
    const validNetworkMode = normalizedBrickNetworkMode(
      labels["kiln.brick.network-mode"]
    )
    const brickReadiness = parseBrickReadinessLabel(
      labels["kiln.brick.readiness"]
    )
    const ports = discoverPortAllocations({
      bindings: container.HostConfig?.PortBindings,
      labels,
    })
    const primaryAllocation = ports.find(
      (allocation) => allocation.kind === "primary"
    )
    const publicPort = primaryAllocation?.externalPort
    const effectivePrimaryPort = primaryAllocation?.internalPort
    const effectivePrimaryProtocol = primaryAllocation?.protocol
    const publicHost = instancePublicHost({
      discoveredPublicIp: this.#config.discoveredPublicIp,
      gameHost: this.#config.gameHost,
      instanceHost: labels["kiln.instance.public-host"],
      relayHost: this.#config.advertisedHost,
    })
    const tailscale = relayInstanceTailscaleSchema.parse({
      enabled: labels["kiln.instance.tailscale-enabled"] === "true",
      subdomain: labels["kiln.instance.tailscale-subdomain"],
    })
    const implementation = titleCase(validBrickId ?? parsed?.[1] ?? name)
    const version =
      labels["kiln.instance.version"] ??
      parsed?.[2] ??
      inferStandaloneVersion(directory, name)
    const service = owned
      ? container.Name.replace(/^\//u, "")
      : (container.Config.Labels?.["com.docker.compose.service"] ??
        container.Name.replace(/^\//u, ""))
    const imageTag =
      labels["kiln.instance.java"] ??
      container.Config.Image.split(":").at(-1) ??
      "Unknown"
    const rawId = container.Config.Labels?.[this.#config.serverIdLabel]
    if (!rawId || !/^[a-f0-9]{40}$/iu.test(rawId)) {
      throw new Error(
        `${container.Name} must have a ${this.#config.serverIdLabel} label containing 40 hexadecimal characters`
      )
    }
    const id = rawId.toLowerCase()
    return {
      brickFormat: labels["kiln.brick.format"],
      brickId: validBrickId,
      brickConsoleStopCommands: parseBrickConsoleStopCommandsLabel(
        labels["kiln.brick.console-stop-commands"]
      ),
      brickNetworkMode: validNetworkMode,
      brickPrimaryPort:
        effectivePrimaryPort &&
        Number.isInteger(effectivePrimaryPort) &&
        effectivePrimaryPort >= 1 &&
        effectivePrimaryPort <= 65_535
          ? effectivePrimaryPort
          : undefined,
      brickPrimaryPortProtocol: effectivePrimaryProtocol,
      brickReadiness,
      brickSupportsSrv: labels["kiln.brick.supports-srv"] === "true",
      brickSource: labels["kiln.brick.source"],
      brickSnapshotSha256: /^[a-f0-9]{64}$/u.test(
        labels["kiln.brick.snapshot-sha256"] ?? ""
      )
        ? labels["kiln.brick.snapshot-sha256"]
        : undefined,
      connectAddress: instanceConnectAddress({
        discoveredPublicIp: this.#config.discoveredPublicIp,
        gameHost: publicHost,
        publicPort,
        relayHost: this.#config.advertisedHost,
        tailscaleHost: tailscale.enabled
          ? labels["kiln.instance.hostname"]
          : undefined,
      }),
      directory: relativeDirectory,
      game:
        labels["kiln.instance.game"] ??
        (validBrickId === "palworld" ? "Palworld" : "Minecraft"),
      id,
      implementation,
      javaVersion: imageTag,
      name,
      ports,
      publicHost,
      publicPort,
      shortId: id.slice(0, 8),
      service,
      tailscale,
      variables: parseBrickVariablesLabel(labels["kiln.brick.variables"]),
      limits: {
        diskBytes: diskLimitBytes,
        memoryBytes: Math.max(
          nonnegativeIntegerLabel(labels["kiln.instance.memory-bytes"]),
          container.HostConfig?.Memory ?? 0
        ),
      },
      version,
      managedByRelay: owned,
    }
  }

  #composeArguments(): Array<string> {
    return [
      "compose",
      "--file",
      this.#config.composeFile,
      "--project-directory",
      this.#config.projectDirectory,
      "--project-name",
      this.#config.projectName,
    ]
  }
}

function normalizedBrickNetworkMode(
  mode: string | undefined
): RelayInstanceConfig["brickNetworkMode"] {
  if (mode === "minecraft-proxy") return "minecraft-backend"
  return mode === "direct" || mode === "minecraft-backend" ? mode : undefined
}

function recreatedNetworkAliases(
  aliases: Array<string> | null | undefined,
  service: string
): Array<string> {
  return Array.from(
    new Set([
      ...(aliases ?? []).filter((alias) => !/^[a-f0-9]{12,64}$/u.test(alias)),
      service,
    ])
  )
}

function tcpPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = new Socket()
    let settled = false
    const settle = (open: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolvePromise(open)
    }
    socket.setTimeout(500)
    socket.once("connect", () => settle(true))
    socket.once("error", () => settle(false))
    socket.once("timeout", () => settle(false))
    socket.connect(port, host)
  })
}

async function containerPortListening(
  engine: DockerEngine,
  containerId: string,
  port: number
): Promise<boolean | undefined> {
  const ipv4 = await containerNetworkSockets(
    engine,
    containerId,
    "/proc/net/tcp"
  )
  if (ipv4 !== undefined && procNetTcpHasListener(ipv4, port)) return true

  const ipv6 = await containerNetworkSockets(
    engine,
    containerId,
    "/proc/net/tcp6"
  )
  if (ipv6 !== undefined && procNetTcpHasListener(ipv6, port)) return true
  return ipv4 === undefined && ipv6 === undefined ? undefined : false
}

async function containerNetworkSockets(
  engine: DockerEngine,
  containerId: string,
  path: "/proc/net/tcp" | "/proc/net/tcp6"
): Promise<string | undefined> {
  return runEffect(
    engine.exec(containerId, ["cat", path], { timeout: 2_000 }).pipe(
      Effect.map((output) => output.stdout),
      Effect.catch(() => Effect.succeed(undefined))
    )
  )
}

async function minecraftStatusReadyInContainer(
  engine: DockerEngine,
  containerId: string,
  port: number
): Promise<boolean | undefined> {
  const script = [
    "if ! command -v bash >/dev/null 2>&1; then",
    '  printf "unsupported"',
    'elif bash -c \'exec 3<>/dev/tcp/127.0.0.1/"$1" || exit 1; printf "%b" "$2" >&3 || exit 1; IFS= read -r -N 1 -t 1 response <&3; test -n "$response"\' -- "$1" "$2"; then',
    '  printf "ready"',
    "else",
    '  printf "waiting"',
    "fi",
  ].join("\n")
  return runEffect(
    engine
      .exec(
        containerId,
        [
          "sh",
          "-c",
          script,
          "--",
          String(port),
          bufferPrintfEscapes(minecraftStatusRequest(port)),
        ],
        { timeout: 2_000 }
      )
      .pipe(
        Effect.map((result) => {
          const status = result.stdout.trim()
          return status === "ready"
            ? true
            : status === "waiting"
              ? false
              : undefined
        }),
        Effect.catch(() => Effect.succeed(undefined))
      )
  )
}

function minecraftStatusReady(host: string, port: number): Promise<boolean> {
  const request = minecraftStatusRequest(port)

  return new Promise((resolvePromise) => {
    const socket = new Socket()
    let settled = false
    const settle = (ready: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolvePromise(ready)
    }
    socket.setTimeout(750)
    socket.once("connect", () => socket.write(request))
    socket.once("data", () => settle(true))
    socket.once("close", () => settle(false))
    socket.once("error", () => settle(false))
    socket.once("timeout", () => settle(false))
    socket.connect(port, host)
  })
}

function minecraftStatusRequest(port: number): Buffer {
  const address = Buffer.from("localhost")
  const handshakePayload = Buffer.concat([
    Buffer.from([0]),
    Buffer.from([0]),
    encodeVarInt(address.length),
    address,
    Buffer.from([port >> 8, port & 0xff]),
    Buffer.from([1]),
  ])
  const request = Buffer.concat([
    encodeVarInt(handshakePayload.length),
    handshakePayload,
    Buffer.from([1, 0]),
  ])
  return request
}

function bufferPrintfEscapes(value: Buffer): string {
  return [...value]
    .map((byte) => `\\x${byte.toString(16).padStart(2, "0")}`)
    .join("")
}

function encodeVarInt(value: number): Buffer {
  const bytes: Array<number> = []
  let remaining = value
  do {
    let current = remaining & 0x7f
    remaining >>>= 7
    if (remaining !== 0) current |= 0x80
    bytes.push(current)
  } while (remaining !== 0)
  return Buffer.from(bytes)
}

function matchesInstanceId(instance: RelayInstanceConfig, id: string): boolean {
  return instance.id === id || instance.shortId === id || instance.name === id
}

function parseBrickVariablesLabel(
  value: string | undefined
): Record<string, BrickVariableValue> | undefined {
  if (!value) return undefined
  return Result.try(() =>
    brickVariableValuesSchema.parse(JSON.parse(value))
  ).pipe(Result.getOrUndefined)
}

function parseBrickConsoleStopCommandsLabel(
  value: string | undefined
): ReadonlyArray<string> | undefined {
  if (!value) return undefined
  return Result.try(() => {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.length === 0
      ? []
      : brickConsoleSchema.shape.stopCommands.parse(parsed)
  }).pipe(Result.getOrUndefined)
}

function parseBrickReadinessLabel(value: string | undefined) {
  if (!value) return undefined
  return Result.try(() => brickReadinessSchema.parse(JSON.parse(value))).pipe(
    Result.getOrUndefined
  )
}

function percentOf(used: number, total: number): number {
  return total > 0 ? (used / total) * 100 : 0
}

function roundPercent(value: number): number {
  return Math.round(Math.max(value, 0) * 10) / 10
}

interface ConsoleStopCommandsInput {
  readonly configured: ReadonlyArray<string> | undefined
  readonly instanceId: string
  readonly load: (source: string) => Promise<ReadonlyArray<string>>
  readonly source: string | undefined
}

const resolveConsoleStopCommands = Effect.fn(
  "relay.console.resolveStopCommands"
)(function* ({
  configured,
  instanceId,
  load,
  source,
}: ConsoleStopCommandsInput) {
  yield* Effect.annotateCurrentSpan({ "kiln.instance_id": instanceId })
  if (configured && configured.length > 0) return configured
  if (!source) return []
  return yield* promiseEffect(() => load(source)).pipe(
    Effect.withSpan("relay.console.loadRecipeStopCommands", {
      attributes: {
        "kiln.instance_id": instanceId,
        "kiln.recipe.source": source,
      },
    }),
    Effect.catch((cause) =>
      Effect.logWarning("Could not resolve legacy container console commands", {
        cause,
        instanceId,
        recipe: source,
      }).pipe(Effect.as([]))
    )
  )
})

function observedSessionReadyAt(
  detectedReadyAt: string | undefined,
  observedDuringStartup: boolean,
  now: number
): string | null {
  if (detectedReadyAt) return detectedReadyAt
  // A rediscovered session has no trustworthy historical probe time. Keep it
  // unknown so restored console history does not place readiness at startup.
  return observedDuringStartup ? new Date(now).toISOString() : null
}

function observedLifecycleSession({
  container,
  instanceId,
  now,
  observedReadyAt,
  observedState,
  previous,
  recovery,
  transition,
}: {
  readonly container: DockerInspect
  readonly instanceId: string
  readonly now: number
  readonly observedReadyAt: string | undefined
  readonly observedState: RelayInstance["observedState"]
  readonly previous: RelayStoredLifecycleSession | undefined
  readonly recovery: RelayInstanceRecovery | null
  readonly transition: InstancePowerTransition | undefined
}): RelayStoredLifecycleSession | null {
  const startedAt = consoleStartedAt(container)
  if (!startedAt) return null

  const session: RelayStoredLifecycleSession =
    previous && lifecycleEventTime(previous.events, "started") === startedAt
      ? previous
      : {
          events: [{ state: "started", time: startedAt }],
          instanceId,
        }
  let events = session.events
  if (observedState === "running" && !lifecycleEventTime(events, "ready")) {
    const startedAtMs = Date.parse(startedAt)
    const observedDuringStartup =
      Number.isFinite(startedAtMs) &&
      now - startedAtMs < INSTANCE_STARTUP_READINESS_TIMEOUT_MS
    events = addLifecycleEvent(
      events,
      "ready",
      observedSessionReadyAt(
        observedReadyAt,
        transition !== undefined || observedDuringStartup,
        now
      )
    )
  } else if (observedReadyAt && !lifecycleEventTime(events, "ready")) {
    // Legacy stopped sessions can still recover the exact declared ready log.
    events = addLifecycleEvent(events, "ready", observedReadyAt)
  }

  if (
    !lifecycleEventTime(events, "stopping") &&
    transition &&
    (transition.action === "stop" ||
      transition.action === "restart" ||
      transition.action === "kill")
  ) {
    events = addLifecycleEvent(
      events,
      "stopping",
      new Date(transition.requestedAt).toISOString()
    )
  }

  const finishedAt = consoleFinishedAt(container)
  if (!container.State.Running && finishedAt && recovery) {
    events = addLifecycleEvent(
      events,
      recovery.reason === "clean_exit" ? "stopped" : "failed",
      finishedAt
    )
  } else if (observedState === "stopped") {
    events = addLifecycleEvent(
      events,
      "stopped",
      finishedAt ?? new Date(now).toISOString()
    )
  } else if (observedState === "failed") {
    events = addLifecycleEvent(
      events,
      "failed",
      finishedAt ?? new Date(now).toISOString()
    )
  }
  return events === session.events ? session : { ...session, events }
}

function sameLifecycleSession(
  left: RelayStoredLifecycleSession | undefined,
  right: RelayStoredLifecycleSession
): boolean {
  return (
    left?.instanceId === right.instanceId &&
    left.events.length === right.events.length &&
    left.events.every(
      (event, index) =>
        event.state === right.events[index]?.state &&
        event.time === right.events[index]?.time
    )
  )
}

function addLifecycleEvent(
  events: Array<RelayInstanceLifecycleEvent>,
  state: RelayInstanceLifecycleState,
  time: string | null
): Array<RelayInstanceLifecycleEvent> {
  return !time || lifecycleEventTime(events, state)
    ? events
    : [...events, { state, time }]
}

function historicalReadinessLogWindow(
  startedAt: string
): Pick<DockerLogOptions, "since" | "tail" | "until"> {
  const since = logsSince(startedAt)
  if (since === undefined) return { tail: MAX_CONSOLE_HISTORY_LINES }
  return {
    since,
    until: new Date(
      Date.parse(startedAt) + INSTANCE_STARTUP_READINESS_TIMEOUT_MS
    ).toISOString(),
  }
}

type InstanceReadinessProbe = "historical" | "live"

function instanceReadinessProbe({
  hasHealthCheck,
  hasLogReadiness,
  running,
  startedRecently,
  transitionAction,
}: {
  hasHealthCheck: boolean
  hasLogReadiness: boolean
  running: boolean
  startedRecently: boolean
  transitionAction: InstancePowerAction | undefined
}): InstanceReadinessProbe | null {
  if (
    !running ||
    hasHealthCheck ||
    transitionAction === "stop" ||
    transitionAction === "kill"
  ) {
    return null
  }

  if (
    startedRecently ||
    transitionAction === "start" ||
    transitionAction === "restart"
  ) {
    return "live"
  }

  // A configured startup log is historical evidence. Re-read the bounded
  // startup window once when Relay rediscovers an existing session.
  return hasLogReadiness ? "historical" : null
}

function prefixConsoleLine(
  line: ParsedConsoleLine,
  component: ConsoleTarget["component"]
): ParsedConsoleLine {
  if (!component) return line
  return {
    ...line,
    segments: undefined,
    service: component,
    text: `[${component}] ${line.text}`,
  }
}

// A console line's ID is this, numbered among the lines with the same
// timestamp and text. History reads and followed logs number lines alike, so
// hubs and pages recognize the lines they already have.
function consoleLineHash(line: ParsedConsoleLine): string {
  return createHash("sha1")
    .update(`${line.timestamp ?? ""}\u0000${line.text}`)
    .digest("hex")
    .slice(0, 14)
}

// How many lines back a followed log still numbers a repeat after the line
// it repeats. Past this, nothing recognizes the earlier line's ID any more:
// hubs keep 5,000 lines, and pages about 10,000 IDs.
const FOLLOWED_LINE_REPEAT_HORIZON = 3 * MAX_CONSOLE_HISTORY_LINES

// IDs for a followed log's lines, numbered as a history read numbers them,
// without counting every line a long-lived log has written: a line's count
// is kept while it was last seen within the horizon.
function followedConsoleLineIds(): (line: ParsedConsoleLine) => string {
  // Least recently seen first.
  const counts = new Map<string, number>()
  return (line) => {
    const hash = consoleLineHash(line)
    const count = counts.get(hash) ?? 0
    counts.delete(hash)
    counts.set(hash, count + 1)
    if (counts.size > FOLLOWED_LINE_REPEAT_HORIZON) {
      counts.delete(counts.keys().next().value!)
    }
    return `${hash}-${count}`
  }
}

function compareConsoleLines(
  left: ParsedConsoleLine,
  right: ParsedConsoleLine
): number {
  return (left.timestamp ?? "").localeCompare(right.timestamp ?? "")
}

export interface DockerConsoleLog {
  content: string
  instanceId: string
  path: "console.log"
  size: number
}

function consoleStartedAt(container: DockerInspect): string | null {
  const timestamp = Date.parse(container.State.StartedAt)
  return Number.isFinite(timestamp) && timestamp > 0
    ? container.State.StartedAt
    : null
}

function consoleFinishedAt(container: DockerInspect): string | null {
  const timestamp = Date.parse(container.State.FinishedAt)
  return Number.isFinite(timestamp) && timestamp > 0
    ? container.State.FinishedAt
    : null
}

// Logs of the current run; a container that never started has no start time.
function logsSince(startedAt: string): string | undefined {
  const timestamp = Date.parse(startedAt)
  return Number.isFinite(timestamp) && timestamp > 0 ? startedAt : undefined
}

function titleCase(value: string): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function nonnegativeIntegerLabel(value: string | undefined): number {
  return optionalNonnegativeIntegerLabel(value) ?? 0
}

function optionalNonnegativeIntegerLabel(
  value: string | undefined
): number | null {
  if (!value || !/^\d+$/u.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function inferStandaloneVersion(
  directory: string,
  implementation: string
): string {
  const escaped = implementation.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  const jarPattern = new RegExp(`^${escaped}-(.+)\\.jar$`, "iu")
  return Result.try(() => {
    for (const entry of readdirSync(directory)) {
      const version = entry.match(jarPattern)?.[1]
      if (version) return version
    }
    return "Unknown"
  }).pipe(
    // Keep discovery resilient if the mount changes after Docker inspect.
    Result.getOrElse(() => "Unknown")
  )
}

function promiseEffect<A>(run: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => cause,
  })
}

function recoveryStatus(
  recovery: RelayInstanceRecovery | null | undefined,
  now: number
): string | null {
  if (!recovery) return null
  if (recovery.phase === "failed") {
    return `Recovery stopped after ${recovery.attempt} attempt${recovery.attempt === 1 ? "" : "s"}`
  }
  if (recovery.phase === "restarting") {
    return `Restarting (${recovery.attempt}/${recovery.maxAttempts})`
  }
  const nextAttemptAt = recovery.nextAttemptAt
    ? Date.parse(recovery.nextAttemptAt)
    : now
  const seconds = Math.max(Math.ceil((nextAttemptAt - now) / 1_000), 0)
  return `Restarting in ${seconds}s (${recovery.attempt}/${recovery.maxAttempts})`
}

function isIntentionalServerStopCommand(
  stopCommands: ReadonlyArray<string>,
  input: string
): boolean {
  const normalized = input.trim()
  return stopCommands.includes(normalized)
}

function runEffect<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  return Effect.runPromise(effect)
}
