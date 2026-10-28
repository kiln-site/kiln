import { spawn } from "node:child_process"
import {
  mkdir,
  readdir,
  readFile,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises"
import { dirname, join } from "node:path"

import type {
  AppConfig,
  AppPort,
  RelayApp,
  RelayAppDeploymentLog,
  RelayAppDeploymentRead,
  RelayAppImageCheck,
  RelayAppImageCheckResult,
  RelayAppAction,
  RelayAppContainer,
  RelayAppDeployment,
  RelayAppLimits,
  RelayConsoleLevel,
  RelayConsoleLine,
  ProvisioningWorkPhase,
  RelayCreateApp,
  RelayDeleteApp,
  RelayDeployApp,
  RelayInventoryLookup,
  RelayInventoryItem,
  ResourceLimits,
  ServiceResourceLimits,
} from "@workspace/contracts"
import {
  appServiceNameSchema,
  CPU_LIMIT_MILLIS_PER_CORE,
  NO_RESOURCE_LIMITS,
  relayAppSchema,
} from "@workspace/contracts"
import { Effect, Predicate, Result } from "effect"

import { commandLines } from "./command.js"
import {
  normalizedReference,
  parseImageReference,
  repositoryName,
  type ImageReference,
} from "./docker-reference.js"
import type { RelayConfig } from "./config.js"
import { consoleLineCharacters } from "./console-frames.js"
import { parseConsoleLine } from "./console-parsing.js"
import type { DatabaseConnections } from "./database-connections.js"
import { databaseNetworkName } from "./databases.js"
import {
  MAX_CONSOLE_HISTORY_CHARACTERS,
  type DockerConsoleSession,
} from "./docker.js"
import { createContainer, ramInBytes } from "./docker-container-spec.js"
import {
  DockerEngine,
  isDockerNotFound,
  type DockerEngineError,
} from "./docker-engine.js"
import {
  ensuringPromise,
  forkPromise,
  promiseEffect,
  recoverPromise,
} from "./effect/promise.js"
import { traceRelayEffect, traceRelayPromise } from "./effect/runtime.js"
import type { RelayStateStore } from "./effect/state.js"
import {
  exclusive,
  laneKeys,
  shared,
  type OperationLanes,
} from "./operation-lanes.js"
import { appLifecycleLocks } from "./operation-plans.js"
import { provisioningStatus } from "./provisioning.js"
import {
  checkOutRepository,
  checkoutDirectory,
  checkoutFile,
} from "./repository-checkout.js"
import {
  assertResourceLimitsFit,
  containerLimitSpec,
  containerResourceLimits,
  type ResourceAllocations,
  widestResourceLimits,
} from "./resource-limits.js"
import {
  APP_SERVICE,
  relayOwnerLabel,
  relayOwnsLabels,
  relayResourceNames,
  type RelayResourceNames,
} from "./relay-resources.js"
import { appVolumeOwner, relayVolumeDockerName } from "./volumes.js"

// Apps are found by their labels, like databases: the Relay keeps nothing
// about them besides their data directory and the logs of their recent
// deployments.
const KIND_LABEL = "kiln.resource.kind"
const APP_KIND = "app"
const ID_LABEL = "kiln.app.id"
const SERVICE_LABEL = "kiln.app.service"
const DEPLOYMENT_LABEL = "kiln.app.deployment"
// The commit a GitHub deployment built.
const COMMIT_LABEL = "kiln.app.commit"
// An image app's container runs its image by digest; these keep the
// reference its config names and the digest that reference named then.
const IMAGE_LABEL = "kiln.app.image"
const IMAGE_DIGEST_LABEL = "kiln.app.image.digest"
const COMPOSE_PROJECT_LABEL = "com.docker.compose.project"
// The console stream that follows an app's deployments; its services'
// streams are `service:<name>`.
export const APP_DEPLOYMENT_STREAM = "deployment"
const SERVICE_STREAM_PREFIX = "service:"
const MAX_DEPLOYMENT_LINES = 5_000
// Finished deployments' logs kept per app, newest first.
const KEPT_DEPLOYMENTS = 20
const PULL_TIMEOUT_MS = 15 * 60_000
const BUILD_TIMEOUT_MS = 30 * 60_000
// Where the Relay image installs buildx, as a plugin Compose finds too.
const BUILDX = "/usr/local/libexec/docker/cli-plugins/docker-buildx"
// How long a new container must stay up before its deployment succeeds.
const SETTLE_MS = 3_000
// How long a container's health check may take to pass, past its settle.
const HEALTH_TIMEOUT_MS = 10 * 60_000
const HEALTH_POLL_MS = 1_000
// Variables Docker and Compose read themselves; an app's environment can't
// steer the Relay's own Docker client with them.
const RESERVED_ENVIRONMENT =
  /^(?:PATH|HOME|DOCKER_\w*|COMPOSE_\w*|BUILDKIT_\w*|BUILDX_\w*)$/u

interface ContainerInspect {
  Config: {
    Image: string
    Labels: Record<string, string | undefined> | null
    Tty?: boolean
  }
  Created: string
  HostConfig?: { Memory?: number; NanoCpus?: number; NetworkMode?: string }
  Id: string
  // The image's ID, whatever name `Config.Image` gave it.
  Image?: string
  Mounts?: Array<{
    Destination?: string
    Name?: string
    RW?: boolean
    Source?: string
    Type: string
  }>
  Name: string
  // Times Docker restarted it under its restart policy.
  RestartCount?: number
  NetworkSettings?: {
    Networks?: Record<string, unknown> | null
    Ports?: Record<string, Array<{ HostPort?: string }> | null> | null
  }
  State: {
    ExitCode: number
    Health?: { Status: string }
    OOMKilled?: boolean
    Restarting?: boolean
    Running: boolean
    StartedAt?: string
    Status: string
  }
}

interface AppContainer extends RelayAppContainer {
  appId: string
  limits: NonNullable<RelayAppContainer["limits"]>
  mounts: NonNullable<RelayAppContainer["mounts"]>
  deploymentId: string | null
  health: string | null
  // The digest an image app deployed, from its label.
  imageDigest: string | null
  imageId: string | null
  networkMode: string | null
  oomKilled: boolean
  // Exited since it started, and Docker restarted it or is about to.
  restarted: boolean
  tty: boolean
}

interface Deployment extends RelayAppDeployment {
  abort: AbortController
  // The characters of `lines`, which aren't saved with them.
  characters: number
  // Lines dropped from the front once the log reached its limits.
  dropped: number
  lines: Array<RelayConsoleLine>
}

// What an app's web routes need of its containers: Traefik labels for each
// service, and the edge network Traefik reaches them on, if any.
export interface AppRoutePlan {
  readonly labels: (service: string) => Record<string, string>
  readonly network: string | null
}

// What deploys join each service to besides its own network: its Traefik
// routes, and the Tailscale networks its services are members of.
/** Where an app's limits are kept and counted with every instance's. */
export interface AppLimitStores {
  readonly allocations: ResourceAllocations
  readonly state: RelayStateStore["Service"]
}

export interface AppNetworking {
  /**
   * Puts an app's services back at their addresses on their Tailscale
   * networks, logging any it can't.
   */
  readonly reattachTailscale: (appId: string) => Promise<void>
  readonly routes: (appId: string) => Promise<AppRoutePlan>
  readonly tailscale: (
    appId: string
  ) => Promise<
    ReadonlyArray<{ address: string; network: string; service: string }>
  >
}

export interface AppFileRoot {
  directory: string
  id: string
}

export class AppDriver {
  readonly #config: RelayConfig
  readonly #engine: DockerEngine
  readonly #resources: RelayResourceNames
  readonly #hostDataDirectory: () => Promise<string>
  readonly #networking: AppNetworking
  readonly #deployments = new Map<string, Deployment>()
  // Apps whose latest deployment has been read back from disk this run.
  readonly #restored = new Set<string>()
  readonly #restoring = new Map<string, Promise<void>>()
  // Wakes whatever follows an app when its deployment or containers change.
  readonly #waiters = new Map<string, Set<() => void>>()
  readonly #lanes: OperationLanes
  readonly #limits: AppLimitStores
  readonly #connections: DatabaseConnections
  readonly #volumeIds: (
    dockerNames: ReadonlyArray<string>
  ) => Promise<ReadonlyArray<string>>

  /**
   * Callers hold the App's lane locks for each change; a deployment's build
   * runs in the background and takes the App's lifecycle lock itself.
   */
  constructor(
    config: RelayConfig,
    hostDataDirectory: () => Promise<string>,
    networking: AppNetworking,
    lanes: OperationLanes,
    limits: AppLimitStores,
    connections: DatabaseConnections,
    /** The managed volumes with these Docker names, by ID. */
    volumeIds: (
      dockerNames: ReadonlyArray<string>
    ) => Promise<ReadonlyArray<string>>
  ) {
    this.#volumeIds = volumeIds
    this.#config = config
    this.#engine = new DockerEngine(config.dockerSocket)
    this.#resources = relayResourceNames(config)
    this.#hostDataDirectory = hostDataDirectory
    this.#lanes = lanes
    this.#limits = limits
    this.#networking = networking
    this.#connections = connections
    // Every service of a connected app joins the database's network, under
    // its name on the app's own.
    connections.useMembers("app", async (appId) => {
      const containers = await this.#appContainers(appId)
      if (containers.length === 0 && !(await this.#networks()).includes(appId))
        return null
      return containers.filter(joinsNetworks).map((container) => ({
        alias: this.#serviceAlias(appId, container.service),
        container: container.id,
      }))
    })
    // Every container counts its memory and CPU.
    limits.allocations.register(APP_KIND, async () =>
      (await this.#existing()).flatMap((app) =>
        app.containers.map((container) => ({
          id: app.id,
          limits: {
            ...NO_RESOURCE_LIMITS,
            ...(container.limits && {
              cpuMillis: container.limits.cpuMillis,
              memoryBytes: container.limits.memoryBytes,
            }),
          },
        }))
      )
    )
  }

  // Where app data directories live inside the Relay.
  get rootDirectory(): string {
    return join(this.#config.dataDirectory, "apps")
  }

  /** Every app, with the placeholders of those still provisioning. */
  async list(): Promise<Array<RelayApp>> {
    const [apps, provisioning] = await Promise.all([
      this.#existing(),
      this.#provisioning(),
    ])
    return withProvisioning(apps, provisioning)
  }

  // Apps still provisioning, by ID: what each shows until it exists.
  async #provisioning(): Promise<ReadonlyMap<string, RelayApp>> {
    const jobs = await Effect.runPromise(
      this.#limits.state.listProvisioningJobs()
    )
    return new Map(
      jobs.flatMap((job) =>
        job.kind === "app" ? [[job.instanceId, job.placeholder]] : []
      )
    )
  }

  /** What an app shows from its create request until it exists. */
  placeholder(input: RelayCreateApp): RelayApp {
    return relayAppSchema.parse({
      connectedDatabaseIds: [],
      containers: [],
      savedDatabaseIds: [],
      dataDirectory: this.#appDirectory(input.id),
      deployment: null,
      hostname: this.#hostname(input.id),
      id: input.id,
      network: this.#networkName(input.id),
      observedState: "provisioning",
      provisioning: { attempt: 0, error: null, phase: "awaiting_claim" },
      shortId: input.id.slice(0, 8),
      status: provisioningStatus("awaiting_claim", "app"),
    })
  }

  // The apps that exist, as their networks and containers report them.
  async #existing(): Promise<Array<RelayApp>> {
    const [containers, networks, host] = await Promise.all([
      this.#containers(),
      this.#networks(),
      this.#hostDataDirectory(),
    ])
    const ids = new Set([
      ...networks,
      ...containers.map((container) => container.appId),
    ])
    await Promise.all([...ids].map((id) => this.#restoreDeployment(id)))
    return [...ids].map((id) =>
      this.#toApp(
        id,
        containers.filter((container) => container.appId === id),
        host
      )
    )
  }

  /** Only the requested views of the requested apps, for Hearth's tables. */
  inventory(
    requests: RelayInventoryLookup["requests"],
    signal: AbortSignal
  ): Promise<Array<RelayInventoryItem>> {
    return traceRelayPromise(
      "Apps.inventory",
      async () => {
        const ids = [...new Set(requests.map((request) => request.id))]
        const detail = requests.some((request) => request.view === "detail")
        const [containers, networks, host] = await Promise.all([
          this.#containers(undefined, ids, signal),
          this.#networks(signal),
          detail ? this.#hostDataDirectory() : "",
          Promise.all(ids.map((id) => this.#restoreDeployment(id))),
        ])
        const provisioning = await this.#provisioning()
        return requests.flatMap(({ id, view }): Array<RelayInventoryItem> => {
          const owned = containers.filter((container) => container.appId === id)
          const placeholder = provisioning.get(id)
          const exists = owned.length > 0 || networks.includes(id)
          if (!exists && !placeholder) return []
          const observedState =
            placeholder?.observedState ??
            this.#runtimeState(id, owned).observedState
          const common = { id, view, observedState }
          if (view === "detail") {
            const [app] = withProvisioning(
              exists ? [this.#toApp(id, owned, host)] : [],
              placeholder ? new Map([[id, placeholder]]) : new Map()
            )
            return [{ ...common, app }]
          }
          if (view === "status") return [common]
          return [
            {
              ...common,
              table: {
                containerSearchText: owned
                  .map((container) => `${container.name} ${container.image}`)
                  .join(" "),
                containerCount: owned.length,
                runningContainerCount: owned.filter(
                  (container) => container.running
                ).length,
                deploying: this.#deployments.get(id)?.state === "running",
              },
            },
          ]
        })
      },
      { "app.count": requests.length }
    )
  }

  async get(appId: string): Promise<RelayApp> {
    const app = (await this.#existing()).find(
      (candidate) => candidate.id === appId
    )
    if (!app) throw new Error("App not found")
    return app
  }

  /** Creates an app's network and data directory, calling `onPhase` first. */
  async create(
    input: RelayCreateApp,
    onPhase: (phase: ProvisioningWorkPhase) => Promise<void> = async () => {}
  ): Promise<RelayApp> {
    await onPhase("preparing")
    if ((await this.#networks()).includes(input.id)) {
      throw new Error("App already exists")
    }
    await this.#ensureResources(input.id)
    return this.get(input.id)
  }

  async deploy(input: RelayDeployApp): Promise<RelayApp> {
    const problem = sourceProblem(input)
    if (problem) throw new Error(problem)
    const app = await this.get(input.appId)
    // Check after the await, so two deploys sent together can't both pass.
    if (this.#deployments.get(input.appId)?.state === "running") {
      throw new Error("A deployment is already running")
    }
    const deployment: Deployment = {
      abort: new AbortController(),
      characters: 0,
      commit: input.github?.commit ?? null,
      dropped: 0,
      error: null,
      finishedAt: null,
      // Later than any the app had, so a deployment within a second of
      // the last doesn't take the name or files its containers still use.
      id: deploymentStamp([
        this.#deployments.get(input.appId)?.id,
        ...app.containers.map(
          (container) => container.labels[DEPLOYMENT_LABEL]
        ),
      ]),
      lines: [],
      rolling: null,
      sourceType: input.config.sourceType,
      startedAt: new Date().toISOString(),
      state: "running",
    }
    this.#deployments.set(input.appId, deployment)
    this.#wake(input.appId)
    forkPromise(() =>
      Effect.runPromise(
        this.#lanes
          .run(
            {
              label: "app.deployment",
              // The volumes it mounts can't be deleted before its containers
              // mount them.
              locks: [
                ...appLifecycleLocks(input.appId),
                ...[
                  ...new Set(
                    input.config.mounts.flatMap((mount) =>
                      mount.source.type === "volume"
                        ? [mount.source.volumeId]
                        : []
                    )
                  ),
                ].map((id) => shared(laneKeys.volume(id))),
              ],
            },
            promiseEffect(() => this.#runDeployment(input, deployment))
          )
          // The whole deployment, from its wait for the app's lifecycle lock
          // through each step.
          .pipe((run) =>
            traceRelayEffect("relay.apps.deployment", run, {
              "relay.app_id": input.appId,
              "relay.app.deployment_id": deployment.id,
              "relay.app.source": input.config.sourceType,
              ...(input.github && {
                "relay.app.github.repository": input.github.repository,
                "relay.app.github.commit": input.github.commit,
              }),
            })
          )
          .pipe(
            // Refused before it ran, as when the Relay is too busy or paused.
            Effect.catch((cause) =>
              promiseEffect(() =>
                this.#finishDeployment(
                  input.appId,
                  deployment,
                  errorMessage(cause)
                )
              )
            )
          )
      )
    )
    return this.get(input.appId)
  }

  /** Stops a running deployment, so a delete doesn't wait for its build. */
  abortDeployment(appId: string): void {
    this.#deployments.get(appId)?.abort.abort()
  }

  /**
   * Stops an App being deleted and keeps Docker from starting it again on
   * its own. Each container's restart policy is passed to `record` before
   * it's changed, so a Relay that stops partway can still put it back.
   */
  async quietForDeletion(
    appId: string,
    record: (
      policies: Record<string, { maximumRetryCount: number; name: string }>
    ) => Promise<void>
  ): Promise<void> {
    // Freezing is a power decision too. Persist it before stopping anything,
    // so a stopped backup from before the deletion cannot restart this App
    // after the deletion is cancelled, even across a Relay restart.
    await Effect.runPromise(
      this.#limits.state.bumpAppPowerRevision(appId, Date.now())
    )
    const containers = await this.#appContainers(appId)
    for (const { id } of containers) {
      const inspected = await docker(this.#engine.inspectContainer(id))
      const policy = inspected.HostConfig?.RestartPolicy
      if (!policy?.Name || policy.Name === "no") continue
      await record({
        [id]: {
          maximumRetryCount: policy.MaximumRetryCount ?? 0,
          name: policy.Name,
        },
      })
      await docker(this.#engine.setRestartPolicy(id, "no"))
    }
    if (containers.some((container) => container.running)) {
      await this.action({ action: "stop", appId })
    }
  }

  /**
   * Gives an App's containers back the restart policies freezing took. A
   * container that's gone has nothing to give back; any other failure is
   * thrown, so the freeze stays for letting it go again.
   */
  async restoreRestartPolicies(
    policies: Readonly<
      Record<string, { readonly maximumRetryCount: number; readonly name: string }>
    >
  ): Promise<void> {
    for (const [container, policy] of Object.entries(policies)) {
      await docker(
        this.#engine
          .setRestartPolicy(
            container,
            policy.name,
            policy.name === "on-failure" ? policy.maximumRetryCount : undefined
          )
          .pipe(
            Effect.catchIf(
              (error) => error.status === 404,
              () => Effect.void
            )
          )
      )
    }
  }

  async action(input: RelayAppAction): Promise<RelayApp> {
    const containers = await this.#appContainers(input.appId)
    if (containers.length === 0) throw new Error("Deploy the app first")
    // A service that lost its Tailscale address takes it again as it starts.
    if (input.action !== "stop") {
      await this.#networking.reattachTailscale(input.appId)
    }
    const engine = this.#engine
    await docker(
      Effect.forEach(
        containers,
        ({ id }) =>
          input.action === "stop"
            ? engine.stopContainer(id, { seconds: 30, timeout: 90_000 })
            : input.action === "start"
              ? engine.startContainer(id, { timeout: 120_000 })
              : engine.restartContainer(id, {
                  seconds: 30,
                  timeout: 150_000,
                }),
        { concurrency: "unbounded", discard: true }
      )
    )
    this.#wake(input.appId)
    return this.get(input.appId)
  }

  /**
   * Saves an app's limits and applies what Docker can change in place to
   * its containers. Removing a service's memory or CPU limit applies when
   * the app next deploys, since Docker can't remove one from a container,
   * so until then the container's limit still counts.
   */
  async setLimits(input: RelayAppLimits): Promise<RelayApp> {
    const containers = await this.#appContainers(input.appId)
    if (
      containers.length === 0 &&
      !(await this.#networks()).includes(input.appId)
    ) {
      throw new Error("App not found")
    }
    const engine = this.#engine
    await this.#reserving(
      input.appId,
      containers.map((container) => {
        const next = input.serviceLimits[container.service]
        return {
          cpuMillis: next?.cpuMillis ?? container.limits.cpuMillis,
          memoryBytes: next?.memoryBytes ?? container.limits.memoryBytes,
        }
      }),
      () => {
        const update = (container: AppContainer) => {
          const next = input.serviceLimits[container.service]
          const spec = containerLimitSpec({ ...NO_RESOURCE_LIMITS, ...next })
          return next &&
            (next.memoryBytes !== container.limits.memoryBytes ||
              next.cpuMillis !== container.limits.cpuMillis)
            ? engine.updateContainerResources(container.id, {
                ...(next.memoryBytes !== null && {
                  memoryBytes: next.memoryBytes,
                }),
                ...(spec.nanoCpus !== undefined && {
                  nanoCpus: spec.nanoCpus,
                }),
              })
            : Effect.void
        }
        // Memory one service gives up is freed before another takes more,
        // so a change that fails partway never leaves the node overcommitted.
        const grows = (container: AppContainer) => {
          const next = input.serviceLimits[container.service]?.memoryBytes
          return (
            next !== undefined &&
            next !== null &&
            next > (container.limits.memoryBytes ?? 0)
          )
        }
        return docker(
          Effect.forEach(
            containers.filter((container) => !grows(container)),
            update,
            { concurrency: "unbounded", discard: true }
          ).pipe(
            Effect.andThen(
              Effect.forEach(containers.filter(grows), update, {
                concurrency: "unbounded",
                discard: true,
              })
            )
          )
        )
      }
    )
    this.#wake(input.appId)
    return this.get(input.appId)
  }

  /**
   * Checks an app's limits against every instance's and reserves them,
   * holding the node's allocations only that long, then runs `apply`. The
   * reservation stands in for the app's
   * containers until `apply` ends, so no other change claims the same
   * capacity meanwhile, and a deployment waiting on health checks doesn't
   * hold up every other change on the node. Callers hold the app's
   * lifecycle lock, and take the allocations as a nested step: nothing takes
   * them while waiting on an app's lifecycle, and a pause doesn't strand a
   * deployment halfway.
   */
  async #reserving<A>(
    appId: string,
    services: ReadonlyArray<ServiceResourceLimits>,
    apply: (surge: boolean) => Promise<A>,
    options: {
      /**
       * Whether the new containers may run beside the app's running ones,
       * which `apply` learns: only if the node holds both at once.
       */
      surge?: boolean
    } = {}
  ): Promise<A> {
    const { release, surge } = await Effect.runPromise(
      traceRelayEffect(
        "relay.apps.reserve",
        this.#lanes.runNested(
          {
            label: "app.allocations",
            locks: [exclusive(laneKeys.allocations)],
          },
          promiseEffect(async () => {
            await this.#assertLimitsFit(appId, services)
            const containers = await this.#appContainers(appId)
            const running = containers
              .filter((container) => container.running)
              .map((container) => container.limits)
            const surge =
              options.surge === true &&
              running.length > 0 &&
              (await recoverPromise(
                () =>
                  this.#assertLimitsFit(appId, services, running).then(
                    () => true
                  ),
                () => false
              ))
            const current = combinedLimits(
              containers.map((container) => container.limits)
            )
            const requested = combinedLimits(services)
            // Beside the running containers, both sets of memory count; a
            // smaller limit isn't free until it applies, and may not, so
            // otherwise the wider of the two does.
            const held = surge
              ? {
                  ...widestResourceLimits(current, requested),
                  memoryBytes:
                    current.memoryBytes === null &&
                    requested.memoryBytes === null
                      ? null
                      : (current.memoryBytes ?? 0) +
                        (requested.memoryBytes ?? 0),
                }
              : widestResourceLimits(current, requested)
            return {
              release: this.#limits.allocations.reserve(APP_KIND, appId, held),
              surge,
            }
          })
        ),
        { "relay.app_id": appId, "relay.app.services": services.length }
      )
    )
    return ensuringPromise(() => apply(surge), release)
  }

  async #assertLimitsFit(
    appId: string,
    services: ReadonlyArray<ServiceResourceLimits>,
    // Containers that keep running beside the new ones.
    alongside: ReadonlyArray<ServiceResourceLimits> = []
  ): Promise<void> {
    const [filesystem, others] = await Promise.all([
      statfs(this.#config.rootDirectory),
      this.#limits.allocations.others(APP_KIND, appId),
    ])
    const nodeDiskBytes = filesystem.blocks * filesystem.bsize
    // Each service's memory counts against the node, with the others'.
    const allocated: Array<typeof NO_RESOURCE_LIMITS> = [
      ...others,
      ...alongside.map((limits) => ({ ...NO_RESOURCE_LIMITS, ...limits })),
    ]
    for (const service of services) {
      const limits = { ...NO_RESOURCE_LIMITS, ...service }
      assertResourceLimitsFit({
        currentDiskBytes: null,
        limits,
        nodeDiskBytes,
        others: allocated,
      })
      allocated.push(limits)
    }
  }

  /**
   * Removes whatever a create made for an app still provisioning: all of
   * it once its network exists, or only its data directory if the create
   * stopped before then.
   */
  async discard(appId: string): Promise<void> {
    const exists =
      (await this.#appContainers(appId)).length > 0 ||
      (await this.#networks()).includes(appId)
    if (exists) {
      await this.delete({ appId, deleteData: true })
      return
    }
    await this.#connections.forgetMember({ id: appId, kind: "app" })
    await rm(this.#appDirectory(appId), { force: true, recursive: true })
  }

  async delete(input: RelayDeleteApp) {
    this.abortDeployment(input.appId)
    const containers = await this.#appContainers(input.appId)
    if (
      containers.length === 0 &&
      !(await this.#networks()).includes(input.appId)
    ) {
      throw new Error("App not found")
    }
    const engine = this.#engine
    await docker(
      Effect.forEach(
        containers,
        ({ id }) =>
          engine.removeContainer(id, {
            force: true,
            timeout: 90_000,
            volumes: input.deleteData,
          }),
        { concurrency: "unbounded", discard: true }
      )
    )
    // Rolled deployments' projects too.
    await this.#removeComposeNetworks(input.appId, null)
    if (input.deleteData) {
      // Only the volumes the App's own Compose projects made, never a Kiln
      // volume it mounted. One another App's containers mount, as a file
      // that names it can, stays: it's that App's data now too.
      const [volumes, remaining] = await docker(
        Effect.all([
          engine.listVolumes({ filters: { label: [COMPOSE_PROJECT_LABEL] } }),
          engine.listContainers({ all: true }),
        ])
      )
      const mounted = new Set(
        remaining.flatMap((container) =>
          (container.Mounts ?? []).flatMap((mount) =>
            mount.Type === "volume" && mount.Name ? [mount.Name] : []
          )
        )
      )
      for (const volume of volumes) {
        if (
          appVolumeOwner(this.#config, volume.Labels)?.appId !== input.appId ||
          mounted.has(volume.Name)
        ) {
          continue
        }
        await docker(engine.removeVolume(volume.Name).pipe(Effect.ignore))
      }
    }
    await this.#removeNetwork(this.#networkName(input.appId))
    await this.#connections.forgetMember({ id: input.appId, kind: "app" })
    // Built images are only cleanup; failing to remove them doesn't stop
    // the app's removal.
    await docker(
      engine
        .listImages({ filters: { label: [`${ID_LABEL}=${input.appId}`] } })
        .pipe(
          Effect.flatMap((images) =>
            Effect.forEach(
              images,
              (image) => engine.removeImage(image.Id).pipe(Effect.ignore),
              { discard: true }
            )
          ),
          Effect.ignore
        )
    )
    await rm(this.#dockerfilePath(input.appId), { force: true })
    await rm(this.#mountDirectory(input.appId), {
      force: true,
      recursive: true,
    })
    if (input.deleteData) {
      await rm(this.#appDirectory(input.appId), {
        force: true,
        recursive: true,
      })
    }
    await rm(this.#deploymentDirectory(input.appId), {
      force: true,
      recursive: true,
    })
    await rm(join(this.#config.dataDirectory, "app-sources", input.appId), {
      force: true,
      recursive: true,
    })
    this.#deployments.delete(input.appId)
    this.#wake(input.appId)
    return { appId: input.appId, deleted: true }
  }

  // The newest container of one of an app's services, for its terminal.
  async serviceContainer(
    appId: string,
    service: string
  ): Promise<RelayAppContainer | null> {
    return (
      (await this.#appContainers(appId))
        .filter((container) => container.service === service)
        .sort(newestFirst)[0] ?? null
    )
  }

  // The directory an app's files live in, relative to `rootDirectory`.
  async fileRoot(appId: string): Promise<AppFileRoot> {
    await this.get(appId)
    await mkdir(this.#appDirectory(appId), { recursive: true })
    return { directory: appId, id: appId }
  }

  // An app's console output: the log of its latest deployment, or one of
  // its services' containers.
  async consoleSession(
    appId: string,
    stream: string | undefined,
    containerSession: (
      containerId: string,
      signal?: AbortSignal
    ) => Promise<DockerConsoleSession>,
    signal?: AbortSignal
  ): Promise<DockerConsoleSession> {
    if (!stream || stream === APP_DEPLOYMENT_STREAM) {
      await this.#restoreDeployment(appId)
      return this.#deploymentSession(appId)
    }
    if (!stream.startsWith(SERVICE_STREAM_PREFIX)) {
      throw new Error("Unknown app log stream")
    }
    const service = appServiceNameSchema.parse(
      stream.slice(SERVICE_STREAM_PREFIX.length)
    )
    const container = await this.serviceContainer(appId, service)
    // Not deployed yet: wait for a deployment to bring the service up.
    if (!container) return this.#idleSession(appId)
    return containerSession(container.id, signal)
  }

  #deploymentSession(appId: string): DockerConsoleSession {
    const deployment = this.#deployments.get(appId) ?? null
    return {
      history: (limit = 2_000) =>
        Promise.resolve({
          instanceId: appId,
          lifecycle: deployment
            ? [{ state: "started" as const, time: deployment.startedAt }]
            : [],
          lines: deployment ? deployment.lines.slice(-limit) : [],
          truncated: deployment
            ? deployment.dropped > 0 || deployment.lines.length > limit
            : false,
        }),
      stream: (signal) => this.#followDeployment(appId, deployment, signal),
    }
  }

  // Follows one deployment's log, then ends once the next one starts so the
  // console switches to it.
  async *#followDeployment(
    appId: string,
    deployment: Deployment | null,
    signal: AbortSignal
  ): AsyncIterable<RelayConsoleLine> {
    let next = deployment?.dropped ?? 0
    while (!signal.aborted) {
      const woken = this.#nextWake(appId, signal)
      if (deployment) {
        // Lines can be dropped while one is being read, so skip past them.
        for (
          next = Math.max(next, deployment.dropped);
          next < deployment.dropped + deployment.lines.length;
          next = Math.max(next + 1, deployment.dropped)
        ) {
          const line = deployment.lines[next - deployment.dropped]
          if (line) yield line
        }
      }
      if ((this.#deployments.get(appId) ?? null) !== deployment) return
      await woken
    }
  }

  #idleSession(appId: string): DockerConsoleSession {
    return {
      history: () =>
        Promise.resolve({
          instanceId: appId,
          lifecycle: [],
          lines: [],
          truncated: false,
        }),
      // Ends, without output, at the app's next change.
      stream: (signal) => ({
        [Symbol.asyncIterator]: () => {
          const changed = this.#nextWake(appId, signal)
          return {
            next: async () => {
              await changed
              return { done: true, value: undefined }
            },
          }
        },
      }),
    }
  }

  #nextWake(appId: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let waiters = this.#waiters.get(appId)
      if (!waiters) {
        waiters = new Set()
        this.#waiters.set(appId, waiters)
      }
      const done = () => {
        signal.removeEventListener("abort", done)
        const current = this.#waiters.get(appId)
        current?.delete(done)
        if (current?.size === 0) this.#waiters.delete(appId)
        resolve()
      }
      waiters.add(done)
      if (signal.aborted) done()
      else signal.addEventListener("abort", done, { once: true })
    })
  }

  #wake(appId: string): void {
    const waiters = this.#waiters.get(appId)
    if (!waiters) return
    for (const waiter of waiters) waiter()
  }

  async #runDeployment(input: RelayDeployApp, deployment: Deployment) {
    const startedAt = Date.now()
    const log = (text: string, level: RelayConsoleLevel = "info") =>
      this.#log(input.appId, deployment, text, level)
    const outcome = await Effect.runPromise(
      Effect.result(
        promiseEffect(async () => {
          // A delete aborted it while it waited its turn, and may have
          // removed the App; it mustn't recreate it.
          if (deployment.abort.signal.aborted) {
            throw new Error("The deployment was cancelled")
          }
          const { config } = input
          log(`Deploying ${input.name} (deployment ${deployment.id})`)
          log(`Source: ${describeSource(input)}`)
          await this.#ensureResources(input.appId)
          const host = await this.#hostDataDirectory()
          const mounts = await this.#configMounts(input, deployment, host)
          const checkout =
            config.sourceType === "github" && input.github
              ? await traceRelayPromise("relay.apps.deployment.checkout", () =>
                  this.#checkOut(input, deployment)
                )
              : null
          if (
            config.sourceType === "compose" ||
            input.github?.build === "compose"
          ) {
            await this.#deployCompose(input, deployment, host, checkout, mounts)
          } else {
            const image =
              config.sourceType === "image"
                ? await traceRelayPromise("relay.apps.deployment.pull", () =>
                    this.#pullImage(input, deployment)
                  )
                : await traceRelayPromise("relay.apps.deployment.build", () =>
                    this.#buildImage(input, deployment, checkout)
                  ).then((reference) => ({ labels: {}, reference }))
            // Its one service's limits count once the image is ready.
            await this.#reserving(
              input.appId,
              [
                config.serviceLimits[APP_SERVICE] ?? {
                  cpuMillis: null,
                  memoryBytes: null,
                },
              ],
              (surge) =>
                traceRelayPromise("relay.apps.deployment.replace", () =>
                  this.#replaceContainer(
                    input,
                    deployment,
                    image,
                    host,
                    mounts.filter(
                      (mount) =>
                        mount.service === null || mount.service === APP_SERVICE
                    ),
                    surge
                  )
                ),
              { surge: true }
            )
          }
        })
      )
    )
    await this.#cleanCheckouts(input.appId)
    await this.#cleanMountFiles(input.appId)
    const seconds = ((Date.now() - startedAt) / 1_000).toFixed(1)
    const message = Result.isSuccess(outcome)
      ? null
      : deployment.abort.signal.aborted
        ? "The deployment was cancelled"
        : errorMessage(outcome.failure)
    if (message === null) log(`Deployment finished in ${seconds}s`)
    else log(`Deployment failed after ${seconds}s: ${message}`, "error")
    await this.#finishDeployment(input.appId, deployment, message)
  }

  async #finishDeployment(
    appId: string,
    deployment: Deployment,
    message: string | null
  ) {
    const finished = {
      error: message?.slice(0, 2_000) ?? null,
      finishedAt: new Date().toISOString(),
      state: message === null ? ("succeeded" as const) : ("failed" as const),
    }
    // Saved before it shows as finished, so a finished deployment's log is
    // always on disk. One whose App was deleted leaves nothing behind.
    if (this.#deployments.get(appId) === deployment) {
      await this.#saveDeployment(appId, { ...deployment, ...finished })
    }
    Object.assign(deployment, finished)
    this.#wake(appId)
  }

  // Writes a finished deployment's log, keeping the newest few per app. A
  // log that can't be written only costs its history.
  async #saveDeployment(appId: string, deployment: Deployment) {
    const directory = this.#deploymentDirectory(appId)
    await Effect.runPromise(
      promiseEffect(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const { abort: _abort, characters: _characters, ...saved } = deployment
        await writeFile(
          join(directory, `${deployment.id}.json`),
          JSON.stringify(saved),
          { mode: 0o600 }
        )
        const older = (await deploymentFiles(directory)).slice(KEPT_DEPLOYMENTS)
        for (const file of older)
          await rm(join(directory, file), { force: true })
      }).pipe(Effect.ignore)
    )
  }

  // The latest deployment from before the Relay restarted, if any. Callers
  // that arrive while it is being read share that read.
  #restoreDeployment(appId: string): Promise<void> {
    if (this.#restored.has(appId) || this.#deployments.has(appId))
      return Promise.resolve()
    let pending = this.#restoring.get(appId)
    if (!pending) {
      pending = ensuringPromise(
        () => this.#readDeployment(appId),
        () => {
          this.#restored.add(appId)
          this.#restoring.delete(appId)
        }
      )
      this.#restoring.set(appId, pending)
    }
    return pending
  }

  async #readDeployment(appId: string) {
    const [latest] = await Effect.runPromise(
      promiseEffect(() =>
        deploymentFiles(this.#deploymentDirectory(appId))
      ).pipe(Effect.orElseSucceed((): Array<string> => []))
    )
    const restored = latest
      ? await this.#savedDeployment(appId, latest.slice(0, -".json".length))
      : null
    if (restored && !this.#deployments.has(appId)) {
      this.#deployments.set(appId, restored)
    }
  }

  // A finished deployment's saved log, or null if it isn't kept.
  async #savedDeployment(
    appId: string,
    deploymentId: string
  ): Promise<Deployment | null> {
    if (!/^\d{14}$/u.test(deploymentId)) return null
    const file = join(this.#deploymentDirectory(appId), `${deploymentId}.json`)
    return Effect.runPromise(
      promiseEffect(async () => {
        const saved = JSON.parse(await readFile(file, "utf8")) as Omit<
          Deployment,
          "abort" | "characters" | "commit" | "rolling"
        > &
          Partial<Pick<Deployment, "commit" | "rolling">>
        const deployment: Deployment = {
          ...saved,
          abort: new AbortController(),
          characters: saved.lines.reduce(
            (total, line) => total + consoleLineCharacters(line),
            0
          ),
          // Logs saved before deployments recorded these.
          commit: saved.commit ?? null,
          rolling: saved.rolling ?? null,
        }
        trimDeploymentLog(deployment)
        return deployment
      }).pipe(Effect.orElseSucceed(() => null))
    )
  }

  /**
   * One of the app's recent deployments with its log: the latest, or one
   * whose log the Relay kept. Null once it no longer keeps it.
   */
  async readDeployment(
    input: RelayAppDeploymentRead
  ): Promise<RelayAppDeploymentLog> {
    await this.#restoreDeployment(input.appId)
    const latest = this.#deployments.get(input.appId)
    const deployment =
      latest?.id === input.deploymentId
        ? latest
        : await this.#savedDeployment(input.appId, input.deploymentId)
    if (!deployment) return null
    return {
      deployment: deploymentSummary(deployment),
      dropped: deployment.dropped,
      lines: deployment.lines,
    }
  }

  /**
   * What each image app's tag names in its registry now, against the
   * digest its container runs. Apps naming the same image share one lookup,
   * and an app mid-deployment, or whose container runs another image than
   * the one named, needs none.
   */
  async checkImages(
    input: RelayAppImageCheck,
    signal: AbortSignal
  ): Promise<Array<RelayAppImageCheckResult>> {
    const containers = await this.#containers(
      undefined,
      input.apps.map((app) => app.appId),
      signal
    )
    const checks = input.apps.map(({ appId, image }) => {
      const reference = Result.try(() => parseImageReference(image))
      // The container serving the app: a deployment's replacement only
      // takes over once it's healthy, and no check runs during one.
      const container = containers
        .filter(
          (candidate) =>
            candidate.appId === appId && candidate.service === APP_SERVICE
        )
        .sort(
          (left, right) =>
            Number(right.running) - Number(left.running) ||
            newestFirst(left, right)
        )[0]
      const deploying = this.#deployments.get(appId)?.state === "running"
      // The name to look up, while the container runs the image its config
      // names by tag: another image, or a digest, which never moves, has
      // nothing to compare.
      const lookup =
        !deploying &&
        container &&
        Result.isSuccess(reference) &&
        reference.success.digest === undefined &&
        sameImage(container.image, reference.success)
          ? normalizedReference(reference.success)
          : null
      return { appId, container, deploying, lookup, reference }
    })
    const wanted = new Set(
      checks.flatMap(({ lookup }) => (lookup === null ? [] : [lookup]))
    )
    const latest = new Map(
      await docker(
        Effect.forEach(
          [...wanted],
          (name) =>
            this.#engine.distributionDigest(name).pipe(
              Effect.result,
              Effect.map((result) => [name, result] as const)
            ),
          { concurrency: 4 }
        ),
        signal
      )
    )
    return Promise.all(
      checks.map(
        async ({
          appId,
          container,
          deploying,
          lookup,
          reference,
        }): Promise<RelayAppImageCheckResult> => {
          if (Result.isFailure(reference)) {
            return {
              appId,
              error: "The image isn't a valid reference",
              status: "error",
            }
          }
          if (deploying) return { appId, status: "deploying" }
          if (!container) return { appId, status: "not_deployed" }
          // Its own lookup only: another app naming the same image says
          // nothing of what this one runs.
          const found = lookup === null ? undefined : latest.get(lookup)
          if (!found) return { appId, status: "changed" }
          if (Result.isFailure(found)) {
            return {
              appId,
              error: found.failure.reason.slice(0, 500),
              status: "error",
            }
          }
          return {
            appId,
            latestDigest: found.success,
            runningDigests: container.imageDigest
              ? [container.imageDigest]
              : await this.#repositoryDigests(
                  container,
                  reference.success,
                  signal
                ),
            status: "checked",
          }
        }
      )
    )
  }

  /**
   * The digests a container's image was pulled as from its repository, for
   * one deployed before Kiln labelled the digest it runs.
   */
  async #repositoryDigests(
    container: AppContainer,
    reference: ImageReference,
    signal: AbortSignal
  ): Promise<Array<string>> {
    if (!container.imageId) return []
    const image = await docker(
      this.#engine
        .inspectImage<{
          RepoDigests?: Array<string> | null
        } | null>(container.imageId)
        .pipe(Effect.catchIf(isDockerNotFound, () => Effect.succeed(null))),
      signal
    )
    const repository = repositoryName(reference)
    return (image?.RepoDigests ?? []).flatMap((entry) => {
      const parsed = Result.try(() => parseImageReference(entry))
      return Result.isSuccess(parsed) &&
        parsed.success.digest !== undefined &&
        repositoryName(parsed.success) === repository
        ? [parsed.success.digest]
        : []
    })
  }

  #deploymentDirectory(appId: string): string {
    return join(this.#config.dataDirectory, "app-deployments", appId)
  }

  // The commit a GitHub deployment builds, unpacked in the Relay's data
  // directory, where Docker on the host can bind its files into Compose
  // services.
  async #checkOut(
    input: RelayDeployApp,
    deployment: Deployment
  ): Promise<string> {
    const github = input.github!
    const directory = checkoutDirectory(
      this.#config.dataDirectory,
      input.appId,
      deployment.id
    )
    this.#log(
      input.appId,
      deployment,
      `Downloading ${github.repository} at ${github.commit.slice(0, 7)}`
    )
    const summary = await checkOutRepository(
      github,
      directory,
      deployment.abort.signal
    )
    this.#log(
      input.appId,
      deployment,
      summary.skipped > 0
        ? `Checked out ${summary.files} files, leaving out ${summary.skipped} links or special files that lead outside the repository`
        : `Checked out ${summary.files} files`
    )
    return directory
  }

  // Keeps the checkouts the app's Compose containers were deployed from,
  // whose services may bind files from them, whichever deployment left
  // them running; removes every other, a Dockerfile's once it's built.
  async #cleanCheckouts(appId: string) {
    const root = join(this.#config.dataDirectory, "app-sources", appId)
    await Effect.runPromise(
      promiseEffect(async () => {
        const inUse = new Set(
          (await this.#appContainers(appId)).flatMap((container) =>
            container.labels[COMPOSE_PROJECT_LABEL] && container.deploymentId
              ? [container.deploymentId]
              : []
          )
        )
        for (const entry of await readdir(root)) {
          if (inUse.has(entry)) continue
          await rm(join(root, entry), { force: true, recursive: true })
        }
      }).pipe(Effect.ignore)
    )
  }

  // Keeps the files each deployment whose containers are left mounts,
  // whether it succeeded or failed with the earlier ones kept; removes every
  // other.
  async #cleanMountFiles(appId: string) {
    const root = this.#mountDirectory(appId)
    await Effect.runPromise(
      promiseEffect(async () => {
        const inUse = new Set(
          (await this.#appContainers(appId)).flatMap((container) =>
            container.deploymentId ? [container.deploymentId] : []
          )
        )
        for (const entry of await readdir(root)) {
          if (inUse.has(entry)) continue
          await rm(join(root, entry), { force: true, recursive: true })
        }
      }).pipe(Effect.ignore)
    )
  }

  /**
   * Pulls the image app's image at the digest its tag names now, or the
   * one the deployment names, and runs it by that digest, so another app
   * pulling the same tag meanwhile can't change what this one starts.
   */
  async #pullImage(
    input: RelayDeployApp,
    deployment: Deployment
  ): Promise<DeployedImage> {
    const image = input.config.image
    const log = (text: string, level: RelayConsoleLevel = "info") =>
      this.#log(input.appId, deployment, text, level)
    const signal = deployment.abort.signal
    const reference = parseImageReference(image)
    const pull = (name: string) =>
      docker(
        this.#engine.pullImage(name, {
          onLine: (line) => this.#logOutput(input.appId, deployment, line),
          timeout: PULL_TIMEOUT_MS,
        }),
        signal
      )
    // A reference that names its digest already runs as it is.
    if (reference.digest !== undefined) {
      log(`Pulling ${image}`)
      await pull(image)
      return { labels: {}, reference: image }
    }
    const digest =
      input.imageDigest ??
      (await docker(
        this.#engine.distributionDigest(image).pipe(
          Effect.catch((cause) =>
            Effect.sync(() => {
              log(`Could not read ${image}'s digest: ${cause.reason}`, "warn")
              return null
            })
          )
        ),
        signal
      ))
    // A registry that can't say leaves the tag to name it, untracked.
    if (digest === null) {
      log(`Pulling ${image}`)
      await pull(image)
      return { labels: {}, reference: image }
    }
    const pinned = `${repositoryName(reference)}@${digest}`
    log(`Pulling ${image}`)
    log(`Digest: ${digest}`)
    await pull(pinned)
    return {
      labels: { [IMAGE_DIGEST_LABEL]: digest, [IMAGE_LABEL]: image },
      reference: pinned,
    }
  }

  // Builds a pasted Dockerfile with the app's data directory as the
  // context, so it can COPY files uploaded to the app, and a repository's
  // with the repository as its context.
  async #buildImage(
    input: RelayDeployApp,
    deployment: Deployment,
    checkout: string | null
  ) {
    const tag = `kiln-app-${input.appId}:${deployment.id}`
    let dockerfile = this.#dockerfilePath(input.appId)
    let context = this.#appDirectory(input.appId)
    if (checkout && input.github) {
      const found = await checkoutFile(checkout, input.github.path)
      if (!found) {
        throw new Error(`The repository has no file at ${input.github.path}`)
      }
      dockerfile = found
      context = checkout
    } else {
      await mkdir(join(this.#config.dataDirectory, "app-builds"), {
        recursive: true,
        mode: 0o700,
      })
      await writeFile(dockerfile, input.config.dockerfile, { mode: 0o600 })
    }
    this.#log(input.appId, deployment, `Building ${tag}`)
    await this.#stream(
      input.appId,
      deployment,
      BUILDX,
      [
        "build",
        "--progress",
        "plain",
        ...labelArguments(this.#imageLabels(input.appId)),
        "--tag",
        tag,
        "--file",
        dockerfile,
        context,
      ],
      // Docker's own builder, which loads the image into Docker.
      {
        env: { ...process.env, BUILDX_BUILDER: "default" },
        timeout: BUILD_TIMEOUT_MS,
      }
    )
    return tag
  }

  async #replaceContainer(
    input: RelayDeployApp,
    deployment: Deployment,
    image: DeployedImage,
    host: string,
    mounts: ReadonlyArray<ConfigMount>,
    // Whether the node holds the new container beside the running one.
    surge: boolean
  ) {
    const log = (text: string, level: RelayConsoleLevel = "info") =>
      this.#log(input.appId, deployment, text, level)
    const { config } = input
    const previous = await this.#appContainers(input.appId)
    const name = this.#containerName(input.appId, null, deployment.id)
    const hostname = this.#hostname(input.appId)
    const environment = this.#environment(input.appId, deployment, config)
    const databases = await this.#connectableDatabases(input.appId, deployment)
    const routes = await this.#networking.routes(input.appId)
    const tailscale = (await this.#networking.tailscale(input.appId)).filter(
      (membership) => membership.service === APP_SERVICE
    )
    const running = previous.some((container) => container.running)
    // Two containers can't hold the same host port or Tailscale address,
    // share a volume's data, or take memory the node doesn't have for both.
    const blocker =
      config.ports.length > 0
        ? "it publishes ports on the Relay"
        : tailscale.length > 0
          ? "it has a Tailscale address"
          : (mountsRollingBlocker(mounts) ??
            (!surge ? "the node can't hold both copies at once" : null))
    const rolling = running && blocker === null
    deployment.rolling = rolling
    if (running && blocker) {
      log(`Stopping the running container first, since ${blocker}`)
    }
    await docker(
      createContainer(this.#engine, {
        command: shellWords(config.command),
        env: environment,
        hostname,
        image: image.reference,
        ...containerLimitSpec({
          ...NO_RESOURCE_LIMITS,
          ...config.serviceLimits[APP_SERVICE],
        }),
        labels: {
          ...routes.labels(APP_SERVICE),
          ...image.labels,
          ...this.#containerLabels(
            input.appId,
            APP_SERVICE,
            deployment.id,
            deployment.commit
          ),
        },
        mounts: mounts.map((mount) => ({
          // Docker leaves a volume it only reads as it is, even empty, so a
          // new container beside the running one writes nothing to it.
          noCopy: mount.type === "volume" && mount.readOnly,
          readOnly: mount.readOnly,
          source: mount.source,
          target: mount.target,
          type: mount.type,
        })),
        name,
        // Beside the running container, the new one takes the app's name
        // on its network only once it's healthy, so bundled Traefik sends it
        // nothing before then.
        network: {
          aliases: rolling ? [] : [hostname],
          name: this.#networkName(input.appId),
        },
        ports: config.ports.map((port) => ({
          containerPort: port.containerPort,
          hostPort: port.hostPort,
          protocol: port.protocol,
        })),
        restart: "unless-stopped",
      })
    )
    log(`Created container ${name}`)
    for (const network of [
      ...databases,
      ...(routes.network ? [routes.network] : []),
    ]) {
      await docker(
        this.#engine.connectNetwork(network, name, { aliases: [hostname] })
      )
    }
    // Tailscale members keep their address, which the new container takes
    // once the previous one stops.
    for (const membership of tailscale) {
      await docker(
        this.#engine.connectNetwork(membership.network, name, {
          aliases: [hostname],
          ipv4Address: membership.address,
        })
      )
    }
    const start = () => this.#startContainer(input.appId, deployment, name)
    if (!rolling) {
      await this.#replacing(input.appId, deployment, previous, [name], start)
      return
    }
    await this.#rollingOver(input.appId, deployment, previous, start, () =>
      this.#takeAlias(this.#networkName(input.appId), name, hostname)
    )
  }

  async #startContainer(appId: string, deployment: Deployment, name: string) {
    await docker(this.#engine.startContainer(name, { timeout: 120_000 }))
    this.#log(appId, deployment, `Started ${name}`)
    await this.#awaitHealthy(appId, deployment, [name], false)
  }

  /**
   * Starts a deployment's containers beside the running ones and, once
   * they're healthy, moves the app's names to them and stops the old ones.
   * Until then the running containers serve as before, and stay if the new
   * ones fail.
   */
  async #rollingOver(
    appId: string,
    deployment: Deployment,
    previous: ReadonlyArray<AppContainer>,
    start: () => Promise<void>,
    takeOver: () => Promise<void>
  ) {
    this.#log(
      appId,
      deployment,
      "Starting the new containers beside the running ones"
    )
    // Until the old ones stop, they keep their names, so a failure up to
    // the switch leaves them serving, without the new ones beside them.
    const switched = await Effect.runPromise(
      Effect.result(promiseEffect(() => start().then(takeOver)))
    )
    if (Result.isFailure(switched)) {
      for (const container of await this.#appContainers(appId)) {
        if (container.deploymentId !== deployment.id) continue
        await this.#removeContainer(container.id)
      }
      this.#log(appId, deployment, "Keeping the running containers", "warn")
      throw switched.failure
    }
    this.#log(appId, deployment, "Switched traffic to the new containers")
    for (const container of previous) {
      if (container.running) {
        this.#log(appId, deployment, `Stopping ${container.name}`)
        await docker(
          this.#engine
            .stopContainer(container.id, { seconds: 30, timeout: 60_000 })
            .pipe(Effect.ignore)
        )
      }
      this.#log(appId, deployment, `Removing ${container.name}`)
      await this.#removeContainer(container.id)
    }
  }

  // Gives a running container a name on a network it joined without it.
  async #takeAlias(network: string, container: string, alias: string) {
    await docker(this.#engine.disconnectNetwork(network, container))
    await docker(
      this.#engine.connectNetwork(network, container, { aliases: [alias] })
    )
  }

  // Waits for new containers to come up: each stays running past a brief
  // settle, and one with a health check passes it. With `exitedCleanly`, a
  // container that exits with 0, like a Compose migration step, is done.
  async #awaitHealthy(
    appId: string,
    deployment: Deployment,
    names: ReadonlyArray<string>,
    exitedCleanly: boolean
  ) {
    await sleep(SETTLE_MS, deployment.abort.signal)
    const deadline = Date.now() + HEALTH_TIMEOUT_MS
    const waiting = new Set<string>()
    // Every container is checked each round, so one that passed and then
    // failed while another started can't hand over a broken project.
    for (;;) {
      const starting: Array<string> = []
      for (const name of names) {
        const [container] = this.#appContainer(
          await docker(this.#engine.inspectContainer<ContainerInspect>(name))
        )
        const exited =
          !container ||
          container.restarted ||
          (!container.running && !(exitedCleanly && container.exitCode === 0))
        if (exited) {
          this.#log(
            appId,
            deployment,
            `${name} exited right after starting:`,
            "error"
          )
          await this.#tailLogs(
            appId,
            deployment,
            container?.id ?? name,
            container?.tty ?? false
          )
          throw new Error(
            container?.restarted
              ? `${name} keeps exiting, and Docker keeps restarting it`
              : `${name} exited with code ${container?.exitCode ?? "unknown"}`
          )
        }
        if (container.health === "unhealthy") {
          this.#log(
            appId,
            deployment,
            `${name} failed its health check:`,
            "error"
          )
          await this.#tailLogs(appId, deployment, container.id, container.tty)
          throw new Error(`${name} failed its health check`)
        }
        if (container.running && container.health === "starting") {
          if (!waiting.has(name)) {
            waiting.add(name)
            this.#log(
              appId,
              deployment,
              `Waiting for ${name} to pass its health check`
            )
          }
          starting.push(name)
        }
      }
      if (starting.length === 0) break
      if (Date.now() >= deadline) {
        throw new Error(
          `${starting[0]} didn't pass its health check within 10 minutes`
        )
      }
      await sleep(HEALTH_POLL_MS, deployment.abort.signal)
    }
    for (const name of waiting) {
      this.#log(appId, deployment, `${name} is healthy`)
    }
  }

  // Swaps an app's previous containers for a deployment's. The previous ones
  // stop first, since they may hold the host ports the new ones publish, and
  // come back if the new ones fail to start; once they're up, the previous
  // ones are removed.
  async #replacing(
    appId: string,
    deployment: Deployment,
    previous: ReadonlyArray<AppContainer>,
    created: ReadonlyArray<string>,
    start: () => Promise<void>
  ) {
    const running = previous.filter((container) => container.running)
    for (const container of running) {
      this.#log(appId, deployment, `Stopping ${container.name}`)
      await docker(
        this.#engine.stopContainer(container.id, {
          seconds: 30,
          timeout: 60_000,
        })
      )
    }
    const started = await Effect.runPromise(Effect.result(promiseEffect(start)))
    if (Result.isFailure(started)) {
      // Whatever the deployment started makes way for the previous
      // containers; with none to bring back, a failed service stays for its
      // logs.
      const failed =
        running.length > 0
          ? (await this.#appContainers(appId))
              .filter((container) => container.deploymentId === deployment.id)
              .map((container) => container.id)
          : []
      for (const container of new Set([...created, ...failed])) {
        await this.#removeContainer(container)
      }
      for (const container of running) {
        this.#log(appId, deployment, `Restarting ${container.name}`, "warn")
        await docker(
          this.#engine
            .startContainer(container.id, { timeout: 120_000 })
            .pipe(Effect.ignore)
        )
      }
      throw started.failure
    }
    for (const container of previous) {
      this.#log(appId, deployment, `Removing ${container.name}`)
      await this.#removeContainer(container.id)
    }
  }

  // With its anonymous volumes, such as those its image declares: a
  // container keeps nothing past its replacement but what the config mounts.
  async #removeContainer(container: string) {
    await docker(
      this.#engine
        .removeContainer(container, {
          force: true,
          timeout: 90_000,
          volumes: true,
        })
        .pipe(Effect.ignore)
    )
  }

  // Removes one of an app's networks, first disconnecting what else joined
  // it, such as bundled Traefik for the app's routes.
  async #removeNetwork(name: string) {
    const engine = this.#engine
    await docker(
      Effect.gen(function* () {
        const network = yield* engine.inspectNetwork(name)
        for (const container of Object.keys(network.Containers ?? {})) {
          yield* engine
            .disconnectNetwork(name, container, { force: true })
            .pipe(Effect.catchIf(isDockerNotFound, () => Effect.void))
        }
        yield* engine.removeNetwork(name)
      }).pipe(Effect.catchIf(isDockerNotFound, () => Effect.void))
    )
  }

  // A container's last lines, into the deployment log.
  async #tailLogs(
    appId: string,
    deployment: Deployment,
    container: string,
    tty: boolean
  ) {
    await docker(
      this.#engine
        .containerLogLines(
          container,
          { tail: 40, timeout: 15_000, tty },
          (line) => this.#logOutput(appId, deployment, line)
        )
        .pipe(Effect.ignore)
    )
  }

  async #deployCompose(
    input: RelayDeployApp,
    deployment: Deployment,
    host: string,
    checkout: string | null,
    mounts: ReadonlyArray<ConfigMount>
  ) {
    const log = (text: string, level: RelayConsoleLevel = "info") =>
      this.#log(input.appId, deployment, text, level)
    const base = this.#composeProject(input.appId)
    const directory = this.#appDirectory(input.appId)
    const hostDirectory = join(host, "apps", input.appId)
    // A pasted Compose file's relative paths are in the app's own folder on
    // the Relay; a repository's in its own folder of the checkout, so its
    // builds and binds read the repository's files.
    let file = input.config.compose
    let projectDirectory = directory
    const binds = [{ host: hostDirectory, relay: directory }]
    if (checkout && input.github) {
      const found = await checkoutFile(checkout, input.github.path)
      if (!found) {
        throw new Error(`The repository has no file at ${input.github.path}`)
      }
      file = await readFile(found, "utf8")
      projectDirectory = join(checkout, dirname(input.github.path))
      binds.push({
        host: join(host, "app-sources", input.appId, deployment.id),
        relay: checkout,
      })
    }
    const environment = {
      ...process.env,
      ...this.#environment(input.appId, deployment, input.config),
      KILN_APP_ID: input.appId,
    }
    // The standalone Compose binary, which `docker compose` runs.
    const composeArguments = (project: string) => [
      "--ansi",
      "never",
      "-p",
      project,
      "--project-directory",
      projectDirectory,
      "-f",
      "-",
    ]
    const readConfig = (project: string) =>
      traceRelayPromise("relay.apps.deployment.composeConfig", () =>
        composeConfig(
          [...composeArguments(project), "config", "--format", "json"],
          file,
          environment,
          deployment.abort.signal,
          (line) => this.#logOutput(input.appId, deployment, line, "warn")
        )
      )
    log("Reading Compose file")
    const normalized = await readConfig(base)
    await this.#holdingComposeVolumes(
      input.appId,
      base,
      normalized,
      async () => {
        const databases = await this.#connectableDatabases(
          input.appId,
          deployment
        )
        const routes = await this.#networking.routes(input.appId)
        const tailscale = await this.#networking.tailscale(input.appId)
        const options = {
          appId: input.appId,
          binds,
          commit: deployment.commit,
          databases,
          deploymentId: deployment.id,
          mounts,
          routes,
          serviceLimits: input.config.serviceLimits,
          tailscale,
        }
        const previous = await this.#appContainers(input.appId)
        const running = previous.some((container) => container.running)
        const blocker =
          mountsRollingBlocker(mounts) ??
          composeRollingBlocker(normalized, tailscale)
        if (running && blocker) {
          log(`Stopping the running containers first, since ${blocker}`)
        }
        // Every service counts, with the limits the Compose file sets for those
        // Kiln leaves alone.
        const reserve = (
          prepared: ComposeProject,
          apply: (surge: boolean) => Promise<void>,
          surge = false
        ) =>
          this.#reserving(
            input.appId,
            Object.values(prepared.services).map(composeServiceLimits),
            (fits) =>
              traceRelayPromise("relay.apps.deployment.composeUp", () =>
                apply(fits)
              ),
            { surge }
          )
        if (running && blocker === null) {
          // Its own project, so its networks and containers stand apart from
          // the running ones until it takes over.
          const project = `${base}-${deployment.id}`
          const prepared = this.#prepareCompose(await readConfig(project), {
            ...options,
            deferAliases: true,
          })
          log(`Services: ${Object.keys(prepared.services).join(", ")}`)
          let rolled = false
          await reserve(
            prepared,
            async (surge) => {
              if (!surge) {
                log(
                  "Stopping the running containers first, since the node can't hold both copies at once"
                )
                return
              }
              rolled = await this.#rollCompose(
                input,
                deployment,
                composeArguments(project),
                environment,
                prepared,
                previous
              )
            },
            true
          )
          if (rolled) {
            deployment.rolling = true
            await this.#removeComposeNetworks(input.appId, project)
            return
          }
        }
        deployment.rolling = false
        const prepared = this.#prepareCompose(normalized, {
          ...options,
          deferAliases: false,
        })
        if (!running || blocker) {
          log(`Services: ${Object.keys(prepared.services).join(", ")}`)
        }
        // Containers from an image or Dockerfile deployment, or a rolled one,
        // aren't the project's, so Compose's --remove-orphans can't see them.
        const outside = previous.filter(
          (container) => container.labels[COMPOSE_PROJECT_LABEL] !== base
        )
        await reserve(prepared, () =>
          this.#replacing(input.appId, deployment, outside, [], () =>
            this.#composeUp(
              input,
              deployment,
              composeArguments(base),
              environment,
              prepared
            )
          )
        )
        await this.#removeComposeNetworks(input.appId, base)
      }
    )
  }

  /**
   * Runs what makes and starts an App's containers holding, shared, every
   * managed volume its Compose file declares, by the Docker name Compose
   * gives it: one named as external, one it names without (Compose reuses
   * a volume that's already there), and one it names after the project. A
   * Kiln volume, another App's, or its own: a restore of one holds it
   * alone, so it comes wholly before or after, and one whose restore didn't
   * finish refuses the deployment. Kiln's own mounts were held when it was
   * admitted.
   */
  async #holdingComposeVolumes<A>(
    appId: string,
    project: string,
    normalized: ComposeProject,
    run: () => Promise<A>
  ): Promise<A> {
    const projectName = Predicate.isString(normalized.name)
      ? normalized.name
      : project
    const names = Object.entries(normalized.volumes ?? {}).map(
      ([key, volume]) => {
        if (!Predicate.isObject(volume)) return `${projectName}_${key}`
        const external = volume.external
        if (Predicate.isObject(external) && Predicate.isString(external.name)) {
          return external.name
        }
        if (Predicate.isString(volume.name)) return volume.name
        return external === true ? key : `${projectName}_${key}`
      }
    )
    if (names.length === 0) return run()
    const locks = (await this.#volumeIds(names)).map((id) =>
      shared(laneKeys.volume(id))
    )
    const refused = () => this.#lanes.refusalFor("app.deployment", locks)
    const before = refused()
    if (before) throw new Error(before)
    return Effect.runPromise(
      traceRelayEffect(
        "relay.apps.deployment.volumes",
        this.#lanes.runNested(
          { label: "app.deployment.volumes", locks },
          Effect.suspend(() => {
            // A restore it waited for may have left one unfinished.
            const after = refused()
            return after ? Effect.fail(new Error(after)) : promiseEffect(run)
          })
        ),
        { "relay.app_id": appId }
      )
    )
  }

  async #composeUp(
    input: RelayDeployApp,
    deployment: Deployment,
    compose: ReadonlyArray<string>,
    environment: NodeJS.ProcessEnv,
    prepared: ComposeProject
  ) {
    await this.#stream(
      input.appId,
      deployment,
      "docker-compose",
      [
        ...compose,
        "--progress",
        "plain",
        "up",
        "--detach",
        "--build",
        "--remove-orphans",
      ],
      {
        env: environment,
        input: JSON.stringify(prepared),
        timeout: BUILD_TIMEOUT_MS,
      }
    )
    await this.#awaitHealthy(
      input.appId,
      deployment,
      (await this.#appContainers(input.appId))
        .filter((container) => container.deploymentId === deployment.id)
        .map((container) => container.name),
      true
    )
  }

  /**
   * Starts a whole Compose project beside the running one and switches over
   * once every service is healthy. False, with nothing left behind, when a
   * service turns out to keep data in a volume its image declares: two
   * copies would share or lose it, so the project is replaced instead.
   */
  async #rollCompose(
    input: RelayDeployApp,
    deployment: Deployment,
    compose: ReadonlyArray<string>,
    environment: NodeJS.ProcessEnv,
    prepared: ComposeProject,
    previous: ReadonlyArray<AppContainer>
  ): Promise<boolean> {
    const run = (command: ReadonlyArray<string>) =>
      this.#stream(
        input.appId,
        deployment,
        "docker-compose",
        [...compose, "--progress", "plain", ...command],
        {
          env: environment,
          input: JSON.stringify(prepared),
          timeout: BUILD_TIMEOUT_MS,
        }
      )
    const project = compose[compose.indexOf("-p") + 1]!
    const created = async () =>
      (await this.#appContainers(input.appId)).filter(
        (container) => container.deploymentId === deployment.id
      )
    const discard = async () => {
      for (const container of await created()) {
        await docker(
          this.#engine
            .removeContainer(container.id, {
              force: true,
              timeout: 90_000,
              volumes: true,
            })
            .pipe(Effect.ignore)
        )
      }
      await this.#removeComposeNetworks(input.appId, null, project)
    }
    // Created before anything starts, so what each container mounts shows.
    const outcome = await Effect.runPromise(
      Effect.result(
        promiseEffect(async () => {
          await run(["up", "--no-start", "--build", "--remove-orphans"])
          return this.#volumeService(await created())
        })
      )
    )
    if (Result.isFailure(outcome)) {
      await discard()
      throw outcome.failure
    }
    if (outcome.success) {
      this.#log(
        input.appId,
        deployment,
        `Stopping the running containers first, since ${outcome.success} keeps data in a volume`
      )
      await discard()
      return false
    }
    const rolled = await Effect.runPromise(
      Effect.result(
        promiseEffect(() =>
          this.#rollingOver(
            input.appId,
            deployment,
            previous,
            async () => {
              await run(["start"])
              await this.#awaitHealthy(
                input.appId,
                deployment,
                (await created()).map((container) => container.name),
                true
              )
            },
            async () => {
              for (const container of await created()) {
                if (!container.running || !joinsNetworks(container)) continue
                await docker(
                  this.#engine.connectNetwork(
                    this.#networkName(input.appId),
                    container.name,
                    {
                      aliases: [
                        this.#serviceAlias(input.appId, container.service),
                      ],
                    }
                  )
                )
              }
            }
          )
        )
      )
    )
    if (Result.isFailure(rolled)) {
      await this.#removeComposeNetworks(input.appId, null, project)
      throw rolled.failure
    }
    return true
  }

  // The first of these containers that mounts a Docker volume, by service.
  async #volumeService(
    containers: ReadonlyArray<AppContainer>
  ): Promise<string | null> {
    for (const container of containers) {
      const inspected = await docker(
        this.#engine.inspectContainer<ContainerInspect>(container.id)
      )
      // Kiln mounts a volume a service only reads without the image's
      // files, so two copies can share it; one either writes is shared.
      if (
        inspected.Mounts?.some(
          (mount) => mount.Type === "volume" && mount.RW !== false
        )
      ) {
        return container.service
      }
    }
    return null
  }

  /**
   * Removes the networks Compose made for the app's projects: all but
   * `keep`'s, or only `only`'s. Only those Compose named after their project;
   * a network the file names itself outlives projects, since the next
   * project joins it.
   */
  async #removeComposeNetworks(
    appId: string,
    keep: string | null,
    only?: string
  ) {
    const base = this.#composeProject(appId)
    const networks = await docker(
      this.#engine
        .listNetworks({ filters: { label: [COMPOSE_PROJECT_LABEL] } })
        .pipe(Effect.orElseSucceed(() => []))
    )
    for (const network of networks) {
      const project = network.Labels?.[COMPOSE_PROJECT_LABEL]
      if (
        !project ||
        !network.Name.startsWith(`${project}_`) ||
        project === keep ||
        (only !== undefined
          ? project !== only
          : project !== base && !project.startsWith(`${base}-`))
      ) {
        continue
      }
      await this.#removeNetwork(network.Name)
    }
  }

  // Names, labels, and networks every service so its containers are found
  // as the app's, and rewrites binds into the data directory or checkout to
  // the host paths Docker needs. With `deferAliases`, services join the
  // app's network only once healthy, under their names.
  #prepareCompose(
    normalized: ComposeProject,
    options: {
      appId: string
      binds: ReadonlyArray<{ host: string; relay: string }>
      commit: string | null
      databases: ReadonlyArray<string>
      deferAliases: boolean
      deploymentId: string
      // The config's mounts, beside the Compose file's own.
      mounts: ReadonlyArray<ConfigMount>
      routes: AppRoutePlan
      serviceLimits: AppConfig["serviceLimits"]
      tailscale: ReadonlyArray<{
        address: string
        network: string
        service: string
      }>
    }
  ): ComposeProject {
    // Databases and the Traefik edge, joined under the service's alias.
    const joined = [
      ...options.databases,
      ...(options.routes.network ? [options.routes.network] : []),
    ]
    // A path in the data directory or checkout, as Docker on the host sees
    // it, or null for any other.
    const hostPath = (source: string): string | null => {
      const bind = options.binds.find(
        ({ relay }) => source === relay || source.startsWith(`${relay}/`)
      )
      return bind ? `${bind.host}${source.slice(bind.relay.length)}` : null
    }
    for (const mount of options.mounts) {
      if (mount.service !== null && !normalized.services?.[mount.service]) {
        throw new Error(
          `The Compose file has no "${mount.service}" service to mount ${mount.target} in`
        )
      }
    }
    const services: Record<string, ComposeService> = {}
    for (const [name, service] of Object.entries(normalized.services ?? {})) {
      if (!appServiceNameSchema.safeParse(name).success) {
        throw new Error(`Rename the "${name}" service: use letters and digits`)
      }
      const mounts = fileMounts(service, normalized, hostPath)
      const configured = options.mounts
        .filter((mount) => mount.service === null || mount.service === name)
        .map((mount) => ({
          read_only: mount.readOnly,
          source: mount.source,
          target: mount.target,
          type: mount.type,
          ...(mount.type === "volume" &&
            mount.readOnly && { volume: { nocopy: true } }),
        }))
      const networks: Record<string, unknown> = service.network_mode
        ? {}
        : {
            ...(service.networks ?? { default: null }),
            // Compose names each service on every network it joins, so a
            // staged service stays off the app's network until it's ready,
            // when it joins under its alias.
            ...(options.deferAliases
              ? {}
              : {
                  kiln_app: {
                    aliases: [this.#serviceAlias(options.appId, name)],
                  },
                }),
            ...Object.fromEntries(
              joined.map((network) => [
                network,
                { aliases: [this.#serviceAlias(options.appId, name)] },
              ])
            ),
            ...Object.fromEntries(
              options.tailscale
                .filter((membership) => membership.service === name)
                .map((membership) => [
                  membership.network,
                  {
                    aliases: [this.#serviceAlias(options.appId, name)],
                    ipv4_address: membership.address,
                  },
                ])
            ),
          }
      services[name] = {
        ...service,
        ...composeLimits(service, options.serviceLimits[name]),
        container_name: this.#containerName(
          options.appId,
          name,
          options.deploymentId
        ),
        labels: {
          ...service.labels,
          ...composeLiteralLabels(options.routes.labels(name)),
          ...this.#containerLabels(
            options.appId,
            name,
            options.deploymentId,
            options.commit
          ),
        },
        restart: service.restart ?? "unless-stopped",
        ...(service.network_mode ? {} : { networks }),
        ...mounts,
        ...(service.volumes || mounts.volumes || configured.length > 0
          ? {
              volumes: [
                ...(service.volumes ?? []).map((volume) => {
                  if (
                    volume.type !== "bind" ||
                    typeof volume.source !== "string"
                  ) {
                    return volume
                  }
                  const host = hostPath(volume.source)
                  return host ? { ...volume, source: host } : volume
                }),
                ...(mounts.volumes ?? []),
                ...configured,
              ],
            }
          : {}),
      }
    }
    if (Object.keys(services).length === 0) {
      throw new Error("The Compose file has no services")
    }
    const volumes = options.mounts.filter((mount) => mount.type === "volume")
    return {
      ...normalized,
      ...(volumes.length > 0 && {
        // Kiln's volumes exist already, outside the project.
        volumes: {
          ...normalized.volumes,
          ...Object.fromEntries(
            volumes.map((mount) => [
              mount.source,
              { external: true, name: mount.source },
            ])
          ),
        },
      }),
      networks: {
        ...normalized.networks,
        kiln_app: { external: true, name: this.#networkName(options.appId) },
        ...Object.fromEntries(
          [
            ...joined,
            ...options.tailscale.map((membership) => membership.network),
          ].map((network) => [network, { external: true, name: network }])
        ),
      },
      services,
    }
  }

  // The networks of the databases the app is connected to that exist,
  // logging any that don't. Those stay connected, and join once they do.
  async #connectableDatabases(
    appId: string,
    deployment: Deployment
  ): Promise<Array<string>> {
    const databaseIds = (
      await this.#connections.list({ id: appId, kind: "app" })
    ).map((connection) => connection.databaseId)
    const networks = await this.#databaseNetworks(databaseIds)
    for (const id of databaseIds) {
      if (networks.has(id)) {
        this.#log(appId, deployment, `Connecting database ${id.slice(0, 8)}`)
      } else {
        this.#log(
          appId,
          deployment,
          `Database ${id.slice(0, 8)} has no network now; it joins on a later deploy`,
          "warn"
        )
      }
    }
    return [...networks.values()]
  }

  async #databaseNetworks(
    databaseIds: ReadonlyArray<string>
  ): Promise<Map<string, string>> {
    const found = new Map<string, string>()
    for (const id of databaseIds) {
      const network = databaseNetworkName(this.#config, id)
      const inspected = await Effect.runPromise(
        Effect.result(this.#engine.inspectNetwork(network))
      )
      if (
        Result.isSuccess(inspected) &&
        relayOwnsLabels(this.#config, inspected.success.Labels)
      ) {
        found.set(id, network)
      }
    }
    return found
  }

  #environment(
    appId: string,
    deployment: Deployment,
    config: AppConfig
  ): Record<string, string> {
    const environment: Record<string, string> = {}
    for (const [index, raw] of config.environment.split("\n").entries()) {
      const line = raw.trim()
      if (!line || line.startsWith("#")) continue
      const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u)
      if (!match) {
        throw new Error(`Environment line ${index + 1} is not KEY=VALUE`)
      }
      const [, key, value] = match
      if (RESERVED_ENVIRONMENT.test(key!)) {
        this.#log(
          appId,
          deployment,
          `Skipping reserved variable ${key}`,
          "warn"
        )
        continue
      }
      environment[key!] = unquote(value!)
    }
    return environment
  }

  async #stream(
    appId: string,
    deployment: Deployment,
    executable: string,
    arguments_: Array<string>,
    options: { env?: NodeJS.ProcessEnv; input?: string; timeout: number }
  ) {
    await commandLines(
      executable,
      arguments_,
      (line) => this.#logOutput(appId, deployment, line),
      { ...options, signal: deployment.abort.signal }
    )
  }

  #logOutput(
    appId: string,
    deployment: Deployment,
    raw: string,
    level?: RelayConsoleLevel
  ) {
    const parsed = parseConsoleLine(raw)
    if (!parsed) return
    this.#log(appId, deployment, parsed.text, level ?? parsed.level)
  }

  #log(
    appId: string,
    deployment: Deployment,
    text: string,
    level: RelayConsoleLevel = "info"
  ) {
    const index = deployment.dropped + deployment.lines.length
    const line = {
      id: `${deployment.id}-${index}`,
      level,
      text,
      timestamp: new Date().toISOString(),
    }
    deployment.lines.push(line)
    deployment.characters += consoleLineCharacters(line)
    trimDeploymentLog(deployment)
    this.#wake(appId)
  }

  async #ensureResources(appId: string) {
    await mkdir(this.#appDirectory(appId), { recursive: true })
    if ((await this.#networks()).includes(appId)) return
    await docker(
      this.#engine.createNetwork({
        labels: this.#resourceLabels(appId),
        name: this.#networkName(appId),
      })
    )
  }

  #runtimeState(id: string, containers: ReadonlyArray<AppContainer>) {
    const deployment = this.#deployments.get(id) ?? null
    const running = containers.filter((container) => container.running)
    const unhealthy = running.some(
      (container) => container.health === "unhealthy"
    )
    const failed = containers.filter(
      (container) =>
        !container.running &&
        (container.oomKilled || !stoppedCleanly(container))
    )
    const [observedState, status] =
      deployment?.state === "running"
        ? (["starting", "Deploying"] as const)
        : containers.length === 0
          ? deployment?.state === "failed"
            ? (["failed", "Deployment failed"] as const)
            : (["stopped", "Not deployed"] as const)
          : running.length === containers.length
            ? unhealthy
              ? (["failed", "Health check failed"] as const)
              : running.some((container) => container.health === "starting")
                ? (["starting", "Starting"] as const)
                : (["running", "Running"] as const)
            : running.length > 0
              ? ([
                  "running",
                  `${running.length} of ${containers.length} running`,
                ] as const)
              : failed.length > 0
                ? ([
                    "failed",
                    `Exited with code ${failed[0]!.exitCode ?? "unknown"}`,
                  ] as const)
                : (["stopped", "Stopped"] as const)
    return { observedState, status }
  }

  #toApp(
    id: string,
    containers: ReadonlyArray<AppContainer>,
    host: string
  ): RelayApp {
    const deployment = this.#deployments.get(id) ?? null
    const { observedState, status } = this.#runtimeState(id, containers)
    const prefix = this.#databaseNetworkPrefix()
    const connectedDatabaseIds = [
      ...new Set(
        containers.flatMap((container) =>
          container.networks.flatMap((network) => {
            const match = this.#isDatabaseNetwork(network)
              ? network.slice(prefix.length, prefix.length + 40)
              : null
            return match ? [match] : []
          })
        )
      ),
    ]
    return relayAppSchema.parse({
      connectedDatabaseIds,
      savedDatabaseIds: this.#connections
        .saved({ id, kind: "app" })
        .map((connection) => connection.databaseId),
      containers: [...containers]
        .sort(
          (left, right) =>
            left.service.localeCompare(right.service) ||
            newestFirst(left, right)
        )
        .map((container) => ({
          createdAt: container.createdAt,
          exitCode: container.exitCode,
          id: container.id,
          image: container.image,
          labels: container.labels,
          limits: container.limits,
          mounts: container.mounts,
          name: container.name,
          networks: container.networks,
          ports: container.ports,
          running: container.running,
          service: container.service,
          startedAt: container.startedAt,
          state: container.state,
          status: container.status,
        })),
      dataDirectory: join(host, "apps", id),
      deployment: deployment ? deploymentSummary(deployment) : null,
      hostname: this.#hostname(id),
      id,
      network: this.#networkName(id),
      observedState,
      shortId: id.slice(0, 8),
      status,
    })
  }

  async #appContainers(appId: string): Promise<Array<AppContainer>> {
    return (await this.#containers(appId)).filter(
      (container) => container.appId === appId
    )
  }

  async #containers(
    appId?: string,
    ids?: ReadonlyArray<string>,
    signal?: AbortSignal
  ): Promise<Array<AppContainer>> {
    const engine = this.#engine
    const inspected = await docker(
      engine
        .listContainers({
          all: true,
          filters: {
            label: [
              appId ? `${ID_LABEL}=${appId}` : `${KIND_LABEL}=${APP_KIND}`,
            ],
          },
        })
        .pipe(
          Effect.flatMap((containers) =>
            engine.inspectContainers<ContainerInspect>(
              containers
                .filter(
                  (container) =>
                    relayOwnsLabels(this.#config, container.Labels) &&
                    (!ids || ids.includes(container.Labels?.[ID_LABEL] ?? ""))
                )
                .map((container) => container.Id)
            )
          )
        ),
      signal
    )
    return inspected.flatMap((container) => this.#appContainer(container))
  }

  #appContainer(container: ContainerInspect): Array<AppContainer> {
    const labels = container.Config.Labels ?? {}
    const id = labels[ID_LABEL]
    if (
      labels[KIND_LABEL] !== APP_KIND ||
      !id?.match(/^[a-f0-9]{40}$/u) ||
      !relayOwnsLabels(this.#config, labels)
    ) {
      return []
    }
    const service = appServiceNameSchema.safeParse(labels[SERVICE_LABEL])
    const { State: state } = container
    return [
      {
        appId: id,
        createdAt: isoTime(container.Created),
        deploymentId: labels[DEPLOYMENT_LABEL] ?? null,
        exitCode: state.Running ? null : state.ExitCode,
        health: state.Health?.Status ?? null,
        id: container.Id,
        image: labels[IMAGE_LABEL] ?? container.Config.Image,
        imageDigest: labels[IMAGE_DIGEST_LABEL] ?? null,
        imageId: container.Image ?? null,
        labels: Object.fromEntries(
          Object.entries(labels).flatMap(([key, value]) =>
            value === undefined ? [] : [[key, value]]
          )
        ),
        limits: containerResourceLimits(container),
        mounts: (container.Mounts ?? []).map((mount) => ({
          destination: mount.Destination ?? "",
          readOnly: mount.RW === false,
          source: (mount.Type === "volume" ? mount.Name : mount.Source) ?? "",
          type: mount.Type,
        })),
        name: container.Name.replace(/^\//u, ""),
        networkMode: container.HostConfig?.NetworkMode ?? null,
        networks: Object.keys(container.NetworkSettings?.Networks ?? {}),
        oomKilled: state.OOMKilled ?? false,
        ports: publishedPorts(container),
        // Docker reports a container it is about to restart as running.
        restarted:
          (state.Restarting ?? false) || (container.RestartCount ?? 0) > 0,
        running: state.Running,
        service: service.success ? service.data : APP_SERVICE,
        startedAt: state.Running ? isoTime(state.StartedAt) : null,
        state: state.Status,
        status: state.Running
          ? state.Health
            ? `running (${state.Health.Status})`
            : "running"
          : `${state.Status} (${state.ExitCode})`,
        tty: container.Config.Tty ?? false,
      },
    ]
  }

  // App IDs with a network on this Relay: every app has one from creation.
  async #networks(signal?: AbortSignal): Promise<Array<string>> {
    const networks = await docker(
      this.#engine.listNetworks({
        filters: { label: [`${KIND_LABEL}=${APP_KIND}`] },
      }),
      signal
    )
    return networks.flatMap(({ Labels: labels }) => {
      const id = labels?.[ID_LABEL]
      return id?.match(/^[a-f0-9]{40}$/u) &&
        relayOwnsLabels(this.#config, labels)
        ? [id]
        : []
    })
  }

  #prefix(): string {
    return this.#config.resourceNamespace
      ? `${this.#config.resourceNamespace}-`
      : ""
  }

  // kiln-<shortid>-<time>, or kiln-<shortid>-<service>-<time> for Compose.
  #containerName(appId: string, service: string | null, stamp: string) {
    return `${this.#prefix()}kiln-${appId.slice(0, 8)}${service ? `-${service}` : ""}-${stamp}`
  }

  #networkName(appId: string): string {
    return this.#resources.appNetwork(appId)
  }

  #composeProject(appId: string): string {
    return this.#resources.appComposeProject(appId)
  }

  #hostname(appId: string): string {
    return `app-${appId.slice(0, 8)}`
  }

  #serviceAlias(appId: string, service: string): string {
    return this.#resources.appAlias(appId, service)
  }

  #databaseNetworkPrefix(): string {
    return `${this.#prefix()}kiln-db-`
  }

  #isDatabaseNetwork(network: string): boolean {
    const prefix = this.#databaseNetworkPrefix()
    return (
      network.startsWith(prefix) &&
      /^[a-f0-9]{40}-network$/u.test(network.slice(prefix.length))
    )
  }

  #appDirectory(appId: string): string {
    return join(this.rootDirectory, appId)
  }

  #dockerfilePath(appId: string): string {
    return join(this.#config.dataDirectory, "app-builds", `${appId}.Dockerfile`)
  }

  // Where the files an app's config mounts are written, apart from its data
  // directory so the app can't reach them there.
  #mountDirectory(appId: string): string {
    return join(this.#config.dataDirectory, "app-mounts", appId)
  }

  // The config's mounts as Docker takes them: volumes by their Docker name,
  // and files written where the host can bind them, in a folder of the
  // deployment's own, so the running containers' files stay as they are
  // until it replaces them.
  async #configMounts(
    input: RelayDeployApp,
    deployment: Deployment,
    host: string
  ): Promise<Array<ConfigMount>> {
    const directory = join(this.#mountDirectory(input.appId), deployment.id)
    const mounts: Array<ConfigMount> = []
    for (const mount of input.config.mounts) {
      const { readOnly, service, source, target } = mount
      switch (source.type) {
        case "volume": {
          const name = await docker(
            relayVolumeDockerName(this.#config, this.#engine, source.volumeId)
          )
          if (!name) {
            throw new Error(
              `The volume mounted at ${target} no longer exists; choose another`
            )
          }
          mounts.push({
            kind: "volume",
            readOnly,
            service,
            source: name,
            target,
            type: "volume",
          })
          break
        }
        case "host":
          mounts.push({
            kind: "host",
            readOnly,
            service,
            source: source.path,
            target,
            type: "bind",
          })
          break
        case "file":
          await mkdir(directory, { recursive: true })
          await writeFile(join(directory, mount.id), source.content)
          mounts.push({
            kind: "file",
            readOnly,
            service,
            source: join(
              host,
              "app-mounts",
              input.appId,
              deployment.id,
              mount.id
            ),
            target,
            type: "bind",
          })
          break
      }
    }
    return mounts
  }

  #resourceLabels(appId: string): Record<string, string> {
    const labels: Record<string, string> = {
      [ID_LABEL]: appId,
      [KIND_LABEL]: APP_KIND,
      "kiln.relay.owned": "true",
    }
    const owner = relayOwnerLabel(this.#config)
    if (owner) {
      const separator = owner.indexOf("=")
      labels[owner.slice(0, separator)] = owner.slice(separator + 1)
    }
    return labels
  }

  #imageLabels(appId: string): Record<string, string> {
    return { [ID_LABEL]: appId }
  }

  #containerLabels(
    appId: string,
    service: string,
    deploymentId: string,
    commit: string | null
  ): Record<string, string> {
    return {
      ...this.#resourceLabels(appId),
      ...(commit && { [COMMIT_LABEL]: commit }),
      [DEPLOYMENT_LABEL]: deploymentId,
      [SERVICE_LABEL]: service,
    }
  }
}

// What a deployment runs its container from, and the labels that say so.
interface DeployedImage {
  labels: Record<string, string>
  reference: string
}

// One of the config's mounts, resolved for Docker.
interface ConfigMount {
  // Where it comes from in the config.
  kind: "file" | "host" | "volume"
  readOnly: boolean
  service: string | null
  source: string
  target: string
  type: "bind" | "volume"
}

interface ComposeFileReference {
  source: string
  target?: string
  [key: string]: unknown
}

interface ComposeService {
  configs?: Array<ComposeFileReference>
  container_name?: string
  labels?: Record<string, string>
  network_mode?: string
  networks?: Record<string, unknown>
  ports?: Array<{ published?: unknown; [key: string]: unknown }>
  secrets?: Array<ComposeFileReference>
  restart?: string
  volumes?: Array<{ source?: unknown; type?: string; [key: string]: unknown }>
  [key: string]: unknown
}

interface ComposeProject {
  configs?: Record<string, { file?: unknown; [key: string]: unknown }>
  networks?: Record<string, unknown>
  volumes?: Record<string, unknown>
  secrets?: Record<string, { file?: unknown; [key: string]: unknown }>
  services: Record<string, ComposeService>
  [key: string]: unknown
}

// Labels as Compose writes them literally: it interpolates the project it
// reads back, where a route's redirect such as `https://example.com${1}`
// would be a variable, so each $ is doubled.
function composeLiteralLabels(
  labels: Readonly<Record<string, string>>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(labels).map(([key, value]) => [
      key,
      value.replaceAll("$", "$$$$"),
    ])
  )
}

// What `docker-compose config` makes of a Compose file, interpolated and in
// its long form, so services can be changed without parsing YAML here.
function composeConfig(
  arguments_: ReadonlyArray<string>,
  input: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  onWarning: (line: string) => void
): Promise<ComposeProject> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker-compose", arguments_, {
      env,
      signal,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
      if (stdout.length > 4 * 1024 * 1024) child.kill("SIGKILL")
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", reject)
    child.once("close", (code) => {
      const messages = stderr.split("\n").filter((line) => line.trim())
      if (code !== 0) {
        reject(new Error(messages.at(-1) ?? "The Compose file is not valid"))
        return
      }
      for (const message of messages) onWarning(message)
      const parsed = Result.try(() => JSON.parse(stdout) as ComposeProject)
      if (Result.isFailure(parsed) || !parsed.success.services) {
        reject(new Error("Docker Compose returned an unreadable project"))
        return
      }
      resolve(parsed.success)
    })
    child.stdin.on("error", () => undefined)
    child.stdin.end(input)
  })
}

// Configs and secrets a service reads from files in the data directory or
// checkout, as read-only binds of their host paths: Compose mounts them
// from the path it reads, which is the Relay's own, not the host's. The
// service keeps the rest of its configs and secrets.
function fileMounts(
  service: ComposeService,
  project: ComposeProject,
  hostPath: (source: string) => string | null
): Pick<ComposeService, "configs" | "secrets" | "volumes"> {
  const volumes: NonNullable<ComposeService["volumes"]> = []
  const kept = (kind: "configs" | "secrets") =>
    (service[kind] ?? []).filter((reference) => {
      const declared = project[kind]?.[reference.source]
      const host =
        typeof declared?.file === "string" ? hostPath(declared.file) : null
      if (!host) return true
      // As Compose places them: a relative target, or none, under
      // /run/secrets for a secret and / for a config.
      const target = reference.target || reference.source
      volumes.push({
        read_only: true,
        source: host,
        target: target.startsWith("/")
          ? target
          : kind === "secrets"
            ? `/run/secrets/${target}`
            : `/${target}`,
        type: "bind",
      })
      return false
    })
  const configs = kept("configs")
  const secrets = kept("secrets")
  return {
    ...(service.configs && { configs }),
    ...(service.secrets && { secrets }),
    ...(volumes.length > 0 && { volumes }),
  }
}

// Why two copies of a Compose project can't run side by side, if they
// can't: they would share or lose a volume's data, fight over a host port
// or Tailscale address, or share another container's network.
function composeRollingBlocker(
  project: ComposeProject,
  tailscale: ReadonlyArray<{ service: string }>
): string | null {
  for (const [name, service] of Object.entries(project.services ?? {})) {
    // Even read-only: a rolled project names its own volumes anew.
    if (service.volumes?.some((volume) => volume.type === "volume")) {
      return `${name} keeps data in a volume`
    }
    if (service.ports?.some((port) => port.published !== undefined)) {
      return `${name} publishes ports on the Relay`
    }
    if (service.network_mode) return `${name} shares another network`
    if (tailscale.some((membership) => membership.service === name)) {
      return `${name} has a Tailscale address`
    }
  }
  return null
}

// Two copies can't both write to a volume or a path on the node. A file is
// written again for each deployment.
function mountsRollingBlocker(
  mounts: ReadonlyArray<ConfigMount>
): string | null {
  const written = mounts.filter((mount) => !mount.readOnly)
  return written.some((mount) => mount.kind === "volume")
    ? "it keeps data in a volume"
    : written.some((mount) => mount.kind === "host")
      ? "it writes to a path on the node"
      : null
}

// A missing or invalid source fails before anything is deployed.
function sourceProblem(input: RelayDeployApp): string | null {
  const { config } = input
  switch (config.sourceType) {
    case "image":
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]*$/u.test(config.image)) {
        return "Enter an image to deploy, like nginx:latest"
      }
      // A digest to deploy stands in for the image's tag.
      return input.imageDigest && config.image.includes("@")
        ? "The image already names a digest"
        : null
    case "dockerfile":
      return config.dockerfile.trim() ? null : "Add a Dockerfile to build"
    case "compose":
      return config.compose.trim() ? null : "Add a Compose file to deploy"
    case "github":
      return input.github ? null : "Choose a GitHub repository to deploy"
  }
}

function describeSource(input: RelayDeployApp): string {
  const { config } = input
  switch (config.sourceType) {
    case "image":
      return `image ${config.image}`
    case "dockerfile":
      return "Dockerfile"
    case "compose":
      return "Docker Compose"
    case "github":
      return input.github
        ? `${input.github.repository} at ${input.github.commit.slice(0, 7)}, ${input.github.build === "compose" ? "running" : "building"} ${input.github.path}`
        : "GitHub"
  }
}

// Splits a start command the way a shell would, without running one, so it
// works in images that have no shell.
function shellWords(input: string): Array<string> {
  const words: Array<string> = []
  let current = ""
  let started = false
  let quote: '"' | "'" | null = null
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!
    if (quote) {
      if (character === quote) quote = null
      else if (
        character === "\\" &&
        quote === '"' &&
        index + 1 < input.length
      ) {
        current += input[++index]
      } else current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      started = true
    } else if (character === "\\" && index + 1 < input.length) {
      current += input[++index]
      started = true
    } else if (/\s/u.test(character)) {
      if (started) words.push(current)
      current = ""
      started = false
    } else {
      current += character
      started = true
    }
  }
  if (quote) throw new Error("The start command has an unclosed quote")
  if (started) words.push(current)
  return words
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (
    trimmed.length >= 2 &&
    (trimmed[0] === '"' || trimmed[0] === "'") &&
    trimmed.at(-1) === trimmed[0]
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function publishedPorts(container: ContainerInspect): Array<AppPort> {
  const ports = new Map<string, AppPort>()
  for (const [key, bindings] of Object.entries(
    container.NetworkSettings?.Ports ?? {}
  )) {
    const [port, protocol] = key.split("/")
    if (protocol !== "tcp" && protocol !== "udp") continue
    for (const binding of bindings ?? []) {
      const hostPort = Number(binding.HostPort)
      if (!Number.isInteger(hostPort) || hostPort < 1) continue
      ports.set(`${hostPort}/${protocol}`, {
        containerPort: Number(port),
        hostPort,
        protocol,
      })
    }
  }
  return [...ports.values()]
}

// Stopped by Kiln or its own process, rather than crashed.
function stoppedCleanly(container: AppContainer): boolean {
  return (
    container.exitCode === null ||
    [0, 130, 137, 143].includes(container.exitCode)
  )
}

function joinsNetworks(container: AppContainer): boolean {
  return (
    !container.networkMode ||
    !/^(?:host|none|container:)/u.test(container.networkMode)
  )
}

// Whether a container's image is the one `reference` names, as Docker
// reads both.
function sameImage(image: string, reference: ImageReference): boolean {
  const parsed = Result.try(() => parseImageReference(image))
  return (
    Result.isSuccess(parsed) &&
    normalizedReference(parsed.success) === normalizedReference(reference)
  )
}

function newestFirst(
  left: Pick<RelayAppContainer, "createdAt">,
  right: Pick<RelayAppContainer, "createdAt">
): number {
  return (right.createdAt ?? "").localeCompare(left.createdAt ?? "")
}

function isoTime(value: string | undefined): string | null {
  if (!value || value.startsWith("0001-")) return null
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? null : time.toISOString()
}

// One app's containers' limits as one allocation: their memory adds up,
// and CPU, shared, is its widest.
function combinedLimits(
  services: ReadonlyArray<
    Pick<ServiceResourceLimits, "cpuMillis" | "memoryBytes">
  >
): ResourceLimits {
  return {
    cpuMillis: services.reduce<number | null>(
      (widest, service) =>
        service.cpuMillis === null
          ? widest
          : Math.max(widest ?? 0, service.cpuMillis),
      null
    ),
    diskBytes: null,
    memoryBytes: services.reduce<number | null>(
      (total, service) =>
        service.memoryBytes === null
          ? total
          : (total ?? 0) + service.memoryBytes,
      null
    ),
  }
}

// What Hearth sees of a deployment, without its log.
function deploymentSummary(deployment: Deployment): RelayAppDeployment {
  return {
    commit: deployment.commit,
    error: deployment.error,
    finishedAt: deployment.finishedAt,
    id: deployment.id,
    rolling: deployment.rolling,
    sourceType: deployment.sourceType,
    startedAt: deployment.startedAt,
    state: deployment.state,
  }
}

// UTC time to the second, as in kiln-<shortid>-20261009093012.
// The UTC time to the second, as YYYYMMDDHHMMSS, or the second after the
// latest of `earlier` if that isn't past it yet.
function deploymentStamp(earlier: ReadonlyArray<string | undefined>): string {
  const stamp = (time: number) =>
    new Date(time).toISOString().replace(/[-:T]/gu, "").slice(0, 14)
  const now = stamp(Date.now())
  const latest = earlier
    .filter((id): id is string => id !== undefined && /^\d{14}$/u.test(id))
    .sort()
    .at(-1)
  if (latest === undefined || now > latest) return now
  const [year, month, day, hour, minute, second] = latest
    .match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/u)!
    .slice(1)
    .map(Number)
  return stamp(Date.UTC(year!, month! - 1, day, hour, minute, second! + 1))
}

// A directory's deployment logs, newest first: their names are their UTC
// start times.
async function deploymentFiles(directory: string): Promise<Array<string>> {
  return (await readdir(directory))
    .filter((file) => /^\d{14}\.json$/u.test(file))
    .sort()
    .reverse()
}

// Drops a deployment log's oldest lines past its line or character budget.
// Lines keep their IDs, which count the dropped lines.
function trimDeploymentLog(deployment: Deployment): void {
  while (
    deployment.lines.length > MAX_DEPLOYMENT_LINES ||
    (deployment.characters > MAX_CONSOLE_HISTORY_CHARACTERS &&
      deployment.lines.length > 1)
  ) {
    const line = deployment.lines.shift()!
    deployment.characters -= consoleLineCharacters(line)
    deployment.dropped += 1
  }
}

function labelArguments(labels: Readonly<Record<string, string>>) {
  return Object.entries(labels).flatMap(([key, value]) => [
    "--label",
    `${key}=${value}`,
  ])
}

function docker<A>(
  effect: Effect.Effect<A, DockerEngineError>,
  signal?: AbortSignal
): Promise<A> {
  return Effect.runPromise(effect, { signal })
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds)
    function done() {
      signal.removeEventListener("abort", cancel)
      resolve()
    }
    function cancel() {
      clearTimeout(timer)
      reject(new Error("The deployment was cancelled"))
    }
    if (signal.aborted) cancel()
    else signal.addEventListener("abort", cancel, { once: true })
  })
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

// The memory and CPU limits a prepared Compose service starts with, from
// `mem_limit` and `cpus` or else its `deploy.resources.limits`.
function composeServiceLimits(service: ComposeService): ServiceResourceLimits {
  const deploy = Predicate.isObject(service.deploy) ? service.deploy : null
  const resources =
    deploy && Predicate.isObject(deploy.resources) ? deploy.resources : null
  const limits =
    resources && Predicate.isObject(resources.limits) ? resources.limits : null
  const memory = composeNumber(service.mem_limit ?? limits?.memory, ramInBytes)
  const cpus = composeNumber(service.cpus ?? limits?.cpus, Number)
  return {
    cpuMillis:
      cpus === null || cpus <= 0
        ? null
        : Math.round(cpus * CPU_LIMIT_MILLIS_PER_CORE),
    memoryBytes: memory === null || memory <= 0 ? null : memory,
  }
}

// Compose writes sizes and counts as numbers or as strings.
function composeNumber(
  value: unknown,
  parse: (value: string) => number
): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value !== "string" || value.trim() === "") return null
  // Compose itself refuses what it can't read.
  const parsed = Result.try(() => parse(value))
  return Result.isSuccess(parsed) && Number.isFinite(parsed.success)
    ? parsed.success
    : null
}

// A service's limits as Compose sets them; a limit Kiln doesn't set leaves
// the Compose file's own. Compose refuses a service whose `mem_limit` and
// `deploy.resources.limits` differ, so a set limit replaces both.
function composeLimits(
  service: ComposeService,
  limits: ServiceResourceLimits | undefined
): Partial<ComposeService> {
  const memory = limits?.memoryBytes ?? null
  const cpus =
    limits?.cpuMillis == null
      ? null
      : limits.cpuMillis / CPU_LIMIT_MILLIS_PER_CORE
  if (memory === null && cpus === null) return {}
  const deploy = Predicate.isObject(service.deploy) ? service.deploy : null
  const resources =
    deploy && Predicate.isObject(deploy.resources) ? deploy.resources : null
  const deployLimits =
    resources && Predicate.isObject(resources.limits) ? resources.limits : null
  return {
    ...(memory !== null && { mem_limit: memory, memswap_limit: memory }),
    ...(cpus !== null && { cpus }),
    ...(deploy &&
      resources &&
      deployLimits && {
        deploy: {
          ...deploy,
          resources: {
            ...resources,
            limits: {
              ...deployLimits,
              ...(memory !== null && { memory: String(memory) }),
              ...(cpus !== null && { cpus: String(cpus) }),
            },
          },
        },
      }),
  }
}

// Apps with the state of any still provisioning: one that exists shows its
// provisioning until the job finishes, and one that doesn't yet shows its
// placeholder.
function withProvisioning(
  apps: ReadonlyArray<RelayApp>,
  placeholders: ReadonlyMap<string, RelayApp>
): Array<RelayApp> {
  const pending = new Map(placeholders)
  const listed = apps.map((app) => {
    const placeholder = pending.get(app.id)
    if (!placeholder) return app
    pending.delete(app.id)
    return {
      ...app,
      observedState: placeholder.observedState,
      provisioning: placeholder.provisioning,
      status: placeholder.status,
    }
  })
  return [...listed, ...pending.values()]
}
