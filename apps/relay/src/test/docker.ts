/**
 * A stateful, in-memory Docker for Relay tests.
 *
 * Relay drives Docker through the Engine API on `config.dockerSocket` and, to
 * create containers, networks, and volumes, pull images, and run clients that
 * read stdin, the CLI (`./command.js`). Tests replace both at that boundary:
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

import { Effect } from "effect"

import type { CommandOptions, CommandResult } from "../command.js"
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
  processes: Array<{ argv: Array<string>; env: Record<string, string> }>
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
const VALUE_FLAGS = new Set([
  "--cap-add",
  "--cap-drop",
  "--device",
  "--entrypoint",
  "--env",
  "--health-cmd",
  "--health-interval",
  "--health-retries",
  "--health-start-period",
  "--health-timeout",
  "--hostname",
  "--ip",
  "--label",
  "--memory",
  "--memory-reservation",
  "--memory-swap",
  "--mount",
  "--name",
  "--network",
  "--network-alias",
  "--pids-limit",
  "--publish",
  "--restart",
  "--security-opt",
  "--stop-signal",
  "--sysctl",
  "--tmpfs",
  "--user",
  "--volume",
  "--workdir",
  "-e",
])
const BOOLEAN_FLAGS = new Set([
  "--detach",
  "--interactive",
  "--read-only",
  "--rm",
  "--tty",
  "-i",
])

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
  /** Images whose registry cannot be reached; pulling them fails. */
  readonly unreachableImages = new Set<string>()
  /** The Tailscale control plane, keyed by machine (container) name. */
  readonly tailscale = {
    controlPlaneReachable: true,
    machines: new Map<string, { ipv4: string; loggedIn: boolean }>(),
  }
  readonly #faults: Array<{
    match: FakeDockerOperation
    run: () => Promise<void>
  }> = []
  #unmodelled: Array<string> = []
  #inFlight = 0
  #lastActivity = 0
  #lastTimestamp = 0
  #socketPath: string | null = null
  readonly #execSockets = new Map<string, Duplex>()
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
    this.tailscale.controlPlaneReachable = true
    this.tailscale.machines.clear()
    this.#faults.length = 0
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
      hostname: seed.name,
      labels: { ...seed.labels },
      env: { ...seed.env },
      cmd: [],
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
      logs: [...(seed.logs ?? [])],
      logStreamError: null,
      lastLogRead: null,
      stdin: "",
      processes: [],
      firewall: new Map(),
      listeningPorts: [...(seed.listeningPorts ?? [])],
    }
    this.containers.set(container.id, container)
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
   * Resolves once Docker has been quiet for a moment, for work Relay starts in
   * the background (recovery restarts, compensating stops). A request Relay
   * just sent to the socket can still be on its way, so no request running is
   * not enough.
   */
  idle(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.#inFlight === 0 && Date.now() - this.#lastActivity >= 25) {
          // Let callers observe the result before waiters resume.
          setImmediate(resolve)
        } else {
          setTimeout(check, 5)
        }
      }
      setTimeout(check, 5)
    })
  }

  /** The `command()` boundary: runs one Docker CLI invocation. */
  async run(
    executable: string,
    arguments_: ReadonlyArray<string>,
    options: CommandOptions = {},
    input?: string
  ): Promise<CommandResult> {
    const commandLine = `${executable} ${arguments_.join(" ")}`
    if (executable !== "docker") return this.#unsupported(commandLine)
    this.#begin()
    try {
      const stdout = await this.#dispatch([...arguments_], options, input)
      // As execFile, which `command` runs on, fails on more output.
      if (Buffer.byteLength(stdout) > (options.maxBuffer ?? 4 * 1024 * 1024)) {
        throw new Error(
          `Command failed: ${commandLine}\nstdout maxBuffer length exceeded`
        )
      }
      return { stderr: "", stdout }
    } catch (cause) {
      if (cause instanceof DockerFailure) {
        throw new Error(
          `Command failed: ${commandLine}\nError response from daemon: ${cause.message}\n`
        )
      }
      throw cause
    } finally {
      this.#settled()
    }
  }

  #begin(): void {
    this.#inFlight += 1
    this.#lastActivity = Date.now()
  }

  #settled(): void {
    this.#inFlight -= 1
    this.#lastActivity = Date.now()
  }

  // What Relay still runs through the CLI; everything else uses the API.
  async #dispatch(
    arguments_: Array<string>,
    options: CommandOptions,
    input: string | undefined
  ): Promise<string> {
    const [first = "", second = ""] = arguments_
    const rest = arguments_.slice(1)
    if (first === "container" && second === "create") {
      return this.#create(arguments_.slice(2), options, false, input)
    }
    if (first === "create") return this.#create(rest, options, false, input)
    if (first === "run") return this.#create(rest, options, true, input)
    if (first === "network") return this.#networkCommand(rest)
    if (first === "volume") return this.#volumeCommand(rest)
    if (first === "exec") return this.#exec(rest)
    if (first === "pull") return this.#pull(rest)
    return this.#unsupported(`docker ${arguments_.join(" ")}`)
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
      .filter((mount) => mount.type === "volume")
      .map((mount) => ({
        ReadOnly: mount.readOnly ?? false,
        Source: mount.source,
        Target: mount.destination,
        Type: "volume",
      }))
    return {
      Config: {
        AttachStderr: true,
        AttachStdin: container.openStdin,
        AttachStdout: true,
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
      },
      HostConfig: {
        Binds: binds,
        Memory: container.memoryBytes,
        Mounts: volumeMounts,
        NetworkMode: container.networkMode,
        PortBindings: container.portBindings,
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
        Status: container.state.running
          ? "running"
          : container.state.startedAt === NEVER
            ? "created"
            : "exited",
      },
    }
  }

  #imageObject(image: string): unknown {
    const labels = this.images.get(image)
    return labels === undefined
      ? undefined
      : { Config: { Labels: labels }, Id: `sha256:${image}`, RepoTags: [image] }
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

  async #create(
    arguments_: Array<string>,
    options: CommandOptions,
    run: boolean,
    input: string | undefined
  ): Promise<string> {
    const parsed = parseRunArguments(arguments_, options.env)
    await this.#checkpoint(run ? "run" : "create", parsed.name)
    if (parsed.flags.has("--rm")) return this.#runOnce(parsed, input)
    const container = this.#createContainer({
      cmd: parsed.cmd,
      env: parsed.env,
      healthCheck: parsed.healthCheck,
      image: parsed.image,
      interactive: parsed.flags.has("--interactive"),
      labels: parsed.labels,
      memoryBytes: parsed.memoryBytes,
      mounts: parsed.mounts,
      name: parsed.name,
      networkMode: parsed.network,
      networks:
        parsed.network && !isNetworkMode(parsed.network)
          ? [
              {
                aliases: parsed.aliases,
                ipAddress: parsed.ip,
                name: parsed.network,
              },
            ]
          : [],
      portBindings: parsed.portBindings,
      restartPolicy: parsed.restartPolicy,
      tty: parsed.flags.has("--tty"),
    })
    if (run) this.#start(container)
    return `${container.id}\n`
  }

  #createContainer(input: {
    cmd: Array<string>
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
    if (this.unreachableImages.has(input.image)) {
      throw new DockerFailure(`pull access denied for ${input.image}`)
    }
    for (const { name: network } of input.networks) {
      if (!this.networks.has(network)) {
        throw new DockerFailure(`network ${network} not found`)
      }
    }
    this.images.set(input.image, this.images.get(input.image) ?? {})
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
  #runOnce(parsed: ParsedRunArguments, input: string | undefined): string {
    const script = parsed.cmd[0] === "-c" ? (parsed.cmd[1] ?? "") : ""
    const target = /cat > (\S+)/u.exec(script)?.[1]
    if (!target) {
      return this.#unsupported(`docker run --rm ${parsed.cmd.join(" ")}`)
    }
    for (const mount of parsed.mounts) {
      const relative = posix.relative(mount.destination, target)
      if (mount.type !== "volume" || relative.startsWith("..")) continue
      const volume = this.volumes.get(mount.source)
      if (!volume) throw new DockerFailure(`no such volume: ${mount.source}`)
      volume.files.set(relative, input ?? "")
      return ""
    }
    throw new DockerFailure(`${target} is not on a mounted volume`)
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
    return true
  }

  #start(container: FakeContainer): void {
    container.state.running = true
    container.state.restarting = false
    container.state.exitCode = 0
    container.state.oomKilled = false
    container.state.startedAt = this.#timestamp()
    container.state.health = container.healthCheck ? "healthy" : undefined
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
  }

  async #setRestartPolicy(reference: string, policy: string): Promise<void> {
    await this.#checkpoint("update", reference)
    this.#requiredContainer(reference).restartPolicy = policy
  }

  // ---------------------------------------------------------- logs and exec

  async #exec(arguments_: Array<string>): Promise<string> {
    const env: Record<string, string> = {}
    let index = 0
    while (arguments_[index]?.startsWith("-")) {
      const flag = arguments_[index]
      if (flag === "-e" || flag === "--env") {
        const [name, value = ""] = splitOnce(arguments_[index + 1] ?? "", "=")
        env[name] = value
        index += 2
      } else if (flag === "-i" || flag === "--interactive") {
        index += 1
      } else {
        return this.#unsupported(`docker exec ${arguments_.join(" ")}`)
      }
    }
    const reference = arguments_[index] ?? ""
    const argv = arguments_.slice(index + 1)
    await this.#checkpoint("exec", reference)
    const container = this.#requiredContainer(reference)
    if (!container.state.running) {
      throw new DockerFailure(`container ${reference} is not running`, 409)
    }
    return this.#runProgram(container, argv, env)
  }

  /** What a process Relay runs with `docker exec` prints, or how it fails. */
  #runProgram(
    container: FakeContainer,
    argv: Array<string>,
    env: Record<string, string>
  ): string {
    container.processes.push({ argv, env })
    const [program = "", ...programArguments] = argv
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

  async #pull(arguments_: Array<string>): Promise<string> {
    const [image = ""] = arguments_
    await this.#checkpoint("pull", image)
    if (this.unreachableImages.has(image)) {
      throw new DockerFailure(
        `Get "https://registry.example/v2/": net/http: request canceled (registry timeout)`
      )
    }
    this.images.set(image, this.images.get(image) ?? {})
    return `Status: Downloaded newer image for ${image}\n`
  }

  // ------------------------------------------------------ networks, volumes

  async #networkCommand(arguments_: Array<string>): Promise<string> {
    const [subcommand = "", ...rest] = arguments_
    if (subcommand === "create") {
      const { flags, positional, values } = parseFlags(rest, [
        "--driver",
        "--label",
        "--subnet",
      ])
      const [name = ""] = positional
      await this.#checkpoint("network create", name)
      if (this.networks.has(name)) {
        throw new DockerFailure(`network with name ${name} already exists`, 409)
      }
      const network = this.addNetwork({
        internal: flags.has("--internal"),
        labels: labelsFrom(values.get("--label") ?? []),
        name,
        subnet: values.get("--subnet")?.[0],
      })
      return `${network.id}\n`
    }
    return this.#unsupported(`docker network ${arguments_.join(" ")}`)
  }

  #networkList(filters: Array<string>): Array<FakeNetwork> {
    return [...this.networks.values()].filter((network) =>
      filters.every((filter) => {
        const [key, value = ""] = splitOnce(filter, "=")
        if (key !== "label") {
          return this.#unsupported(`docker network ls --filter ${filter}`)
        }
        const [label, expected] = splitOnce(value, "=")
        return expected === undefined
          ? Object.hasOwn(network.labels, label)
          : network.labels[label] === expected
      })
    )
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

  async #volumeCommand(arguments_: Array<string>): Promise<string> {
    const [subcommand = "", ...rest] = arguments_
    if (subcommand === "create") {
      const { positional, values } = parseFlags(rest, ["--label"])
      const [name = ""] = positional
      await this.#checkpoint("volume create", name)
      if (!this.volumes.has(name)) {
        this.addVolume({
          labels: labelsFrom(values.get("--label") ?? []),
          name,
        })
      }
      return `${name}\n`
    }
    return this.#unsupported(`docker volume ${arguments_.join(" ")}`)
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
      const answer = await this.#route(request.method ?? "GET", url, body)
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

  async #route(method: string, url: URL, body: string): Promise<ApiAnswer> {
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
      return json(201, { Id: container.id, Warnings: [] })
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
      if (!target.state.running) {
        throw new DockerFailure(`Container ${target.id} is not running`, 409)
      }
      const input = JSON.parse(body) as {
        Cmd?: Array<string>
        Env?: Array<string>
        Tty?: boolean
        User?: string
      }
      if (input.User) return this.#unsupported(`exec as ${input.User}`)
      const exec: FakeExec = {
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
    if (method === "GET" && (parameters = route(/^\/images\/(.+)\/json$/u))) {
      const [image = ""] = parameters
      const found = this.#imageObject(image)
      if (!found) throw new DockerFailure(`No such image: ${image}`, 404)
      return json(200, found)
    }
    return this.#unsupported(`${method} ${path}`)
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
      stdout = this.#runProgram(container, exec.cmd, exec.env)
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
        source: mount.Source,
        type: mount.Type === "volume" ? ("volume" as const) : ("bind" as const),
      })),
    ]
    const endpoints = body.NetworkingConfig?.EndpointsConfig ?? {}
    return this.#createContainer({
      cmd: body.Cmd ?? [],
      env: Object.fromEntries(
        (body.Env ?? []).map(
          (entry) => splitOnce(entry, "=") as [string, string]
        )
      ),
      healthCheck: body.Healthcheck !== undefined,
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
  options: { signal?: AbortSignal; timeout?: number } = {}
): Promise<void> {
  const result = await fakeDocker.run(executable, arguments_, {
    maxBuffer: Number.POSITIVE_INFINITY,
    signal: options.signal,
    timeout: options.timeout,
  })
  for (const output of [result.stdout, result.stderr]) {
    for (const line of output.split("\n")) if (line) onLine(line)
  }
}

// ------------------------------------------------------------------ parsing

interface CreateBody {
  Cmd?: Array<string>
  Env?: Array<string>
  Healthcheck?: unknown
  HostConfig?: {
    Binds?: Array<string>
    Memory?: number
    Mounts?: Array<{
      ReadOnly?: boolean
      Source: string
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
  NetworkingConfig?: {
    EndpointsConfig?: Record<
      string,
      { Aliases?: Array<string>; IPAMConfig?: { IPv4Address?: string } }
    >
  }
  OpenStdin?: boolean
  Tty?: boolean
}

interface ParsedRunArguments {
  aliases: Array<string>
  cmd: Array<string>
  env: Record<string, string>
  flags: Set<string>
  healthCheck: boolean
  image: string
  ip: string
  labels: Record<string, string>
  memoryBytes: number
  mounts: Array<FakeMount>
  name: string | undefined
  network: string | undefined
  portBindings: PortBindings
  restartPolicy: string
}

function parseRunArguments(
  arguments_: Array<string>,
  processEnv: NodeJS.ProcessEnv | undefined
): ParsedRunArguments {
  const flags = new Set<string>()
  const values = new Map<string, Array<string>>()
  let index = 0
  while (index < arguments_.length && arguments_[index]?.startsWith("-")) {
    const flag = arguments_[index] ?? ""
    if (BOOLEAN_FLAGS.has(flag)) {
      flags.add(flag === "-i" ? "--interactive" : flag)
      index += 1
      continue
    }
    if (!VALUE_FLAGS.has(flag)) {
      throw new Error(`FakeDocker does not model run flag ${flag}`)
    }
    const key = flag === "-e" ? "--env" : flag
    values.set(key, [...(values.get(key) ?? []), arguments_[index + 1] ?? ""])
    index += 2
  }
  const image = arguments_[index] ?? ""
  const env: Record<string, string> = {}
  for (const entry of values.get("--env") ?? []) {
    const [name, value] = splitOnce(entry, "=")
    const resolved = value ?? processEnv?.[name]
    if (resolved !== undefined) env[name] = resolved
  }
  const portBindings: PortBindings = {}
  for (const publish of values.get("--publish") ?? []) {
    const parts = publish.split(":")
    const containerPort = parts.at(-1) ?? ""
    const hostPort = parts.at(-2) ?? ""
    const hostIp = parts.length === 3 ? (parts[0] ?? "") : ""
    const key = containerPort.includes("/")
      ? containerPort
      : `${containerPort}/tcp`
    portBindings[key] = [
      ...(portBindings[key] ?? []),
      { HostIp: hostIp, HostPort: hostPort },
    ]
  }
  const memory = values.get("--memory")?.[0]
  return {
    aliases: values.get("--network-alias") ?? [],
    cmd: [
      ...(values.get("--entrypoint") ?? []),
      ...arguments_.slice(index + 1),
    ].slice(values.has("--entrypoint") ? 1 : 0),
    env,
    flags,
    healthCheck: values.has("--health-cmd"),
    image,
    ip: values.get("--ip")?.[0] ?? "",
    labels: labelsFrom(values.get("--label") ?? []),
    memoryBytes: memory ? memoryBytes(memory) : 0,
    mounts: [
      ...(values.get("--volume") ?? []).map((volume) => parseVolume(volume)),
      ...(values.get("--mount") ?? []).map((mount) => {
        const options = Object.fromEntries(
          mount.split(",").map((part) => splitOnce(part, "="))
        ) as Record<string, string>
        return {
          destination: options.target ?? options.destination ?? "",
          readOnly: Object.hasOwn(options, "readonly"),
          source: options.source ?? "",
          type:
            options.type === "volume" ? ("volume" as const) : ("bind" as const),
        }
      }),
    ],
    name: values.get("--name")?.[0],
    network: values.get("--network")?.[0],
    portBindings,
    restartPolicy: values.get("--restart")?.[0] ?? "no",
  }
}

function parseFlags(
  arguments_: ReadonlyArray<string>,
  valueFlags: ReadonlyArray<string>
): {
  flags: Set<string>
  positional: Array<string>
  values: Map<string, Array<string>>
} {
  const flags = new Set<string>()
  const positional: Array<string> = []
  const values = new Map<string, Array<string>>()
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? ""
    const [flag, inline] = splitOnce(argument, "=")
    if (argument.startsWith("-") && valueFlags.includes(flag)) {
      const value = inline ?? arguments_[(index += 1)] ?? ""
      values.set(flag, [...(values.get(flag) ?? []), value])
    } else if (argument.startsWith("-")) {
      flags.add(argument)
    } else {
      positional.push(argument)
    }
  }
  return { flags, positional, values }
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

function labelsFrom(entries: ReadonlyArray<string>): Record<string, string> {
  return Object.fromEntries(
    entries.map((entry) => {
      const [name, value = ""] = splitOnce(entry, "=")
      return [name, value]
    })
  )
}

function memoryBytes(value: string): number {
  const match = /^(\d+)([bkmgt]?)$/iu.exec(value)
  if (!match) return 0
  const exponent = "bkmgt".indexOf((match[2] || "b").toLowerCase())
  return Number(match[1]) * 1024 ** exponent
}

/** `host`, `none`, `bridge`, and `container:<name>` are modes, not networks. */
function isNetworkMode(network: string): boolean {
  return (
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
