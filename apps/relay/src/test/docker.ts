/**
 * A stateful, in-memory Docker for Relay tests.
 *
 * Relay drives Docker through the Engine API on `config.dockerSocket`, and
 * the CLI (`./command.js`) for builds and Compose. Tests replace both at that
 * boundary:
 *
 *   vi.mock("./command.js", () => import("./test/docker.js"))
 *   config.dockerSocket = await fakeDocker.listen()
 *
 * Requests mutate containers, networks, volumes, and images the way Docker
 * would, so tests assert the resulting state instead of argv or call order.
 * Only what Relay actually invokes is modelled; anything else fails loudly and
 * is reported by `reset()`.
 */
import { randomBytes } from "node:crypto"
import { rmSync } from "node:fs"
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import type { Duplex } from "node:stream"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"

import { Effect, Result } from "effect"

import type { CommandOptions, CommandResult } from "../command.js"
import {
  normalizedReference,
  parseImageReference,
} from "../docker-reference.js"
import { CommandError } from "../effect/errors.js"

export type PortBindings = Record<
  string,
  Array<{ HostIp: string; HostPort: string }>
>

export interface FakeMount {
  readonly destination: string
  readonly readOnly?: boolean
  /** Host path for bind mounts, volume name for volume mounts. */
  readonly source: string
  readonly type: "bind" | "volume"
  /**
   * A volume Docker named itself, from `-v /path` or an image's VOLUME. It
   * appears only in `Config.Volumes`, so a container created from the same
   * configuration gets a new, empty one.
   */
  readonly anonymous?: boolean
}

export interface FakeContainer {
  readonly id: string
  name: string
  image: string
  hostname: string
  labels: Record<string, string>
  env: Record<string, string>
  cmd: Array<string>
  tty: boolean
  openStdin: boolean
  restartPolicy: string
  memoryBytes: number
  mounts: Array<FakeMount>
  portBindings: PortBindings
  networkMode: string
  networks: Map<string, { aliases: Array<string>; ipAddress: string }>
  healthCheck: boolean
  state: {
    running: boolean
    restarting: boolean
    exitCode: number
    oomKilled: boolean
    startedAt: string
    finishedAt: string
    health?: "healthy" | "starting" | "unhealthy"
  }
  /** Number of times Docker started this container after it was created. */
  starts: number
  /** `--rm`: Docker removes it once it exits. */
  autoRemove: boolean
  /** Containers whose volumes it mounts (`--volumes-from`). */
  volumesFrom: Array<string>
  /** Running once with stdin attached before it started (`run --rm -i`). */
  runOnce: { input: Array<Buffer>; socket: Duplex; stdinEnded: boolean } | null
  logs: Array<{ text: string; time: string }>
  /**
   * Set to make reading this container's (non-TTY) logs fail after the
   * lines, the way Docker reports an error once it has answered 200.
   */
  logStreamError: string | null
  /** Whether the last log read was sent in full or its reader hung up. */
  lastLogRead: "abandoned" | "complete" | null
  /** Everything written to the container's console through `attach`. */
  stdin: string
  /** Processes run with `docker exec`, as the container saw them. */
  processes: Array<{
    argv: Array<string>
    env: Record<string, string>
    user?: string
  }>
  /** What a database client in the container dumps. */
  sqlDump: string
  /** SQL database clients in the container were given on stdin. */
  executedSql: Array<string>
  /** iptables chains inside the container's network namespace. */
  firewall: Map<string, Array<string>>
  /** TCP ports the container's process is listening on. */
  listeningPorts: Array<number>
}

/** A process started with `docker exec`; its TTY echoes what it receives. */
export interface FakeExec {
  readonly id: string
  readonly containerId: string
  readonly cmd: Array<string>
  readonly env: Record<string, string>
  readonly tty: boolean
  readonly attachStdin: boolean
  readonly user: string | undefined
  size: { cols: number; rows: number } | null
  running: boolean
  /** Set once a non-interactive exec has run. */
  exitCode: number | null
}

export interface FakeNetwork {
  readonly id: string
  readonly name: string
  readonly labels: Record<string, string>
  readonly internal: boolean
  readonly subnet: string | null
}

export interface FakeVolume {
  readonly name: string
  readonly labels: Record<string, string>
  /** File contents written into the volume, keyed by path inside it. */
  readonly files: Map<string, string>
}

export interface ContainerSeed {
  name: string
  hostname?: string
  cmd?: Array<string>
  image?: string
  labels?: Record<string, string>
  env?: Record<string, string>
  mounts?: Array<FakeMount>
  portBindings?: PortBindings
  networks?: ReadonlyArray<string>
  restartPolicy?: string
  tty?: boolean
  memoryBytes?: number
  running?: boolean
  exitCode?: number
  oomKilled?: boolean
  startedAt?: string
  finishedAt?: string
  logs?: Array<{ text: string; time: string }>
  listeningPorts?: Array<number>
}

/** Matches one Docker operation, e.g. `{ command: "start", target: "kiln-ab" }`. */
export interface FakeDockerOperation {
  readonly command: string
  readonly target?: string
}

export interface HeldOperation {
  /** Resolves once Relay issues the operation; it then waits for release. */
  readonly reached: Promise<void>
  readonly release: () => void
  readonly fail: (message: string) => void
}

const NEVER = "0001-01-01T00:00:00Z"
/** A failure the daemon reports, with the HTTP status the API answers. */
class DockerFailure extends Error {
  constructor(
    message: string,
    readonly status = 500
  ) {
    super(message)
  }
}

export class FakeDocker {
  readonly containers = new Map<string, FakeContainer>()
  readonly networks = new Map<string, FakeNetwork>()
  readonly volumes = new Map<string, FakeVolume>()
  readonly execs = new Map<string, FakeExec>()
  /**
   * What interactive (TTY) execs print as they start. Docker delivers it in
   * the same packet as its upgrade response, as it can for a fast client.
   */
  execGreeting = ""
  /** Local images and their labels. */
  readonly images = new Map<string, Record<string, string>>()
  /**
   * Programs that fail when a container runs them, with what they print to
   * stderr; they exit with code 1.
   */
  readonly programFailures = new Map<string, string>()
  /**
   * Programs whose exec stream Docker breaks with an error frame (as it does
   * for an error it hits after answering) instead of their output; for a
   * one-off container (`run --rm -i`), its image.
   */
  readonly streamErrors = new Map<string, string>()
  /** Images whose registry cannot be reached; pulling them fails. */
  readonly unreachableImages = new Set<string>()
  /** What pulling an image prints before its final status, by image. */
  readonly pullOutput = new Map<string, string>()
  /**
   * Each pull, by the image's full reference, with the registry credentials
   * it carried (`X-Registry-Auth`, decoded), or null for an anonymous pull.
   */
  readonly pulls = new Map<string, unknown>()
  /** Image config beyond labels, such as `Healthcheck`, by image. */
  readonly imageConfigs = new Map<string, Record<string, unknown>>()
  /** What each tag points at (`docker image tag`), by full reference. */
  readonly imageTags = new Map<string, string>()
  /** Images whose health check fails once they start. */
  readonly unhealthyImages = new Set<string>()
  /**
   * Images whose process exits as soon as it starts. Under a restart policy
   * Docker keeps restarting them, reporting them running and restarting.
   */
  readonly crashingImages = new Set<string>()
  /** The Tailscale control plane, keyed by machine (container) name. */
  readonly tailscale = {
    controlPlaneReachable: true,
    machines: new Map<string, { ipv4: string; loggedIn: boolean }>(),
  }
  readonly #faults: Array<{
    match: FakeDockerOperation
    run: () => Promise<void>
  }> = []
  /** Operations that fail after Docker applied them. */
  readonly #afterFaults: Array<{
    match: FakeDockerOperation
    message: string
  }> = []
  #unmodelled: Array<string> = []
  #inFlight = 0
  #lastActivity = 0
  #lastTimestamp = 0
  #socketPath: string | null = null
  readonly #execSockets = new Map<string, Duplex>()
  /** `POST /containers/{id}/wait` requests, resolved as containers exit. */
  readonly #exitWaiters = new Map<string, Array<(exitCode: number) => void>>()
  /** Responses following a running container's logs. */
  readonly #followers = new Set<{
    containerId: string
    response: ServerResponse
  }>()

  /** Starts the Engine API socket (once) and returns its path. */
  async listen(): Promise<string> {
    if (this.#socketPath) return this.#socketPath
    const socketPath = join(
      tmpdir(),
      `kiln-docker-${process.pid}-${randomBytes(4).toString("hex")}.sock`
    )
    const server = createServer((request, response) => {
      void this.#api(request, response)
    })
    server.on(
      "upgrade",
      (request: IncomingMessage, socket: Duplex, head: Buffer) =>
        this.#attach(request, socket, head)
    )
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    server.unref()
    process.once("exit", () => rmSync(socketPath, { force: true }))
    this.#socketPath = socketPath
    return socketPath
  }

  /**
   * Clears all state between tests. Throws if Relay issued a Docker command
   * the fake does not model, since Relay often swallows Docker failures.
   */
  reset(): void {
    const unmodelled = this.#unmodelled
    this.containers.clear()
    this.execs.clear()
    this.execGreeting = ""
    this.networks.clear()
    this.volumes.clear()
    this.images.clear()
    this.unreachableImages.clear()
    this.pullOutput.clear()
    this.pulls.clear()
    this.imageConfigs.clear()
    this.imageTags.clear()
    this.unhealthyImages.clear()
    this.crashingImages.clear()
    this.programFailures.clear()
    this.streamErrors.clear()
    this.tailscale.controlPlaneReachable = true
    this.tailscale.machines.clear()
    this.#faults.length = 0
    this.#afterFaults.length = 0
    for (const follower of this.#followers) follower.response.end()
    this.#followers.clear()
    this.#unmodelled = []
    if (unmodelled.length > 0) {
      throw new Error(
        `FakeDocker does not model:\n${unmodelled.map((line) => `  ${line}`).join("\n")}`
      )
    }
  }

  container(reference: string): FakeContainer | undefined {
    const name = reference.replace(/^\//u, "")
    for (const container of this.containers.values()) {
      if (container.name === name) return container
    }
    if (/^[a-f0-9]{12,64}$/u.test(reference)) {
      for (const container of this.containers.values()) {
        if (container.id.startsWith(reference)) return container
      }
    }
    return undefined
  }

  network(reference: string): FakeNetwork | undefined {
    return (
      this.networks.get(reference) ??
      [...this.networks.values()].find(
        (network) => reference.length >= 12 && network.id.startsWith(reference)
      )
    )
  }

  addContainer(seed: ContainerSeed): FakeContainer {
    if (this.container(seed.name)) {
      throw new Error(`Container ${seed.name} already exists`)
    }
    const running = seed.running ?? false
    const container: FakeContainer = {
      id: randomBytes(32).toString("hex"),
      name: seed.name,
      image: seed.image ?? "example/server:latest",
      hostname: seed.hostname ?? seed.name,
      labels: { ...seed.labels },
      env: { ...seed.env },
      cmd: [...(seed.cmd ?? [])],
      tty: seed.tty ?? false,
      openStdin: seed.tty ?? false,
      restartPolicy: seed.restartPolicy ?? "no",
      memoryBytes: seed.memoryBytes ?? 0,
      mounts: [...(seed.mounts ?? [])],
      portBindings: structuredClone(seed.portBindings ?? {}),
      networkMode: seed.networks?.[0] ?? "bridge",
      networks: new Map(
        (seed.networks ?? []).map((network) => [
          network,
          { aliases: [seed.name], ipAddress: "" },
        ])
      ),
      healthCheck: false,
      state: {
        running,
        restarting: false,
        exitCode: seed.exitCode ?? 0,
        oomKilled: seed.oomKilled ?? false,
        startedAt: seed.startedAt ?? (running ? this.#timestamp() : NEVER),
        finishedAt: seed.finishedAt ?? NEVER,
      },
      starts: 0,
      autoRemove: false,
      volumesFrom: [],
      runOnce: null,
      logs: [...(seed.logs ?? [])],
      logStreamError: null,
      lastLogRead: null,
      stdin: "",
      processes: [],
      sqlDump: "",
      executedSql: [],
      firewall: new Map(),
      listeningPorts: [...(seed.listeningPorts ?? [])],
    }
    this.containers.set(container.id, container)
    // A container's image is always local.
    if (this.#imageKey(container.image) === undefined) {
      this.images.set(container.image, {})
    }
    return container
  }

  addNetwork(input: {
    name: string
    labels?: Record<string, string>
    internal?: boolean
    subnet?: string
  }): FakeNetwork {
    const network: FakeNetwork = {
      id: randomBytes(32).toString("hex"),
      name: input.name,
      labels: { ...input.labels },
      internal: input.internal ?? false,
      subnet: input.subnet ?? null,
    }
    this.networks.set(network.name, network)
    return network
  }

  addVolume(input: {
    name: string
    labels?: Record<string, string>
  }): FakeVolume {
    const volume: FakeVolume = {
      name: input.name,
      labels: { ...input.labels },
      files: new Map(),
    }
    this.volumes.set(volume.name, volume)
    return volume
  }

  connect(containerName: string, networkName: string, ipAddress = ""): void {
    this.#requiredContainer(containerName).networks.set(networkName, {
      aliases: [containerName],
      ipAddress,
    })
  }

  /** Simulates a container disappearing outside Relay (prune, host reset). */
  removeContainer(containerName: string): void {
    this.containers.delete(this.#requiredContainer(containerName).id)
  }

  /** Simulates the container process exiting on its own. */
  exit(
    containerName: string,
    exit: { exitCode: number; oomKilled?: boolean }
  ): void {
    const container = this.#requiredContainer(containerName)
    container.state.running = false
    container.state.exitCode = exit.exitCode
    container.state.oomKilled = exit.oomKilled ?? false
    container.state.finishedAt = this.#timestamp()
    this.#endExecs(container)
  }

  /** How many requests are following containers' logs. */
  followerCount(): number {
    return this.#followers.size
  }

  /**
   * Simulates the container's process writing `lines`, all at once, to its
   * log and to anyone following it.
   */
  writeLogs(
    containerName: string,
    lines: ReadonlyArray<{ text: string; time: string }>
  ): void {
    const container = this.#requiredContainer(containerName)
    container.logs.push(...lines)
    const output = Buffer.concat(
      lines.map(({ text, time }) => {
        const line = Buffer.from(`${time} ${text}\n`)
        return container.tty ? line : frame(1, line)
      })
    )
    for (const follower of this.#followers) {
      if (follower.containerId === container.id) follower.response.write(output)
    }
  }

  /** Simulates Docker or the host restarting the container's process. */
  restartProcess(containerName: string): void {
    this.#start(this.#requiredContainer(containerName))
  }

  /** Pauses the next matching operation until the test releases it. */
  hold(match: FakeDockerOperation): HeldOperation {
    let reached!: () => void
    let settle!: (failure: string | null) => void
    const reachedPromise = new Promise<void>((resolve) => {
      reached = resolve
    })
    const settled = new Promise<string | null>((resolve) => {
      settle = resolve
    })
    this.#faults.push({
      match,
      run: async () => {
        reached()
        const failure = await settled
        if (failure !== null) throw new DockerFailure(failure)
      },
    })
    return {
      reached: reachedPromise,
      release: () => settle(null),
      fail: (message) => settle(message),
    }
  }

  /** Fails the next matching operation with Docker's error `message`. */
  failNext(match: FakeDockerOperation, message: string): void {
    this.#faults.push({
      match,
      run: () => Promise.reject(new DockerFailure(message)),
    })
  }

  /**
   * Applies the next matching operation, then fails it with `message`, as
   * when Docker made a change but the answer was lost or came too late.
   */
  failAfterNext(match: FakeDockerOperation, message: string): void {
    this.#afterFaults.push({ match, message })
  }

  #appliedCheckpoint(command: string, target?: string): void {
    const index = this.#afterFaults.findIndex(
      ({ match }) =>
        match.command === command &&
        (match.target === undefined || match.target === target)
    )
    if (index === -1) return
    const [fault] = this.#afterFaults.splice(index, 1)
    throw new DockerFailure(fault!.message, 500)
  }

  /**
   * Resolves once Docker has been quiet for a moment, for work Relay starts in
   * the background (recovery restarts, compensating stops). A request Relay
   * just sent to the socket can still be on its way, so no request running is
   * not enough.
   */
  idle(): Promise<void> {
    // Quiet is counted from no earlier than the call, so a request still on
    // its way from work Relay started just before (a forked restart) has
    // time to arrive, however long ago the last one was.
    const called = Date.now()
    return new Promise((resolve) => {
      const check = () => {
        if (
          this.#inFlight === 0 &&
          Date.now() - Math.max(this.#lastActivity, called) >= 25
        ) {
          // Let callers observe the result before waiters resume.
          setImmediate(resolve)
        } else {
          setTimeout(check, 5)
        }
      }
      setTimeout(check, 5)
    })
  }

  /**
   * The `command()` boundary. Of the processes the Relay runs, the fake
   * models standalone Compose's `up` and buildx's `build`, which Relay runs
   * for app deployments; anything else, the `docker` CLI included, is
   * reported.
   */
  async run(
    executable: string,
    arguments_: ReadonlyArray<string>,
    _options: CommandOptions = {},
    input?: string
  ): Promise<CommandResult> {
    if (
      posix.basename(executable) === "docker-buildx" &&
      arguments_[0] === "build"
    ) {
      return this.#buildxBuild(arguments_)
    }
    if (
      executable === "docker-compose" &&
      arguments_.slice(-4).join(" ") === "up --detach --build --remove-orphans"
    ) {
      return this.#composeUp(arguments_, input ?? "")
    }
    return this.#unsupported(`${executable} ${arguments_.join(" ")}`)
  }

  // `docker-buildx build --progress plain [--label k=v]… --tag T --file F
  // context`: the image, tagged and labelled.
  #buildxBuild(arguments_: ReadonlyArray<string>): CommandResult {
    const labels: Record<string, string> = {}
    let tag = ""
    for (let index = 1; index < arguments_.length; index += 1) {
      const argument = arguments_[index]
      if (argument === "--label") {
        const [key, value = ""] = splitOnce(arguments_[++index] ?? "", "=")
        labels[key] = value
      } else if (argument === "--tag") tag = arguments_[++index] ?? ""
      else if (argument === "--file" || argument === "--progress") index += 1
    }
    this.images.set(tag, labels)
    return {
      stderr: `#0 building with "default" instance using docker driver\n#1 naming to docker.io/library/${tag} done\n`,
      stdout: "",
    }
  }

  // `docker-compose … -p <project> … up --detach --build --remove-orphans`
  // with the project on stdin: each service's container, replacing the
  // project's previous ones.
  #composeUp(arguments_: ReadonlyArray<string>, input: string): CommandResult {
    const project = arguments_[arguments_.indexOf("-p") + 1] ?? ""
    const definition = JSON.parse(input) as {
      services: Record<
        string,
        {
          container_name?: string
          image?: string
          labels?: Record<string, string>
        }
      >
    }
    for (const container of this.containers.values()) {
      if (container.labels["com.docker.compose.project"] === project) {
        this.containers.delete(container.id)
      }
    }
    const lines: Array<string> = []
    for (const [service, settings] of Object.entries(definition.services)) {
      const name = settings.container_name ?? `${project}-${service}-1`
      this.addContainer({
        image: settings.image ?? `${project}-${service}`,
        labels: {
          ...settings.labels,
          "com.docker.compose.oneoff": "False",
          "com.docker.compose.project": project,
          "com.docker.compose.service": service,
        },
        name,
        running: true,
      })
      lines.push(` Container ${name}  Started`)
    }
    return { stderr: `${lines.join("\n")}\n`, stdout: "" }
  }

  #begin(): void {
    this.#inFlight += 1
    this.#lastActivity = Date.now()
  }

  #settled(): void {
    this.#inFlight -= 1
    this.#lastActivity = Date.now()
  }

  #unsupported(commandLine: string): never {
    this.#unmodelled.push(commandLine)
    throw new Error(`FakeDocker does not model: ${commandLine}`)
  }

  async #checkpoint(command: string, target?: string): Promise<void> {
    const index = this.#faults.findIndex(
      ({ match }) =>
        match.command === command &&
        (match.target === undefined || match.target === target)
    )
    if (index === -1) return
    const [fault] = this.#faults.splice(index, 1)
    await fault?.run()
  }

  // ---------------------------------------------------------------- listing

  #matchesFilter(container: FakeContainer, filter: string): boolean {
    const separator = filter.indexOf("=")
    const key = filter.slice(0, separator)
    const value = filter.slice(separator + 1)
    if (key === "label") {
      const [label, expected] = splitOnce(value, "=")
      return expected === undefined
        ? Object.hasOwn(container.labels, label)
        : container.labels[label] === expected
    }
    if (key === "name") {
      return new RegExp(value, "u").test(`/${container.name}`)
    }
    if (key === "network") {
      const network = this.network(value)
      return network !== undefined && container.networks.has(network.name)
    }
    if (key === "publish") {
      // Like Docker, `publish` matches the container side of a mapping.
      const [range = "", protocol = "tcp"] = value.split("/")
      const [start = 0, end = start] = range.split("-").map(Number)
      return Object.entries(container.portBindings).some(([port, hosts]) => {
        const [containerPort = 0, portProtocol] = port.split("/")
        const number = Number(containerPort)
        return (
          portProtocol === protocol &&
          number >= start &&
          number <= end &&
          hosts.some((host) => host.HostPort)
        )
      })
    }
    return this.#unsupported(`docker container ls --filter ${filter}`)
  }

  // ------------------------------------------------------------- inspection

  #containerObject(reference: string): unknown {
    const container = this.container(reference)
    if (!container) return undefined
    const binds = container.mounts
      .filter((mount) => mount.type === "bind")
      .map(
        (mount) =>
          `${mount.source}:${mount.destination}${mount.readOnly ? ":ro" : ""}`
      )
    const volumeMounts = container.mounts
      .filter((mount) => mount.type === "volume" && !mount.anonymous)
      .map((mount) => ({
        ReadOnly: mount.readOnly ?? false,
        Source: mount.source,
        Target: mount.destination,
        Type: "volume",
      }))
    return {
      Config: {
        // Relay's creates set only stdin's, as they do with Docker.
        AttachStderr: false,
        AttachStdin: container.openStdin,
        AttachStdout: false,
        Cmd: container.cmd,
        Env: Object.entries(container.env).map(
          ([name, value]) => `${name}=${value}`
        ),
        ExposedPorts: Object.fromEntries(
          Object.keys(container.portBindings).map((port) => [port, {}])
        ),
        Hostname: container.hostname,
        Image: container.image,
        Labels: container.labels,
        OpenStdin: container.openStdin,
        Tty: container.tty,
        Volumes: Object.fromEntries(
          container.mounts
            .filter((mount) => mount.anonymous)
            .map((mount) => [mount.destination, {}])
        ),
      },
      HostConfig: {
        Binds: binds,
        Memory: container.memoryBytes,
        Mounts: volumeMounts,
        NetworkMode: container.networkMode,
        PortBindings: container.portBindings,
        VolumesFrom: container.volumesFrom.length ? container.volumesFrom : null,
        RestartPolicy: { MaximumRetryCount: 0, Name: container.restartPolicy },
      },
      Id: container.id,
      Image: `sha256:${container.image}`,
      Mounts: container.mounts.map((mount) => ({
        Destination: mount.destination,
        Name: mount.type === "volume" ? mount.source : undefined,
        RW: !mount.readOnly,
        Source: mount.source,
        Type: mount.type,
      })),
      Name: `/${container.name}`,
      NetworkSettings: {
        Networks: Object.fromEntries(
          [...container.networks].map(([name, endpoint]) => [
            name,
            {
              Aliases: endpoint.aliases,
              IPAddress: endpoint.ipAddress,
              NetworkID: this.networks.get(name)?.id ?? "",
            },
          ])
        ),
        Ports: Object.fromEntries(
          Object.entries(container.portBindings).map(([port, hosts]) => [
            port,
            container.state.running
              ? hosts.flatMap((host) =>
                  host.HostIp
                    ? [host]
                    : [
                        { HostIp: "0.0.0.0", HostPort: host.HostPort },
                        { HostIp: "::", HostPort: host.HostPort },
                      ]
                )
              : null,
          ])
        ),
      },
      State: {
        Error: "",
        ExitCode: container.state.exitCode,
        FinishedAt: container.state.finishedAt,
        ...(container.state.health
          ? { Health: { Status: container.state.health } }
          : {}),
        OOMKilled: container.state.oomKilled,
        Restarting: container.state.restarting,
        Running: container.state.running,
        StartedAt: container.state.startedAt,
        Status: container.state.restarting
          ? "restarting"
          : container.state.running
            ? "running"
            : container.state.startedAt === NEVER
              ? "created"
              : "exited",
      },
    }
  }

  /** The key of a local image `reference` names, as Docker normalizes it. */
  #imageKey(reference: string): string | undefined {
    const wanted = normalizedImage(reference)
    return [...this.images.keys()].find(
      (key) =>
        key === reference ||
        `sha256:${key}` === reference ||
        normalizedImage(key) === wanted
    )
  }

  #imageObject(image: string): unknown {
    const key = this.#imageKey(image)
    const labels = key === undefined ? undefined : this.images.get(key)
    return labels === undefined || key === undefined
      ? undefined
      : {
          Config: { ...this.imageConfigs.get(key), Labels: labels },
          Id: this.#imageId(key),
          RepoTags: [key],
        }
  }

  /** The image a reference names: its tag's target, or its own ID. */
  #imageId(reference: string): string {
    if (reference.startsWith("sha256:")) return reference
    return (
      this.imageTags.get(normalizedImage(reference)) ?? `sha256:${reference}`
    )
  }

  /** Listing networks leaves out their containers, as Docker does. */
  #networkObject(network: FakeNetwork, withContainers = true): unknown {
    return {
      Containers:
        withContainers &&
        Object.fromEntries(
          [...this.containers.values()].flatMap((container) => {
            const endpoint = container.networks.get(network.name)
            return endpoint
              ? [
                  [
                    container.id,
                    { IPv4Address: endpoint.ipAddress, Name: container.name },
                  ],
                ]
              : []
          })
        ),
      Driver: "bridge",
      IPAM: { Config: network.subnet ? [{ Subnet: network.subnet }] : [] },
      Id: network.id,
      Internal: network.internal,
      Labels: network.labels,
      Name: network.name,
    }
  }

  // --------------------------------------------------------------- creation

  #createContainer(input: {
    autoRemove: boolean
    cmd: Array<string>
    hostname: string | undefined
    volumesFrom: Array<string>
    env: Record<string, string>
    healthCheck: boolean
    image: string
    interactive: boolean
    labels: Record<string, string>
    memoryBytes: number
    mounts: Array<FakeMount>
    name: string | undefined
    networkMode: string | undefined
    networks: Array<{ aliases: Array<string>; ipAddress: string; name: string }>
    portBindings: PortBindings
    restartPolicy: string
    tty: boolean
  }): FakeContainer {
    const name = input.name ?? `fake-${randomBytes(4).toString("hex")}`
    if (this.container(name)) {
      throw new DockerFailure(
        `Conflict. The container name "/${name}" is already in use`
      )
    }
    if (this.#imageKey(input.image) === undefined) {
      throw new DockerFailure(`No such image: ${input.image}`, 404)
    }
    for (const { name: network } of input.networks) {
      if (!this.networks.has(network)) {
        throw new DockerFailure(`network ${network} not found`, 404)
      }
    }
    const container = this.addContainer({
      env: input.env,
      image: input.image,
      labels: input.labels,
      memoryBytes: input.memoryBytes,
      mounts: input.mounts,
      name,
      portBindings: input.portBindings,
      restartPolicy: input.restartPolicy,
      tty: input.tty,
    })
    container.cmd = input.cmd
    // Docker names a container's host after its ID when it isn't given one.
    container.hostname = input.hostname || container.id.slice(0, 12)
    container.volumesFrom = input.volumesFrom
    container.autoRemove = input.autoRemove
    container.openStdin = input.interactive
    container.healthCheck = input.healthCheck
    container.networkMode = input.networkMode ?? "bridge"
    for (const network of input.networks) {
      container.networks.set(network.name, {
        aliases: network.aliases.length > 0 ? network.aliases : [name],
        ipAddress: network.ipAddress,
      })
    }
    return container
  }

  /** `docker run --rm -i … sh -c "cat > /path"`: writes stdin into a volume. */
  #runOnce(container: FakeContainer, input: string): string {
    const script = container.cmd[0] === "-c" ? (container.cmd[1] ?? "") : ""
    const target = /cat > (\S+)/u.exec(script)?.[1]
    if (!target) {
      return this.#unsupported(`docker run --rm ${container.cmd.join(" ")}`)
    }
    for (const mount of container.mounts) {
      const relative = posix.relative(mount.destination, target)
      if (mount.type !== "volume" || relative.startsWith("..")) continue
      const volume = this.volumes.get(mount.source)
      if (!volume) throw new DockerFailure(`no such volume: ${mount.source}`)
      volume.files.set(relative, input)
      return ""
    }
    throw new DockerFailure(`${target} is not on a mounted volume`)
  }

  /**
   * Runs a `run --rm -i` container once it has started and its stdin has
   * ended: its output goes to the attached client, then it exits and Docker
   * removes it.
   */
  #finishRunOnce(container: FakeContainer): void {
    const run = container.runOnce
    if (!run?.stdinEnded || !container.state.running) return
    container.runOnce = null
    let exitCode = 0
    let stderr = ""
    try {
      this.#runOnce(container, Buffer.concat(run.input).toString("utf8"))
    } catch (cause) {
      if (!(cause instanceof DockerFailure)) throw cause
      stderr = `${cause.message}\n`
      exitCode = 1
    }
    const streamError = this.streamErrors.get(container.image)
    if (streamError !== undefined) {
      // The stream breaks; the container is left as it was, for Relay to
      // remove.
      run.socket.end(frame(3, Buffer.from(streamError)))
      return
    }
    if (stderr && !run.socket.destroyed) {
      run.socket.write(frame(2, Buffer.from(stderr)))
    }
    run.socket.end()
    this.#stop(container, exitCode)
  }

  // ------------------------------------------------------------ power state

  /** Returns false when the container was already in the requested state. */
  async #powerOne(
    action: "kill" | "restart" | "start" | "stop",
    reference: string
  ): Promise<boolean> {
    await this.#checkpoint(action, reference)
    const container = this.#requiredContainer(reference)
    if (action === "start") {
      if (container.state.running) return false
      this.#start(container)
    } else if (action === "stop") {
      if (!container.state.running) return false
      this.#stop(container, 0)
    } else if (action === "kill") {
      if (!container.state.running) {
        throw new DockerFailure(`container ${reference} is not running`, 409)
      }
      this.#stop(container, 137)
    } else {
      if (container.state.running) this.#stop(container, 0)
      this.#start(container)
    }
    this.#appliedCheckpoint(action, reference)
    return true
  }

  #start(container: FakeContainer): void {
    if (container.runOnce) {
      container.state.running = true
      container.state.startedAt = this.#timestamp()
      container.starts += 1
      setImmediate(() => this.#finishRunOnce(container))
      return
    }
    const crashing = this.crashingImages.has(container.image)
    container.state.running = true
    container.state.restarting = crashing && container.restartPolicy !== "no"
    container.state.exitCode = crashing ? 1 : 0
    container.state.oomKilled = false
    container.state.startedAt = this.#timestamp()
    container.state.health = container.healthCheck
      ? this.unhealthyImages.has(container.image)
        ? "unhealthy"
        : "healthy"
      : undefined
    container.starts += 1
    // Each run gets a fresh network namespace.
    container.firewall = new Map()
    if (container.image.startsWith("tailscale/tailscale")) {
      const machine = this.tailscale.machines.get(container.name)
      if (container.env.TS_AUTHKEY) {
        this.tailscale.machines.set(container.name, {
          ipv4: machine?.ipv4 ?? `100.64.0.${this.tailscale.machines.size + 1}`,
          loggedIn: true,
        })
      }
    }
  }

  #stop(container: FakeContainer, exitCode: number): void {
    container.state.running = false
    container.state.exitCode = exitCode
    const waiters = this.#exitWaiters.get(container.id) ?? []
    this.#exitWaiters.delete(container.id)
    if (container.autoRemove) {
      this.#endExecs(container)
      this.containers.delete(container.id)
    }
    for (const waiter of waiters) waiter(exitCode)
    container.state.finishedAt = this.#timestamp()
    container.state.health = undefined
    this.#endExecs(container)
  }

  // A container's execs, and anyone following its logs, end with it.
  #endExecs(container: FakeContainer): void {
    for (const exec of this.execs.values()) {
      if (exec.running && exec.containerId === container.id) {
        this.exitExec(exec.id)
      }
    }
    for (const follower of this.#followers) {
      if (follower.containerId !== container.id) continue
      this.#followers.delete(follower)
      follower.response.end()
    }
  }

  async #removeOne(reference: string, force: boolean): Promise<void> {
    await this.#checkpoint("rm", reference)
    const container = this.#requiredContainer(reference)
    if (container.state.running && !force) {
      throw new DockerFailure(
        `cannot remove container "/${container.name}": container is running`,
        409
      )
    }
    this.#endExecs(container)
    this.containers.delete(container.id)
    this.#appliedCheckpoint("rm", reference)
  }

  async #renameOne(from: string, to: string): Promise<void> {
    await this.#checkpoint("rename", from)
    const container = this.#requiredContainer(from)
    if (this.container(to)) {
      throw new DockerFailure(
        `Conflict. The container name "/${to}" is already in use`,
        409
      )
    }
    container.name = to
    this.#appliedCheckpoint("rename", from)
  }

  async #setRestartPolicy(reference: string, policy: string): Promise<void> {
    await this.#checkpoint("update", reference)
    this.#requiredContainer(reference).restartPolicy = policy
  }

  // ---------------------------------------------------------- logs and exec

  /** What a process Relay runs with `docker exec` prints, or how it fails. */
  #runProgram(
    container: FakeContainer,
    argv: Array<string>,
    env: Record<string, string>,
    input = "",
    user?: string
  ): string {
    container.processes.push({ argv, env, ...(user ? { user } : {}) })
    const [program = "", ...programArguments] = argv
    const client = clientOf(argv)
    const failure = this.programFailures.get(client)
    if (failure !== undefined) throw new DockerFailure(failure)
    if (["mysqldump", "mariadb-dump", "pg_dump"].includes(client)) {
      return container.sqlDump
    }
    if (["mysql", "mariadb", "psql"].includes(client)) {
      container.executedSql.push(input)
      return ""
    }
    if (program === "iptables") {
      return iptables(container.firewall, programArguments)
    }
    if (program === "tailscale") {
      return this.#tailscaleCli(container, programArguments)
    }
    if (program === "cat" && programArguments[0]?.startsWith("/proc/net/tcp")) {
      return procNetTcp(
        programArguments[0] === "/proc/net/tcp" ? container.listeningPorts : []
      )
    }
    // Other programs (database clients, probes) succeed without output.
    return ""
  }

  #tailscaleCli(container: FakeContainer, arguments_: Array<string>): string {
    const machine = this.tailscale.machines.get(container.name)
    const [subcommand, option] = arguments_
    if (subcommand === "ip") {
      if (!machine?.loggedIn)
        throw new DockerFailure("no current Tailscale IPs")
      return option === "-4" ? `${machine.ipv4}\n` : ""
    }
    if (subcommand === "logout") {
      if (!this.tailscale.controlPlaneReachable) {
        throw new DockerFailure("control plane unavailable")
      }
      if (machine) machine.loggedIn = false
      return ""
    }
    if (subcommand === "set") return ""
    return this.#unsupported(`tailscale ${arguments_.join(" ")}`)
  }

  // ------------------------------------------------------ networks, volumes

  #networkList(filters: Array<string>): Array<FakeNetwork> {
    return [...this.networks.values()].filter((network) =>
      this.#labelled(network.labels, filters, "network ls")
    )
  }

  /** Label filters, the only ones Relay sends for networks, volumes, images. */
  #labelled(
    labels: Record<string, string>,
    filters: Array<string>,
    listing: string
  ): boolean {
    return filters.every((filter) => {
      const [key, value = ""] = splitOnce(filter, "=")
      if (key !== "label") {
        return this.#unsupported(`docker ${listing} --filter ${filter}`)
      }
      const [label, expected] = splitOnce(value, "=")
      return expected === undefined
        ? Object.hasOwn(labels, label)
        : labels[label] === expected
    })
  }

  #requiredNetwork(reference: string): FakeNetwork {
    const network = this.network(reference)
    if (!network) throw new DockerFailure(`network ${reference} not found`, 404)
    return network
  }

  async #networkConnect(
    networkName: string,
    containerName: string,
    endpoint: { aliases: Array<string>; ipAddress: string }
  ): Promise<void> {
    await this.#checkpoint("network connect", networkName)
    const network = this.#requiredNetwork(networkName)
    const container = this.#requiredContainer(containerName)
    if (container.networks.has(network.name)) {
      throw new DockerFailure(
        `endpoint with name ${container.name} already exists in network ${network.name}`,
        403
      )
    }
    container.networks.set(network.name, {
      aliases: [...endpoint.aliases, container.name],
      ipAddress: endpoint.ipAddress,
    })
  }

  async #networkDisconnect(
    networkName: string,
    containerName: string
  ): Promise<void> {
    await this.#checkpoint("network disconnect", networkName)
    const network = this.#requiredNetwork(networkName)
    const container = this.#requiredContainer(containerName)
    if (!container.networks.delete(network.name)) {
      throw new DockerFailure(
        `container ${container.name} is not connected to network ${network.name}`,
        403
      )
    }
  }

  async #networkRemove(reference: string): Promise<void> {
    await this.#checkpoint("network rm", reference)
    const network = this.#requiredNetwork(reference)
    const attached = [...this.containers.values()].filter((container) =>
      container.networks.has(network.name)
    )
    if (attached.length > 0) {
      throw new DockerFailure(
        `error while removing network: network ${network.name} has active endpoints (${attached.map(({ name }) => name).join(", ")})`,
        403
      )
    }
    this.networks.delete(network.name)
  }

  async #volumeRemove(name: string): Promise<void> {
    await this.#checkpoint("volume rm", name)
    if (!this.volumes.has(name)) {
      throw new DockerFailure(`get ${name}: no such volume`, 404)
    }
    const user = [...this.containers.values()].find((container) =>
      container.mounts.some(
        (mount) => mount.type === "volume" && mount.source === name
      )
    )
    if (user) {
      throw new DockerFailure(
        `remove ${name}: volume is in use - [${user.id}]`,
        409
      )
    }
    this.volumes.delete(name)
  }

  // ------------------------------------------------------------- Engine API

  async #api(request: IncomingMessage, response: ServerResponse) {
    this.#begin()
    try {
      const url = new URL(request.url ?? "/", "http://docker")
      const body = await readBody(request)
      const answer = await this.#route(
        request.method ?? "GET",
        url,
        body,
        request.headers
      )
      if (answer.kind === "stream") answer.write(response)
      else if (answer.status === 204 || answer.status === 304) {
        response.writeHead(answer.status).end()
      } else {
        response.writeHead(answer.status, {
          "Content-Type": "application/json",
        })
        response.end(JSON.stringify(answer.payload))
      }
    } catch (cause) {
      const status = cause instanceof DockerFailure ? cause.status : 500
      response.writeHead(status, { "Content-Type": "application/json" })
      response.end(
        JSON.stringify({
          message: cause instanceof Error ? cause.message : String(cause),
        })
      )
    } finally {
      this.#settled()
    }
  }

  async #route(
    method: string,
    url: URL,
    body: string,
    headers: IncomingMessage["headers"]
  ): Promise<ApiAnswer> {
    const path = url.pathname
    const json = (status: number, payload: unknown = {}): ApiAnswer => ({
      kind: "json",
      payload,
      status,
    })
    const flag = (name: string) => {
      const value = url.searchParams.get(name)
      return value === "1" || value === "true"
    }
    const route = (pattern: RegExp) =>
      pattern
        .exec(path)
        ?.slice(1)
        .map((part) => decodeURIComponent(part))
    let parameters: Array<string> | undefined

    if (method === "GET" && path === "/version") {
      return json(200, { ApiVersion: "1.47", Version: "27.3.1" })
    }
    if (method === "GET" && path === "/containers/json") {
      const filters = apiFilters(url)
      return json(
        200,
        [...this.containers.values()]
          .filter((container) => flag("all") || container.state.running)
          .filter((container) =>
            filters.every((filter) => this.#matchesFilter(container, filter))
          )
          .map((container) => containerSummary(container))
      )
    }
    if (method === "POST" && path === "/containers/create") {
      const name = url.searchParams.get("name") ?? undefined
      await this.#checkpoint("create", name)
      const container = this.#createFromApi(name, JSON.parse(body))
      this.#appliedCheckpoint("create", name)
      return json(201, { Id: container.id, Warnings: [] })
    }
    if (
      method === "POST" &&
      (parameters = route(/^\/containers\/([^/]+)\/wait$/u))
    ) {
      const target = this.#requiredContainer(parameters[0] ?? "")
      const exitCode = await new Promise<number>((resolve) => {
        const waiters = this.#exitWaiters.get(target.id) ?? []
        waiters.push(resolve)
        this.#exitWaiters.set(target.id, waiters)
      })
      return json(200, { StatusCode: exitCode })
    }
    if (method === "POST" && path === "/networks/create") {
      const input = JSON.parse(body) as {
        IPAM?: { Config?: Array<{ Subnet?: string }> }
        Internal?: boolean
        Labels?: Record<string, string>
        Name: string
      }
      await this.#checkpoint("network create", input.Name)
      if (this.networks.has(input.Name)) {
        throw new DockerFailure(
          `network with name ${input.Name} already exists`,
          409
        )
      }
      const network = this.addNetwork({
        internal: input.Internal ?? false,
        labels: input.Labels ?? {},
        name: input.Name,
        subnet: input.IPAM?.Config?.[0]?.Subnet,
      })
      return json(201, { Id: network.id, Warning: "" })
    }
    if (method === "POST" && path === "/volumes/create") {
      const input = JSON.parse(body) as {
        Labels?: Record<string, string>
        Name: string
      }
      await this.#checkpoint("volume create", input.Name)
      const volume =
        this.volumes.get(input.Name) ??
        this.addVolume({ labels: input.Labels ?? {}, name: input.Name })
      return json(201, {
        Driver: "local",
        Labels: volume.labels,
        Name: volume.name,
      })
    }
    if (
      method === "GET" &&
      (parameters = route(/^\/containers\/([^/]+)\/json$/u))
    ) {
      const target = this.#requiredContainer(parameters[0] ?? "")
      await this.#checkpoint("inspect", target.name)
      return json(200, this.#containerObject(target.id))
    }
    if (
      method === "POST" &&
      (parameters = route(
        /^\/containers\/([^/]+)\/(start|stop|restart|kill)$/u
      ))
    ) {
      const [reference = "", action] = parameters
      const changed = await this.#powerOne(
        action as "kill" | "restart" | "start" | "stop",
        reference
      )
      return json(changed ? 204 : 304)
    }
    if (
      method === "DELETE" &&
      (parameters = route(/^\/containers\/([^/]+)$/u))
    ) {
      await this.#removeOne(parameters[0] ?? "", flag("force"))
      return json(204)
    }
    if (
      method === "POST" &&
      (parameters = route(/^\/containers\/([^/]+)\/rename$/u))
    ) {
      await this.#renameOne(
        parameters[0] ?? "",
        url.searchParams.get("name") ?? ""
      )
      return json(204)
    }
    if (
      method === "POST" &&
      (parameters = route(/^\/containers\/([^/]+)\/update$/u))
    ) {
      const update = JSON.parse(body) as { RestartPolicy?: { Name?: string } }
      const policy = update.RestartPolicy?.Name
      if (policy === undefined) return this.#unsupported(`POST ${path} ${body}`)
      await this.#setRestartPolicy(parameters[0] ?? "", policy)
      return json(200, { Warnings: [] })
    }
    if (
      method === "GET" &&
      (parameters = route(/^\/containers\/([^/]+)\/stats$/u))
    ) {
      const container = this.#requiredContainer(parameters[0] ?? "")
      return json(200, {
        cpu_stats: {
          cpu_usage: { total_usage: 0 },
          online_cpus: 1,
          system_cpu_usage: 0,
        },
        memory_stats: { limit: container.memoryBytes, usage: 0 },
        networks: {},
        precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
      })
    }
    if (
      method === "POST" &&
      (parameters = route(/^\/containers\/([^/]+)\/resize$/u))
    ) {
      this.#requiredContainer(parameters[0] ?? "")
      return json(200)
    }
    if (
      method === "GET" &&
      (parameters = route(/^\/containers\/([^/]+)\/logs$/u))
    ) {
      return this.#logStream(this.#requiredContainer(parameters[0] ?? ""), url)
    }
    if (
      method === "POST" &&
      (parameters = route(/^\/containers\/([^/]+)\/exec$/u))
    ) {
      const target = this.#requiredContainer(parameters[0] ?? "")
      await this.#checkpoint("exec", target.name)
      if (!target.state.running) {
        throw new DockerFailure(`Container ${target.id} is not running`, 409)
      }
      const input = JSON.parse(body) as {
        AttachStdin?: boolean
        Cmd?: Array<string>
        Env?: Array<string>
        Tty?: boolean
        User?: string
      }
      const exec: FakeExec = {
        attachStdin: input.AttachStdin ?? false,
        cmd: input.Cmd ?? [],
        containerId: target.id,
        env: Object.fromEntries(
          (input.Env ?? []).map(
            (entry) => splitOnce(entry, "=") as [string, string]
          )
        ),
        exitCode: null,
        id: randomBytes(32).toString("hex"),
        running: false,
        size: null,
        tty: input.Tty ?? false,
        user: input.User,
      }
      this.execs.set(exec.id, exec)
      return json(201, { Id: exec.id })
    }
    if (
      method === "POST" &&
      (parameters = route(/^\/exec\/([^/]+)\/start$/u))
    ) {
      const exec = this.execs.get(parameters[0] ?? "")
      if (!exec) throw new DockerFailure("No such exec instance", 404)
      const options = JSON.parse(body || "{}") as { Detach?: boolean }
      if (options.Detach) {
        this.#runDetachedExec(exec)
        return json(200)
      }
      return this.#runExec(exec)
    }
    if (
      method === "POST" &&
      (parameters = route(/^\/exec\/([^/]+)\/resize$/u))
    ) {
      const exec = this.execs.get(parameters[0] ?? "")
      if (!exec?.running) throw new DockerFailure("No such exec instance", 404)
      exec.size = {
        cols: Number(url.searchParams.get("w")),
        rows: Number(url.searchParams.get("h")),
      }
      return json(200)
    }
    if (method === "GET" && (parameters = route(/^\/exec\/([^/]+)\/json$/u))) {
      const exec = this.execs.get(parameters[0] ?? "")
      if (!exec) throw new DockerFailure("No such exec instance", 404)
      return json(200, { ExitCode: exec.exitCode, Running: exec.running })
    }
    if (method === "GET" && path === "/networks") {
      await this.#checkpoint("network ls")
      return json(
        200,
        this.#networkList(apiFilters(url)).map((network) =>
          this.#networkObject(network, false)
        )
      )
    }
    if (method === "GET" && (parameters = route(/^\/networks\/([^/]+)$/u))) {
      const [reference = ""] = parameters
      await this.#checkpoint("network inspect", reference)
      return json(200, this.#networkObject(this.#requiredNetwork(reference)))
    }
    if (
      method === "POST" &&
      (parameters = route(/^\/networks\/([^/]+)\/(connect|disconnect)$/u))
    ) {
      const [network = "", action] = parameters
      const input = JSON.parse(body) as {
        Container: string
        EndpointConfig?: {
          Aliases?: Array<string>
          IPAMConfig?: { IPv4Address?: string }
        }
      }
      if (action === "connect") {
        await this.#networkConnect(network, input.Container, {
          aliases: input.EndpointConfig?.Aliases ?? [],
          ipAddress: input.EndpointConfig?.IPAMConfig?.IPv4Address ?? "",
        })
      } else {
        await this.#networkDisconnect(network, input.Container)
      }
      return json(200)
    }
    if (method === "DELETE" && (parameters = route(/^\/networks\/([^/]+)$/u))) {
      await this.#networkRemove(parameters[0] ?? "")
      return json(204)
    }
    if (method === "GET" && path === "/volumes") {
      const filters = apiFilters(url)
      return json(200, {
        Volumes: [...this.volumes.values()]
          .filter((volume) =>
            this.#labelled(volume.labels, filters, "volume ls")
          )
          .map((volume) => ({
            Driver: "local",
            Labels: volume.labels,
            Name: volume.name,
          })),
      })
    }
    if (method === "GET" && (parameters = route(/^\/volumes\/([^/]+)$/u))) {
      const volume = this.volumes.get(parameters[0] ?? "")
      if (!volume) {
        throw new DockerFailure(`get ${parameters[0]}: no such volume`, 404)
      }
      return json(200, {
        Driver: "local",
        Labels: volume.labels,
        Name: volume.name,
      })
    }
    if (method === "DELETE" && (parameters = route(/^\/volumes\/([^/]+)$/u))) {
      await this.#volumeRemove(parameters[0] ?? "")
      return json(204)
    }
    if (method === "POST" && path === "/images/create") {
      const fromImage = url.searchParams.get("fromImage") ?? ""
      const tag = url.searchParams.get("tag") ?? "latest"
      const reference = tag.includes(":")
        ? `${fromImage}@${tag}`
        : `${fromImage}:${tag}`
      return this.#pullFromApi(reference, headers["x-registry-auth"])
    }
    if (
      method === "POST" &&
      (parameters = route(/^\/images\/(.+)\/tag$/u))
    ) {
      const [source = ""] = parameters
      const key = this.#imageKey(source)
      if (key === undefined) {
        throw new DockerFailure(`No such image: ${source}`, 404)
      }
      const target = `${url.searchParams.get("repo")}:${url.searchParams.get("tag") ?? "latest"}`
      await this.#checkpoint("tag", target)
      this.imageTags.set(normalizedImage(target), this.#imageId(source))
      this.images.set(target, this.images.get(key) ?? {})
      const config = this.imageConfigs.get(key)
      if (config) this.imageConfigs.set(target, config)
      return json(201)
    }
    if (method === "GET" && path === "/images/json") {
      const filters = apiFilters(url)
      return json(
        200,
        [...this.images]
          .filter(([, labels]) => this.#labelled(labels, filters, "image ls"))
          .map(([image, labels]) => ({
            Id: `sha256:${image}`,
            Labels: labels,
            RepoTags: [image],
          }))
      )
    }
    if (
      method === "DELETE" &&
      (parameters = route(/^\/images\/(.+)$/u)) &&
      !path.endsWith("/json")
    ) {
      const [reference = ""] = parameters
      const image = [...this.images.keys()].find(
        (candidate) =>
          candidate === reference || `sha256:${candidate}` === reference
      )
      if (!image) throw new DockerFailure(`No such image: ${reference}`, 404)
      this.images.delete(image)
      return json(200, [{ Deleted: `sha256:${image}` }])
    }
    if (method === "GET" && (parameters = route(/^\/images\/(.+)\/json$/u))) {
      const [image = ""] = parameters
      const found = this.#imageObject(image)
      if (!found) throw new DockerFailure(`No such image: ${image}`, 404)
      return json(200, found)
    }
    return this.#unsupported(`${method} ${path}`)
  }

  /**
   * `POST /images/create`: its progress as JSON messages. A registry that
   * can't be reached fails within the stream, after Docker answered 200.
   */
  async #pullFromApi(
    reference: string,
    auth: string | Array<string> | undefined
  ): Promise<ApiAnswer> {
    const named = (images: Iterable<string>) =>
      [...images].find(
        (image) => normalizedImage(image) === normalizedImage(reference)
      )
    const image = named(this.images.keys()) ?? named(this.pullOutput.keys()) ??
      named(this.unreachableImages) ?? reference
    await this.#checkpoint("pull", image)
    this.pulls.set(
      normalizedImage(reference),
      typeof auth === "string"
        ? JSON.parse(Buffer.from(auth, "base64").toString("utf8"))
        : null
    )
    const messages: Array<unknown> = (this.pullOutput.get(image) ?? "")
      .split("\n")
      .filter(Boolean)
      .map((status) => ({ status }))
    if (this.unreachableImages.has(image)) {
      const message = `Get "https://registry.example/v2/": net/http: request canceled (registry timeout)`
      messages.push({ error: message, errorDetail: { message } })
    } else {
      this.images.set(image, this.images.get(image) ?? {})
      messages.push({ status: `Status: Downloaded newer image for ${image}` })
    }
    return {
      kind: "stream",
      write: (response) => {
        response.writeHead(200, { "Content-Type": "application/json" })
        response.end(
          messages.map((message) => `${JSON.stringify(message)}\r\n`).join("")
        )
      },
    }
  }

  /** `docker logs`; following ends when the container stops. */
  #logStream(container: FakeContainer, url: URL): ApiAnswer {
    const since = url.searchParams.get("since")
    const until = url.searchParams.get("until")
    const tail = url.searchParams.get("tail") ?? "all"
    const lines = container.logs.filter(
      ({ time }) =>
        (since === null || Date.parse(time) >= unixMilliseconds(since)) &&
        (until === null || Date.parse(time) < unixMilliseconds(until))
    )
    const selected = tail === "all" ? lines : lines.slice(-Number(tail))
    const follow = url.searchParams.get("follow") === "1"
    return {
      kind: "stream",
      write: (response) => {
        response.writeHead(200, {
          "Content-Type": container.tty
            ? "application/vnd.docker.raw-stream"
            : "application/vnd.docker.multiplexed-stream",
        })
        const error = container.logStreamError
        // A follower is registered before the history is sent, so the
        // container stopping meanwhile still ends the response.
        const follower =
          follow && error === null && container.state.running
            ? { containerId: container.id, response }
            : null
        if (follower) this.#followers.add(follower)
        let closed = false
        response.once("close", () => {
          closed = true
          if (follower) this.#followers.delete(follower)
        })
        // Sent as the reader takes it, as Docker does, so a reader that hangs
        // up stops the rest from being read.
        const send = async () => {
          for (const { text, time } of selected) {
            if (closed) {
              container.lastLogRead = "abandoned"
              return
            }
            // The container stopped, which ends its followers.
            if (response.writableEnded) return
            const line = Buffer.from(`${time} ${text}\n`)
            if (!response.write(container.tty ? line : frame(1, line))) {
              await writable(response)
            }
          }
          container.lastLogRead = "complete"
          if (response.writableEnded) return
          // Having answered 200, Docker reports a failed read in the stream.
          if (error !== null) response.end(frame(3, Buffer.from(error)))
          else if (!follower) response.end()
        }
        void send()
      },
    }
  }

  /** A non-interactive exec: its output, multiplexed, ends as it exits. */
  #runExec(exec: FakeExec): ApiAnswer {
    const container = this.containers.get(exec.containerId)
    if (!container?.state.running) {
      throw new DockerFailure(
        `Container ${exec.containerId} is not running`,
        409
      )
    }
    let stdout = ""
    let stderr = ""
    try {
      stdout = this.#runProgram(
        container,
        exec.cmd,
        exec.env,
        "",
        exec.user
      )
      exec.exitCode = 0
    } catch (cause) {
      if (!(cause instanceof DockerFailure)) throw cause
      stderr = `${cause.message}\n`
      exec.exitCode = 1
    }
    return {
      kind: "stream",
      write: (response) => {
        response.writeHead(200, {
          "Content-Type": "application/vnd.docker.raw-stream",
        })
        if (stdout) response.write(frame(1, Buffer.from(stdout)))
        if (stderr) response.write(frame(2, Buffer.from(stderr)))
        response.end()
      },
    }
  }

  #createFromApi(name: string | undefined, body: CreateBody): FakeContainer {
    const host = body.HostConfig ?? {}
    const mounts: Array<FakeMount> = [
      ...(host.Binds ?? []).map((bind) => parseVolume(bind)),
      ...(host.Mounts ?? []).map((mount) => ({
        destination: mount.Target,
        readOnly: mount.ReadOnly ?? false,
        ...(mount.Type === "volume" && !mount.Source
          ? { anonymous: true, source: randomBytes(32).toString("hex") }
          : { source: mount.Source ?? "" }),
        type: mount.Type === "volume" ? ("volume" as const) : ("bind" as const),
      })),
    ]
    for (const destination of Object.keys(body.Volumes ?? {})) {
      if (mounts.some((mount) => mount.destination === destination)) continue
      mounts.push({
        anonymous: true,
        destination,
        source: randomBytes(32).toString("hex"),
        type: "volume",
      })
    }
    const endpoints = body.NetworkingConfig?.EndpointsConfig ?? {}
    for (const [network, endpoint] of Object.entries(endpoints)) {
      if (isNetworkMode(network) && endpoint.Aliases?.length) {
        throw new DockerFailure(
          "network-scoped aliases are only supported for user-defined networks",
          400
        )
      }
    }
    return this.#createContainer({
      autoRemove: host.AutoRemove ?? false,
      cmd: body.Cmd ?? [],
      hostname: body.Hostname,
      volumesFrom: host.VolumesFrom ?? [],
      env: Object.fromEntries(
        (body.Env ?? []).map(
          (entry) => splitOnce(entry, "=") as [string, string]
        )
      ),
      healthCheck:
        body.Healthcheck !== undefined && body.Healthcheck.Test?.[0] !== "NONE",
      image: body.Image,
      interactive: body.OpenStdin ?? false,
      labels: { ...body.Labels },
      memoryBytes: host.Memory ?? 0,
      mounts,
      name,
      networkMode: host.NetworkMode,
      networks: Object.entries(endpoints)
        .filter(([network]) => !isNetworkMode(network))
        .map(([network, endpoint]) => ({
          aliases: endpoint.Aliases ?? [],
          ipAddress: endpoint.IPAMConfig?.IPv4Address ?? "",
          name: network,
        })),
      portBindings: Object.fromEntries(
        Object.entries(host.PortBindings ?? {}).map(([port, hosts]) => [
          port,
          (hosts ?? []).map((binding) => ({
            HostIp: binding.HostIp ?? "",
            HostPort: binding.HostPort ?? "",
          })),
        ])
      ),
      restartPolicy: host.RestartPolicy?.Name ?? "no",
      tty: body.Tty ?? false,
    })
  }

  #attach(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? "/", "http://docker")
    const execStart = /^\/exec\/([^/]+)\/start$/u.exec(url.pathname)?.[1]
    if (execStart) {
      this.#startExec(decodeURIComponent(execStart), request, socket, head)
      return
    }
    const reference = /^\/containers\/([^/]+)\/attach$/u.exec(url.pathname)?.[1]
    const container = reference
      ? this.container(decodeURIComponent(reference))
      : undefined
    if (
      container &&
      !container.state.running &&
      container.autoRemove &&
      container.openStdin
    ) {
      socket.write(
        "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"
      )
      const run = { input: [] as Array<Buffer>, socket, stdinEnded: false }
      container.runOnce = run
      if (head.length > 0) run.input.push(head)
      socket.on("data", (chunk: Buffer) => run.input.push(chunk))
      socket.on("end", () => {
        run.stdinEnded = true
        this.#finishRunOnce(container)
      })
      socket.on("error", () => undefined)
      return
    }
    if (!container?.state.running) {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
      return
    }
    socket.write(
      "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"
    )
    socket.on("data", (chunk: Buffer) => {
      container.stdin += chunk.toString("utf8")
    })
    socket.on("error", () => undefined)
  }

  #startExec(
    execId: string,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ) {
    const exec = this.execs.get(execId)
    if (!exec || exec.running) {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
      return
    }
    if (!exec.tty) {
      this.#startStreamedExec(exec, request, socket, head)
      return
    }
    exec.running = true
    this.#execSockets.set(execId, socket)
    socket.write(
      `HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n${exec.tty ? this.execGreeting : ""}`
    )
    // The start options arrive as a body ahead of the TTY stream.
    let options = Buffer.alloc(0)
    let optionsLength = Number(request.headers["content-length"] ?? 0)
    const receive = (chunk: Buffer) => {
      if (optionsLength > 0) {
        const taken = chunk.subarray(0, optionsLength)
        options = Buffer.concat([options, taken])
        optionsLength -= taken.length
        chunk = chunk.subarray(taken.length)
        if (optionsLength === 0) {
          const input = JSON.parse(options.toString("utf8") || "{}") as {
            ConsoleSize?: [number, number]
          }
          if (input.ConsoleSize) {
            exec.size = {
              cols: input.ConsoleSize[1],
              rows: input.ConsoleSize[0],
            }
          }
        }
      }
      if (chunk.length > 0) socket.write(chunk)
    }
    if (head.length > 0) receive(head)
    socket.on("data", receive)
    socket.on("close", () => {
      exec.running = false
      this.#execSockets.delete(execId)
    })
    socket.on("error", () => undefined)
  }

  /**
   * A non-TTY exec over an upgraded connection: it reads stdin until the
   * client half-closes it (or right away without stdin), then answers with
   * its output, multiplexed, and exits.
   */
  #startStreamedExec(
    exec: FakeExec,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ) {
    exec.running = true
    this.#execSockets.set(exec.id, socket)
    socket.write(
      "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"
    )
    let bodyLeft = Number(request.headers["content-length"] ?? 0)
    const input: Array<Buffer> = []
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      const container = this.containers.get(exec.containerId)
      let stdout = ""
      let stderr = ""
      let exitCode = 0
      if (!container?.state.running) {
        stderr = "container is not running\n"
        exitCode = 126
      } else {
        try {
          stdout = this.#runProgram(
            container,
            exec.cmd,
            exec.env,
            Buffer.concat(input).toString("utf8"),
            exec.user
          )
        } catch (cause) {
          if (!(cause instanceof DockerFailure)) throw cause
          stderr = `${cause.message}\n`
          exitCode = 1
        }
      }
      exec.exitCode = exitCode
      exec.running = false
      if (socket.destroyed) return
      const streamError = this.streamErrors.get(clientOf(exec.cmd))
      if (streamError !== undefined) {
        socket.end(frame(3, Buffer.from(streamError)))
        return
      }
      if (stdout) socket.write(frame(1, Buffer.from(stdout)))
      if (stderr) socket.write(frame(2, Buffer.from(stderr)))
      socket.end()
    }
    const receive = (chunk: Buffer) => {
      if (bodyLeft > 0) {
        const taken = Math.min(bodyLeft, chunk.length)
        bodyLeft -= taken
        chunk = chunk.subarray(taken)
      }
      if (chunk.length === 0) return
      input.push(chunk)
      // A failing client stops at its first input, as psql does at a bad
      // statement, without reading the rest.
      if (this.programFailures.has(clientOf(exec.cmd))) finish()
    }
    if (head.length > 0) receive(head)
    socket.on("data", receive)
    // The client half-closing the connection closes the process's stdin.
    socket.on("end", finish)
    socket.on("close", () => {
      exec.running = false
      this.#execSockets.delete(exec.id)
    })
    socket.on("error", () => undefined)
    if (!exec.attachStdin) setImmediate(finish)
  }

  // Detached execs Relay runs are `sh -c` scripts that hang up clients by
  // the PID files those clients wrote; model their effect, not the shell.
  #runDetachedExec(exec: FakeExec) {
    const [shell, , script = "", pidFile = ""] = exec.cmd
    if (shell !== "sh" || !script.includes("kill -HUP")) return
    const sweep = script.includes("for file in")
    for (const candidate of this.execs.values()) {
      const candidateFile = candidate.cmd[3] ?? ""
      if (
        candidate.running &&
        candidate.containerId === exec.containerId &&
        (sweep ? candidateFile.startsWith(pidFile) : candidateFile === pidFile)
      ) {
        this.exitExec(candidate.id)
      }
    }
  }

  /** Ends a running exec the way its process exiting would. */
  exitExec(execId: string) {
    const exec = this.execs.get(execId)
    if (!exec) throw new Error(`No such exec ${execId}`)
    exec.running = false
    this.#execSockets.get(execId)?.end()
  }

  // ---------------------------------------------------------------- helpers

  #requiredContainer(reference: string): FakeContainer {
    const container = this.container(reference)
    if (!container) {
      throw new DockerFailure(`No such container: ${reference}`, 404)
    }
    return container
  }

  /** Strictly increasing ISO timestamps, so every start is a new generation. */
  #timestamp(): string {
    this.#lastTimestamp = Math.max(Date.now(), this.#lastTimestamp + 1)
    return new Date(this.#lastTimestamp).toISOString()
  }
}

/** The fake shared by a test file and the mocked `./command.js` module. */
export const fakeDocker = new FakeDocker()

// ------------------------------------------- `./command.js` replacement API

export function command(
  executable: string,
  arguments_: Array<string>,
  options: CommandOptions = {}
): Promise<CommandResult> {
  return fakeDocker.run(executable, arguments_, options)
}

export function commandEffect(
  executable: string,
  arguments_: Array<string>,
  options: CommandOptions = {}
): Effect.Effect<CommandResult, CommandError> {
  return Effect.tryPromise({
    try: () => fakeDocker.run(executable, arguments_, options),
    catch: (cause) =>
      CommandError.make({
        executable,
        message:
          cause instanceof Error ? cause.message : `${executable} failed`,
        cause,
      }),
  })
}

export function commandWithInput(
  executable: string,
  arguments_: ReadonlyArray<string>,
  input: string | undefined
): Promise<CommandResult> {
  return fakeDocker.run(executable, arguments_, {}, input)
}

export async function commandLines(
  executable: string,
  arguments_: ReadonlyArray<string>,
  onLine: (line: string) => void,
  options: { input?: string; signal?: AbortSignal; timeout?: number } = {}
): Promise<void> {
  const result = await fakeDocker.run(
    executable,
    arguments_,
    {
      maxBuffer: Number.POSITIVE_INFINITY,
      signal: options.signal,
      timeout: options.timeout,
    },
    options.input
  )
  for (const output of [result.stdout, result.stderr]) {
    for (const line of output.split("\n")) if (line) onLine(line)
  }
}

// ------------------------------------------------------------------ parsing

interface CreateBody {
  Cmd?: Array<string> | null
  Env?: Array<string> | null
  Healthcheck?: { Test?: Array<string> }
  Hostname?: string
  HostConfig?: {
    AutoRemove?: boolean
    VolumesFrom?: Array<string> | null
    Binds?: Array<string> | null
    Memory?: number
    Mounts?: Array<{
      ReadOnly?: boolean
      Source?: string
      Target: string
      Type: string
    }>
    NetworkMode?: string
    PortBindings?: Record<
      string,
      Array<{ HostIp?: string; HostPort?: string }> | null
    >
    RestartPolicy?: { Name?: string }
  }
  Image: string
  Labels?: Record<string, string>
  Volumes?: Record<string, object>
  NetworkingConfig?: {
    EndpointsConfig?: Record<
      string,
      { Aliases?: Array<string>; IPAMConfig?: { IPv4Address?: string } }
    >
  }
  OpenStdin?: boolean
  Tty?: boolean
}

function parseVolume(volume: string): FakeMount {
  const [source = "", destination = "", mode] = volume.split(":")
  return {
    destination,
    readOnly: mode === "ro",
    source,
    type: source.startsWith("/") ? "bind" : "volume",
  }
}

/** The program a process runs: a shell script names it with `exec`. */
function clientOf(argv: ReadonlyArray<string>): string {
  const [program = "", , script = ""] = argv
  return program === "sh" || program === "bash"
    ? (/\bexec (\S+)/u.exec(script)?.[1] ?? program)
    : program
}

/**
 * An image reference in Docker's normalized form, or itself if invalid. A
 * digest names the image whatever its tag, as Docker resolves it.
 */
function normalizedImage(reference: string): string {
  const parsed = Result.try(() => parseImageReference(reference))
  if (Result.isFailure(parsed)) return reference
  const { digest, tag } = parsed.success
  return normalizedReference({
    ...parsed.success,
    tag: digest ? undefined : tag,
  })
}

/**
 * `default`, `host`, `none`, `bridge`, and `container:<name>` are modes, not
 * networks.
 */
function isNetworkMode(network: string): boolean {
  return (
    network === "default" ||
    network === "host" ||
    network === "none" ||
    network === "bridge" ||
    network.startsWith("container:")
  )
}

function splitOnce(value: string, separator: string): [string, string?] {
  const index = value.indexOf(separator)
  return index === -1
    ? [value]
    : [value.slice(0, index), value.slice(index + separator.length)]
}

/** The iptables subcommands Relay uses, against one network namespace. */
function iptables(
  chains: Map<string, Array<string>>,
  arguments_: Array<string>
): string {
  const [operation = "", chain = "", ...rule] = arguments_
  if (!chains.has("FORWARD")) chains.set("FORWARD", [])
  const rules = chains.get(chain)
  const missing = () =>
    new DockerFailure("iptables: No chain/target/match by that name.")
  switch (operation) {
    case "-N":
      if (chains.has(chain))
        throw new DockerFailure("iptables: Chain already exists.")
      chains.set(chain, [])
      return ""
    case "-S":
      if (!rules) throw missing()
      return [`-N ${chain}`, ...rules].map((line) => `${line}\n`).join("")
    case "-F":
      if (!rules) throw missing()
      rules.length = 0
      return ""
    case "-A":
      if (!rules) throw missing()
      rules.push(["-A", chain, ...rule].join(" "))
      return ""
    case "-I": {
      if (!rules) throw missing()
      const [position = "1", ...inserted] = rule
      rules.splice(
        Number(position) - 1,
        0,
        ["-A", chain, ...inserted].join(" ")
      )
      return ""
    }
    case "-C":
      if (!rules?.includes(["-A", chain, ...rule].join(" "))) {
        throw new DockerFailure(
          "iptables: Bad rule (does a matching rule exist in that chain?)."
        )
      }
      return ""
  }
  throw new Error(`FakeDocker does not model iptables ${arguments_.join(" ")}`)
}

function procNetTcp(listeningPorts: ReadonlyArray<number>): string {
  const header =
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode"
  const rows = listeningPorts.map(
    (port, index) =>
      `   ${index}: 00000000:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${10_000 + index}`
  )
  return `${[header, ...rows].join("\n")}\n`
}

type ApiAnswer =
  | { kind: "json"; payload: unknown; status: number }
  | { kind: "stream"; write: (response: ServerResponse) => void }

/** The API's `filters` parameter as the CLI's `--filter key=value` strings. */
function apiFilters(url: URL): Array<string> {
  const filters = JSON.parse(url.searchParams.get("filters") ?? "{}") as Record<
    string,
    Array<string>
  >
  return Object.entries(filters).flatMap(([key, values]) =>
    values.map((value) => `${key}=${value}`)
  )
}

function containerSummary(container: FakeContainer): unknown {
  return {
    Id: container.id,
    Image: container.image,
    Labels: container.labels,
    Names: [`/${container.name}`],
    Ports: Object.entries(container.portBindings).flatMap(([port, hosts]) => {
      const [privatePort = "0", type = "tcp"] = port.split("/")
      const exposed = { PrivatePort: Number(privatePort), Type: type }
      if (!container.state.running) return [exposed]
      return hosts.flatMap((host) =>
        (host.HostIp ? [host.HostIp] : ["0.0.0.0", "::"]).map((ip) => ({
          ...exposed,
          IP: ip,
          PublicPort: Number(host.HostPort),
        }))
      )
    }),
    State: container.state.running
      ? "running"
      : container.state.startedAt === NEVER
        ? "created"
        : "exited",
  }
}

/**
 * One frame of a multiplexed stream: 1 is stdout, 2 is stderr, and 3 an error
 * Docker hit while streaming.
 */
function frame(stream: 1 | 2 | 3, payload: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header[0] = stream
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

/** Waits until `response` drains or closes, leaving no listener behind. */
function writable(response: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      response.off("drain", done)
      response.off("close", done)
      resolve()
    }
    response.on("drain", done)
    response.on("close", done)
  })
}

/** Unix seconds with nanoseconds, as `since` and `until` take them. */
function unixMilliseconds(value: string): number {
  const [seconds = "0", fraction = ""] = value.split(".")
  return Number(seconds) * 1_000 + Number(fraction.padEnd(9, "0").slice(0, 3))
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", reject)
  })
}
