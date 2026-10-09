import { spawn } from "node:child_process"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type {
  AppConfig,
  AppPort,
  RelayApp,
  RelayAppAction,
  RelayAppContainer,
  RelayAppDeployment,
  RelayAppNetwork,
  RelayConsoleLevel,
  RelayConsoleLine,
  RelayCreateApp,
  RelayDeleteApp,
  RelayDeployApp,
} from "@workspace/contracts"
import { appServiceNameSchema, relayAppSchema } from "@workspace/contracts"
import { Effect, Result, Semaphore } from "effect"

import { command, commandLines } from "./command.js"
import type { RelayConfig } from "./config.js"
import { parseConsoleLine } from "./console-parsing.js"
import { databaseNetworkName } from "./databases.js"
import type { DockerConsoleSession } from "./docker.js"
import { forkPromise, promiseEffect } from "./effect/promise.js"
import {
  APP_SERVICE,
  relayOwnerLabel,
  relayOwnsLabels,
  relayResourceNames,
  type RelayResourceNames,
} from "./relay-resources.js"

// Apps are found by their labels, like databases: the Relay keeps nothing
// about them besides their data directory and the logs of their recent
// deployments.
const KIND_LABEL = "kiln.resource.kind"
const APP_KIND = "app"
const ID_LABEL = "kiln.app.id"
const SERVICE_LABEL = "kiln.app.service"
const DEPLOYMENT_LABEL = "kiln.app.deployment"
// The console stream that follows an app's deployments; its services'
// streams are `service:<name>`.
export const APP_DEPLOYMENT_STREAM = "deployment"
const SERVICE_STREAM_PREFIX = "service:"
const MAX_DEPLOYMENT_LINES = 5_000
// Finished deployments' logs kept per app, newest first.
const KEPT_DEPLOYMENTS = 20
const PULL_TIMEOUT_MS = 15 * 60_000
const BUILD_TIMEOUT_MS = 30 * 60_000
// How long a new container must stay up before its deployment succeeds.
const SETTLE_MS = 3_000
// Variables Docker and Compose read themselves; an app's environment can't
// steer the Relay's own Docker client with them.
const RESERVED_ENVIRONMENT =
  /^(?:PATH|HOME|DOCKER_\w*|COMPOSE_\w*|BUILDKIT_\w*|BUILDX_\w*)$/u

interface ContainerInspect {
  Config: {
    Image: string
    Labels: Record<string, string | undefined> | null
  }
  Created: string
  HostConfig?: { NetworkMode?: string }
  Id: string
  Name: string
  NetworkSettings?: {
    Networks?: Record<string, unknown> | null
    Ports?: Record<string, Array<{ HostPort?: string }> | null> | null
  }
  State: {
    ExitCode: number
    Health?: { Status: string }
    OOMKilled?: boolean
    Running: boolean
    StartedAt?: string
    Status: string
  }
}

interface AppContainer extends RelayAppContainer {
  appId: string
  deploymentId: string | null
  health: string | null
  networkMode: string | null
  oomKilled: boolean
}

interface Deployment extends RelayAppDeployment {
  abort: AbortController
  // Lines dropped from the front once the log reached its limit.
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
export interface AppNetworking {
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
  readonly #resources: RelayResourceNames
  readonly #hostDataDirectory: () => Promise<string>
  readonly #networking: AppNetworking
  readonly #deployments = new Map<string, Deployment>()
  // Apps whose latest deployment has been read back from disk this run.
  readonly #restored = new Set<string>()
  // Wakes whatever follows an app when its deployment or containers change.
  readonly #waiters = new Map<string, Set<() => void>>()
  readonly #mutations = new Map<
    string,
    { semaphore: Semaphore.Semaphore; references: number }
  >()

  constructor(
    config: RelayConfig,
    hostDataDirectory: () => Promise<string>,
    networking: AppNetworking
  ) {
    this.#config = config
    this.#resources = relayResourceNames(config)
    this.#hostDataDirectory = hostDataDirectory
    this.#networking = networking
  }

  // Where app data directories live inside the Relay.
  get rootDirectory(): string {
    return join(this.#config.dataDirectory, "apps")
  }

  async list(): Promise<Array<RelayApp>> {
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

  async get(appId: string): Promise<RelayApp> {
    const app = (await this.list()).find((candidate) => candidate.id === appId)
    if (!app) throw new Error("App not found")
    return app
  }

  create(input: RelayCreateApp): Promise<RelayApp> {
    return this.#serialize(input.id, async () => {
      if ((await this.#networks()).includes(input.id)) {
        throw new Error("App already exists")
      }
      await this.#ensureResources(input.id)
      return this.get(input.id)
    })
  }

  async deploy(input: RelayDeployApp): Promise<RelayApp> {
    const current = this.#deployments.get(input.appId)
    if (current?.state === "running") {
      throw new Error("A deployment is already running")
    }
    const problem = sourceProblem(input.config)
    if (problem) throw new Error(problem)
    await this.get(input.appId)
    const deployment: Deployment = {
      abort: new AbortController(),
      dropped: 0,
      error: null,
      finishedAt: null,
      id: deploymentStamp(),
      lines: [],
      sourceType: input.config.sourceType,
      startedAt: new Date().toISOString(),
      state: "running",
    }
    this.#deployments.set(input.appId, deployment)
    this.#wake(input.appId)
    forkPromise(() =>
      this.#serialize(input.appId, () => this.#runDeployment(input, deployment))
    )
    return this.get(input.appId)
  }

  action(input: RelayAppAction): Promise<RelayApp> {
    return this.#serialize(input.appId, async () => {
      const containers = await this.#appContainers(input.appId)
      if (containers.length === 0) throw new Error("Deploy the app first")
      const ids = containers.map((container) => container.id)
      if (input.action === "stop") {
        await command("docker", ["stop", "--time", "30", ...ids], {
          timeout: 90_000,
        })
      } else if (input.action === "start") {
        await command("docker", ["start", ...ids], { timeout: 120_000 })
      } else {
        await command("docker", ["restart", "--time", "30", ...ids], {
          timeout: 150_000,
        })
      }
      this.#wake(input.appId)
      return this.get(input.appId)
    })
  }

  async delete(input: RelayDeleteApp) {
    // A running deployment would otherwise hold the app until it finished.
    this.#deployments.get(input.appId)?.abort.abort()
    return this.#serialize(input.appId, async () => {
      const containers = await this.#appContainers(input.appId)
      if (
        containers.length === 0 &&
        !(await this.#networks()).includes(input.appId)
      ) {
        throw new Error("App not found")
      }
      if (containers.length > 0) {
        await command(
          "docker",
          ["rm", "--force", ...containers.map((container) => container.id)],
          { timeout: 90_000 }
        )
      }
      const project = this.#composeProject(input.appId)
      for (const network of await listIds("network", [
        `label=com.docker.compose.project=${project}`,
      ])) {
        await ignoreCommand(["network", "rm", network])
      }
      if (input.deleteData) {
        for (const volume of await listIds("volume", [
          `label=com.docker.compose.project=${project}`,
        ])) {
          await ignoreCommand(["volume", "rm", "--force", volume])
        }
      }
      await ignoreCommand(["network", "rm", this.#networkName(input.appId)])
      // Built images are only cleanup; a failure to list them doesn't stop
      // the app's removal.
      const images = await Effect.runPromise(
        promiseEffect(() =>
          listIds("image", [`label=${ID_LABEL}=${input.appId}`])
        ).pipe(Effect.orElseSucceed((): Array<string> => []))
      )
      for (const image of images) {
        await ignoreCommand(["image", "rm", "--force", image])
      }
      await rm(this.#dockerfilePath(input.appId), { force: true })
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
      this.#deployments.delete(input.appId)
      this.#wake(input.appId)
      return { appId: input.appId, deleted: true }
    })
  }

  updateNetwork(input: RelayAppNetwork): Promise<RelayApp> {
    return this.#serialize(input.appId, async () => {
      await this.get(input.appId)
      const desired = await this.#databaseNetworks(input.databaseIds)
      const missing = input.databaseIds.filter((id) => !desired.has(id))
      if (missing.length > 0) {
        throw new Error(`Database ${missing[0]!.slice(0, 8)} was not found`)
      }
      const wanted = new Set(desired.values())
      for (const container of await this.#appContainers(input.appId)) {
        if (!joinsNetworks(container)) continue
        const attached = container.networks.filter((network) =>
          this.#isDatabaseNetwork(network)
        )
        for (const network of wanted) {
          if (attached.includes(network)) continue
          await command("docker", [
            "network",
            "connect",
            "--alias",
            this.#serviceAlias(input.appId, container.service),
            network,
            container.id,
          ])
        }
        for (const network of attached) {
          if (wanted.has(network)) continue
          await ignoreCommand(["network", "disconnect", network, container.id])
        }
      }
      this.#wake(input.appId)
      return this.get(input.appId)
    })
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
        next = Math.max(next, deployment.dropped)
        while (next < deployment.dropped + deployment.lines.length) {
          yield deployment.lines[next - deployment.dropped]!
          next += 1
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
          const { config } = input
          log(`Deploying ${input.name} (deployment ${deployment.id})`)
          log(`Source: ${describeSource(config)}`)
          await this.#ensureResources(input.appId)
          const host = await this.#hostDataDirectory()
          if (config.sourceType === "compose") {
            await this.#deployCompose(input, deployment, host)
          } else {
            const image =
              config.sourceType === "image"
                ? await this.#pullImage(input, deployment)
                : await this.#buildImage(input, deployment)
            await this.#replaceContainer(input, deployment, image, host)
          }
        })
      )
    )
    const seconds = ((Date.now() - startedAt) / 1_000).toFixed(1)
    const message = Result.isSuccess(outcome)
      ? null
      : deployment.abort.signal.aborted
        ? "The deployment was cancelled"
        : errorMessage(outcome.failure)
    if (message === null) log(`Deployment finished in ${seconds}s`)
    else log(`Deployment failed after ${seconds}s: ${message}`, "error")
    const finished = {
      error: message?.slice(0, 2_000) ?? null,
      finishedAt: new Date().toISOString(),
      state: message === null ? ("succeeded" as const) : ("failed" as const),
    }
    // Saved before it shows as finished, so a finished deployment's log is
    // always on disk.
    await this.#saveDeployment(input.appId, { ...deployment, ...finished })
    Object.assign(deployment, finished)
    this.#wake(input.appId)
  }

  // Writes a finished deployment's log, keeping the newest few per app. A
  // log that can't be written only costs its history.
  async #saveDeployment(appId: string, deployment: Deployment) {
    const directory = this.#deploymentDirectory(appId)
    await Effect.runPromise(
      promiseEffect(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const { abort: _abort, ...saved } = deployment
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

  // The latest deployment from before the Relay restarted, if any.
  async #restoreDeployment(appId: string) {
    if (this.#restored.has(appId) || this.#deployments.has(appId)) return
    this.#restored.add(appId)
    const directory = this.#deploymentDirectory(appId)
    const restored = await Effect.runPromise(
      promiseEffect(async () => {
        const [latest] = await deploymentFiles(directory)
        if (!latest) return null
        const saved = JSON.parse(
          await readFile(join(directory, latest), "utf8")
        ) as Omit<Deployment, "abort">
        return { ...saved, abort: new AbortController() } satisfies Deployment
      }).pipe(Effect.orElseSucceed(() => null))
    )
    if (restored && !this.#deployments.has(appId)) {
      this.#deployments.set(appId, restored)
    }
  }

  #deploymentDirectory(appId: string): string {
    return join(this.#config.dataDirectory, "app-deployments", appId)
  }

  async #pullImage(input: RelayDeployApp, deployment: Deployment) {
    const image = input.config.image
    this.#log(input.appId, deployment, `Pulling ${image}`)
    await this.#stream(input.appId, deployment, ["pull", image], {
      timeout: PULL_TIMEOUT_MS,
    })
    return image
  }

  // Builds with the app's data directory as the context, so a Dockerfile
  // can COPY files uploaded to the app.
  async #buildImage(input: RelayDeployApp, deployment: Deployment) {
    const tag = `kiln-app-${input.appId}:${deployment.id}`
    const dockerfile = this.#dockerfilePath(input.appId)
    await mkdir(join(this.#config.dataDirectory, "app-builds"), {
      recursive: true,
      mode: 0o700,
    })
    await writeFile(dockerfile, input.config.dockerfile, { mode: 0o600 })
    this.#log(input.appId, deployment, `Building ${tag}`)
    await this.#stream(
      input.appId,
      deployment,
      [
        "build",
        "--progress",
        "plain",
        ...labelArguments(this.#imageLabels(input.appId)),
        "--tag",
        tag,
        "--file",
        dockerfile,
        this.#appDirectory(input.appId),
      ],
      { timeout: BUILD_TIMEOUT_MS }
    )
    return tag
  }

  async #replaceContainer(
    input: RelayDeployApp,
    deployment: Deployment,
    image: string,
    host: string
  ) {
    const log = (text: string, level: RelayConsoleLevel = "info") =>
      this.#log(input.appId, deployment, text, level)
    const { config } = input
    const previous = await this.#appContainers(input.appId)
    const name = this.#containerName(input.appId, null, deployment.id)
    const hostname = this.#hostname(input.appId)
    const environment = this.#environment(input.appId, deployment, config)
    const databases = await this.#connectableDatabases(
      input.appId,
      deployment,
      config.databaseIds
    )
    const routes = await this.#networking.routes(input.appId)
    const tailscale = (await this.#networking.tailscale(input.appId)).filter(
      (membership) => membership.service === APP_SERVICE
    )
    await command(
      "docker",
      [
        "create",
        "--name",
        name,
        "--hostname",
        hostname,
        "--network",
        this.#networkName(input.appId),
        "--network-alias",
        hostname,
        "--restart",
        "unless-stopped",
        "--mount",
        `type=bind,source=${join(host, "apps", input.appId)},target=${config.dataMount}`,
        ...labelArguments({
          ...routes.labels(APP_SERVICE),
          ...this.#containerLabels(input.appId, APP_SERVICE, deployment.id),
        }),
        ...Object.entries(environment).flatMap(([key, value]) => [
          "--env",
          `${key}=${value}`,
        ]),
        ...config.ports.flatMap((port) => [
          "--publish",
          `${port.hostPort}:${port.containerPort}/${port.protocol}`,
        ]),
        image,
        ...shellWords(config.command),
      ],
      { timeout: 120_000 }
    )
    log(`Created container ${name}`)
    for (const network of [
      ...databases,
      ...(routes.network ? [routes.network] : []),
    ]) {
      await command("docker", [
        "network",
        "connect",
        "--alias",
        hostname,
        network,
        name,
      ])
    }
    // Tailscale members keep their address, which the new container takes
    // once the previous one stops.
    for (const membership of tailscale) {
      await command("docker", [
        "network",
        "connect",
        "--ip",
        membership.address,
        "--alias",
        hostname,
        membership.network,
        name,
      ])
    }
    // The previous containers stop first: they may hold the host ports the
    // new one publishes. They come back if the new one fails to start.
    const running = previous.filter((container) => container.running)
    for (const container of running) {
      log(`Stopping ${container.name}`)
      await command("docker", ["stop", "--time", "30", container.id], {
        timeout: 60_000,
      })
    }
    const started = await Effect.runPromise(
      Effect.result(
        promiseEffect(async () => {
          await command("docker", ["start", name], { timeout: 120_000 })
          log(`Started ${name}`)
          await this.#settle(input.appId, deployment, name)
        })
      )
    )
    if (Result.isFailure(started)) {
      await ignoreCommand(["rm", "--force", name])
      for (const container of running) {
        log(`Restarting ${container.name}`, "warn")
        await ignoreCommand(["start", container.id])
      }
      throw started.failure
    }
    for (const container of previous) {
      log(`Removing ${container.name}`)
      await ignoreCommand(["rm", "--force", container.id])
    }
  }

  // Waits briefly so a container that exits right away fails its
  // deployment, with its last output in the deployment log.
  async #settle(appId: string, deployment: Deployment, name: string) {
    await sleep(SETTLE_MS, deployment.abort.signal)
    const inspected = JSON.parse(
      (await command("docker", ["inspect", name])).stdout
    ) as Array<ContainerInspect>
    const state = inspected[0]?.State
    if (state?.Running) return
    this.#log(
      appId,
      deployment,
      `${name} exited right after starting:`,
      "error"
    )
    await recoverCommandLines(["logs", "--tail", "40", name], (line) =>
      this.#logOutput(appId, deployment, line)
    )
    throw new Error(`${name} exited with code ${state?.ExitCode ?? "unknown"}`)
  }

  async #deployCompose(
    input: RelayDeployApp,
    deployment: Deployment,
    host: string
  ) {
    const log = (text: string, level: RelayConsoleLevel = "info") =>
      this.#log(input.appId, deployment, text, level)
    const project = this.#composeProject(input.appId)
    const directory = this.#appDirectory(input.appId)
    const hostDirectory = join(host, "apps", input.appId)
    const environment = {
      ...process.env,
      ...this.#environment(input.appId, deployment, input.config),
      KILN_APP_ID: input.appId,
      KILN_DATA: hostDirectory,
    }
    const compose = ["compose", "--ansi", "never", "-p", project]
    compose.push("--project-directory", directory, "-f", "-")
    log("Reading Compose file")
    const normalized = await composeConfig(
      [...compose, "config", "--format", "json"],
      input.config.compose,
      environment,
      deployment.abort.signal,
      (line) => this.#logOutput(input.appId, deployment, line, "warn")
    )
    const databases = await this.#connectableDatabases(
      input.appId,
      deployment,
      input.config.databaseIds
    )
    const prepared = this.#prepareCompose(normalized, {
      appId: input.appId,
      databases,
      routes: await this.#networking.routes(input.appId),
      tailscale: await this.#networking.tailscale(input.appId),
      deploymentId: deployment.id,
      directory,
      hostDirectory,
    })
    log(`Services: ${Object.keys(prepared.services).join(", ")}`)
    await this.#stream(
      input.appId,
      deployment,
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
    await sleep(SETTLE_MS, deployment.abort.signal)
    const containers = await this.#appContainers(input.appId)
    const exited = containers.filter(
      (container) =>
        container.deploymentId === deployment.id &&
        !container.running &&
        container.exitCode !== 0
    )
    for (const container of exited) {
      log(`${container.name} exited with code ${container.exitCode}:`, "error")
      await recoverCommandLines(
        ["logs", "--tail", "40", container.id],
        (line) => this.#logOutput(input.appId, deployment, line)
      )
    }
    if (exited.length > 0) {
      throw new Error(
        `${exited.map((container) => container.service).join(", ")} exited after starting`
      )
    }
  }

  // Names, labels, and networks every service so its containers are found
  // as the app's, and rewrites binds into the data directory to the host
  // path Docker needs.
  #prepareCompose(
    normalized: ComposeProject,
    options: {
      appId: string
      databases: ReadonlyArray<string>
      deploymentId: string
      directory: string
      hostDirectory: string
      routes: AppRoutePlan
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
    const services: Record<string, ComposeService> = {}
    for (const [name, service] of Object.entries(normalized.services ?? {})) {
      if (!appServiceNameSchema.safeParse(name).success) {
        throw new Error(`Rename the "${name}" service: use letters and digits`)
      }
      const networks: Record<string, unknown> = service.network_mode
        ? {}
        : {
            ...(service.networks ?? { default: null }),
            kiln_app: {
              aliases: [this.#serviceAlias(options.appId, name)],
            },
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
        container_name: this.#containerName(
          options.appId,
          name,
          options.deploymentId
        ),
        labels: {
          ...service.labels,
          ...options.routes.labels(name),
          ...this.#containerLabels(options.appId, name, options.deploymentId),
        },
        restart: service.restart ?? "unless-stopped",
        ...(service.network_mode ? {} : { networks }),
        ...(service.volumes
          ? {
              volumes: service.volumes.map((volume) =>
                volume.type === "bind" &&
                typeof volume.source === "string" &&
                (volume.source === options.directory ||
                  volume.source.startsWith(`${options.directory}/`))
                  ? {
                      ...volume,
                      source: `${options.hostDirectory}${volume.source.slice(options.directory.length)}`,
                    }
                  : volume
              ),
            }
          : {}),
      }
    }
    if (Object.keys(services).length === 0) {
      throw new Error("The Compose file has no services")
    }
    return {
      ...normalized,
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

  // The networks of the app's databases that exist, logging any that don't.
  async #connectableDatabases(
    appId: string,
    deployment: Deployment,
    databaseIds: ReadonlyArray<string>
  ): Promise<Array<string>> {
    const networks = await this.#databaseNetworks(databaseIds)
    for (const id of databaseIds) {
      if (networks.has(id)) {
        this.#log(appId, deployment, `Connecting database ${id.slice(0, 8)}`)
      } else {
        this.#log(
          appId,
          deployment,
          `Database ${id.slice(0, 8)} was not found; skipping it`,
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
        Effect.result(
          promiseEffect(() =>
            command("docker", [
              "network",
              "inspect",
              "--format",
              "{{json .Labels}}",
              network,
            ])
          )
        )
      )
      if (Result.isFailure(inspected)) continue
      const labels = JSON.parse(inspected.success.stdout) as Record<
        string,
        string
      > | null
      if (relayOwnsLabels(this.#config, labels)) found.set(id, network)
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
    arguments_: Array<string>,
    options: { env?: NodeJS.ProcessEnv; input?: string; timeout: number }
  ) {
    await commandLines(
      "docker",
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
    deployment.lines.push({
      id: `${deployment.id}-${index}`,
      level,
      text,
      timestamp: new Date().toISOString(),
    })
    if (deployment.lines.length > MAX_DEPLOYMENT_LINES) {
      deployment.lines.shift()
      deployment.dropped += 1
    }
    this.#wake(appId)
  }

  async #ensureResources(appId: string) {
    await mkdir(this.#appDirectory(appId), { recursive: true })
    if ((await this.#networks()).includes(appId)) return
    await command("docker", [
      "network",
      "create",
      ...labelArguments(this.#resourceLabels(appId)),
      this.#networkName(appId),
    ])
  }

  #toApp(
    id: string,
    containers: ReadonlyArray<AppContainer>,
    host: string
  ): RelayApp {
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
      deployment: deployment
        ? {
            error: deployment.error,
            finishedAt: deployment.finishedAt,
            id: deployment.id,
            sourceType: deployment.sourceType,
            startedAt: deployment.startedAt,
            state: deployment.state,
          }
        : null,
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

  async #containers(appId?: string): Promise<Array<AppContainer>> {
    const ids = await listIds("container", [
      appId ? `label=${ID_LABEL}=${appId}` : `label=${KIND_LABEL}=${APP_KIND}`,
    ])
    if (ids.length === 0) return []
    const inspected = JSON.parse(
      (await command("docker", ["inspect", ...ids])).stdout
    ) as Array<ContainerInspect>
    return inspected.flatMap((container) => {
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
      return [
        {
          appId: id,
          createdAt: isoTime(container.Created),
          deploymentId: labels[DEPLOYMENT_LABEL] ?? null,
          exitCode: container.State.Running ? null : container.State.ExitCode,
          health: container.State.Health?.Status ?? null,
          id: container.Id,
          image: container.Config.Image,
          labels: Object.fromEntries(
            Object.entries(labels).flatMap(([key, value]) =>
              value === undefined ? [] : [[key, value]]
            )
          ),
          name: container.Name.replace(/^\//u, ""),
          networkMode: container.HostConfig?.NetworkMode ?? null,
          networks: Object.keys(container.NetworkSettings?.Networks ?? {}),
          oomKilled: container.State.OOMKilled ?? false,
          ports: publishedPorts(container),
          running: container.State.Running,
          service: service.success ? service.data : APP_SERVICE,
          startedAt: container.State.Running
            ? isoTime(container.State.StartedAt)
            : null,
          state: container.State.Status,
          status: container.State.Running
            ? container.State.Health
              ? `running (${container.State.Health.Status})`
              : "running"
            : `${container.State.Status} (${container.State.ExitCode})`,
        },
      ]
    })
  }

  // App IDs with a network on this Relay: every app has one from creation.
  async #networks(): Promise<Array<string>> {
    const ids = await listIds("network", [`label=${KIND_LABEL}=${APP_KIND}`])
    if (ids.length === 0) return []
    const result = await command("docker", [
      "network",
      "inspect",
      "--format",
      "{{json .Labels}}",
      ...ids,
    ])
    return result.stdout.split("\n").flatMap((line) => {
      if (!line.trim()) return []
      const labels = JSON.parse(line) as Record<string, string> | null
      const id = labels?.[ID_LABEL]
      return id?.match(/^[a-f0-9]{40}$/u) &&
        relayOwnsLabels(this.#config, labels)
        ? [id]
        : []
    })
  }

  #serialize<T>(appId: string, run: () => Promise<T>): Promise<T> {
    let entry = this.#mutations.get(appId)
    if (!entry) {
      entry = { semaphore: Semaphore.makeUnsafe(1), references: 0 }
      this.#mutations.set(appId, entry)
    }
    entry.references += 1
    const active = entry
    return Effect.runPromise(
      active.semaphore.withPermit(promiseEffect(run)).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            active.references -= 1
            if (active.references === 0) this.#mutations.delete(appId)
          })
        )
      )
    ) as Promise<T>
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
    return `${this.#prefix()}kiln-app-${appId}`
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
    deploymentId: string
  ): Record<string, string> {
    return {
      ...this.#resourceLabels(appId),
      [DEPLOYMENT_LABEL]: deploymentId,
      [SERVICE_LABEL]: service,
    }
  }
}

interface ComposeService {
  container_name?: string
  labels?: Record<string, string>
  network_mode?: string
  networks?: Record<string, unknown>
  restart?: string
  volumes?: Array<{ source?: unknown; type?: string; [key: string]: unknown }>
  [key: string]: unknown
}

interface ComposeProject {
  networks?: Record<string, unknown>
  services: Record<string, ComposeService>
  [key: string]: unknown
}

// What `docker compose config` makes of a Compose file, interpolated and in
// its long form, so services can be changed without parsing YAML here.
function composeConfig(
  arguments_: ReadonlyArray<string>,
  input: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  onWarning: (line: string) => void
): Promise<ComposeProject> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", arguments_, {
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

// A missing or invalid source fails before anything is deployed.
function sourceProblem(config: AppConfig): string | null {
  switch (config.sourceType) {
    case "image":
      return /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]*$/u.test(config.image)
        ? null
        : "Enter an image to deploy, like nginx:latest"
    case "dockerfile":
      return config.dockerfile.trim() ? null : "Add a Dockerfile to build"
    case "compose":
      return config.compose.trim() ? null : "Add a Compose file to deploy"
  }
}

function describeSource(config: AppConfig): string {
  switch (config.sourceType) {
    case "image":
      return `image ${config.image}`
    case "dockerfile":
      return "Dockerfile"
    case "compose":
      return "Docker Compose"
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

// UTC time to the second, as in kiln-<shortid>-20261009093012.
function deploymentStamp(): string {
  return new Date().toISOString().replace(/[-:T]/gu, "").slice(0, 14)
}

// A directory's deployment logs, newest first: their names are their UTC
// start times.
async function deploymentFiles(directory: string): Promise<Array<string>> {
  return (await readdir(directory))
    .filter((file) => /^\d{14}\.json$/u.test(file))
    .sort()
    .reverse()
}

function labelArguments(labels: Readonly<Record<string, string>>) {
  return Object.entries(labels).flatMap(([key, value]) => [
    "--label",
    `${key}=${value}`,
  ])
}

async function listIds(
  kind: "container" | "image" | "network" | "volume",
  filters: ReadonlyArray<string>
): Promise<Array<string>> {
  const result = await command("docker", [
    kind,
    "ls",
    ...(kind === "container" ? ["--all"] : []),
    ...filters.flatMap((filter) => ["--filter", filter]),
    "--format",
    "{{.ID}}",
  ])
  return [...new Set(result.stdout.split("\n").filter(Boolean))]
}

async function ignoreCommand(arguments_: Array<string>): Promise<void> {
  await Effect.runPromise(
    promiseEffect(() =>
      command("docker", arguments_, { timeout: 90_000 })
    ).pipe(Effect.ignore)
  )
}

async function recoverCommandLines(
  arguments_: Array<string>,
  onLine: (line: string) => void
): Promise<void> {
  await Effect.runPromise(
    promiseEffect(() =>
      commandLines("docker", arguments_, onLine, { timeout: 15_000 })
    ).pipe(Effect.ignore)
  )
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
