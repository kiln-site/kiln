/**
 * A stateful, in-memory Docker for Relay tests.
 *
 * Relay drives Docker through the CLI (`./command.js`) and, for a few calls,
 * the Engine API on `config.dockerSocket`. Tests replace both at that single
 * boundary:
 *
 *   vi.mock("./command.js", () => import("./test/docker.js"))
 *   config.dockerSocket = await fakeDocker.listen()
 *
 * Commands mutate containers, networks, volumes, and images the way Docker
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

class DockerFailure extends Error {}

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
  #idleWaiters: Array<() => void> = []
  #lastTimestamp = 0
  #socketPath: string | null = null
  readonly #execSockets = new Map<string, Duplex>()

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
   * Resolves once no Docker command is running, for work Relay starts in the
   * background (recovery restarts, compensating stops).
   */
  idle(): Promise<void> {
    return this.#inFlight === 0
      ? Promise.resolve()
      : new Promise((resolve) => this.#idleWaiters.push(resolve))
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
    this.#inFlight += 1
    try {
      const stdout = await this.#dispatch([...arguments_], options, input)
      return { stderr: "", stdout }
    } catch (cause) {
      if (cause instanceof DockerFailure) {
        throw new Error(
          `Command failed: ${commandLine}\nError response from daemon: ${cause.message}\n`
        )
      }
      throw cause
    } finally {
      this.#inFlight -= 1
      if (this.#inFlight === 0) {
        // Let callers observe the result before waiters resume.
        setImmediate(() => {
          if (this.#inFlight > 0) return
          for (const resolve of this.#idleWaiters.splice(0)) resolve()
        })
      }
    }
  }

  async #dispatch(
    arguments_: Array<string>,
    options: CommandOptions,
    input: string | undefined
  ): Promise<string> {
    const [first = "", second = ""] = arguments_
    const rest = arguments_.slice(1)
    if (first === "container" && (second === "ls" || second === "list")) {
      return this.#list(arguments_.slice(2))
    }
    if (first === "ps") return this.#list(rest)
    if (first === "container" && second === "inspect") {
      return this.#inspect(arguments_.slice(2), "container")
    }
    if (first === "container" && second === "create") {
      return this.#create(arguments_.slice(2), options, false, input)
    }
    if (first === "create") return this.#create(rest, options, false, input)
    if (first === "run") return this.#create(rest, options, true, input)
    if (first === "inspect") return this.#inspect(rest, "any")
    if (first === "network") return this.#networkCommand(rest)
    if (first === "volume") return this.#volumeCommand(rest)
    if (first === "image" && second === "inspect") {
      return this.#inspect(arguments_.slice(2), "image")
    }
    switch (first) {
      case "start":
        return this.#power("start", rest)
      case "stop":
        return this.#power("stop", rest)
      case "restart":
        return this.#power("restart", rest)
      case "kill":
        return this.#power("kill", rest)
      case "rm":
        return this.#remove(rest)
      case "rename":
        return this.#rename(rest)
      case "update":
        return this.#update(rest)
      case "logs":
        return this.#logs(rest)
      case "exec":
        return this.#exec(rest)
      case "pull":
        return this.#pull(rest)
      case "version":
        return "27.3.1\n"
    }
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

  #list(arguments_: Array<string>): string {
    const { flags, values } = parseFlags(arguments_, ["--filter", "--format"])
    const all = flags.has("--all") || flags.has("-a")
    const format = values.get("--format")?.[0] ?? "{{.ID}}"
    const filters = values.get("--filter") ?? []
    return [...this.containers.values()]
      .filter((container) => all || container.state.running)
      .filter((container) =>
        filters.every((filter) => this.#matchesFilter(container, filter))
      )
      .map(
        (container) =>
          `${renderTemplate(format, {
            ID: container.id.slice(0, 12),
            Image: container.image,
            Names: container.name,
            Ports: portsSummary(container),
          })}\n`
      )
      .join("")
  }

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

  #inspect(
    arguments_: Array<string>,
    kind: "any" | "container" | "image"
  ): string {
    const { positional, values } = parseFlags(arguments_, ["--format"])
    const format = values.get("--format")?.[0]
    const found: Array<unknown> = []
    const missing: Array<string> = []
    for (const target of positional) {
      const object =
        kind === "image"
          ? this.#imageObject(target)
          : this.#containerObject(target)
      if (object) found.push(object)
      else missing.push(target)
    }
    if (missing.length > 0 && found.length === 0) {
      throw new DockerFailure(`No such object: ${missing.join(", ")}`)
    }
    return format
      ? found.map((object) => `${renderTemplate(format, object)}\n`).join("")
      : `${JSON.stringify(found, null, 2)}\n`
  }

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

  #networkObject(network: FakeNetwork): unknown {
    return {
      Containers: Object.fromEntries(
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

  async #power(
    action: "kill" | "restart" | "start" | "stop",
    arguments_: Array<string>
  ): Promise<string> {
    const { positional } = parseFlags(arguments_, ["--time"])
    for (const reference of positional) {
      await this.#checkpoint(action, reference)
      const container = this.#requiredContainer(reference)
      if (action === "start") {
        if (!container.state.running) this.#start(container)
      } else if (action === "stop") {
        if (container.state.running) this.#stop(container, 0)
      } else if (action === "kill") {
        if (!container.state.running) {
          throw new DockerFailure(`container ${reference} is not running`)
        }
        this.#stop(container, 137)
      } else {
        if (container.state.running) this.#stop(container, 0)
        this.#start(container)
      }
    }
    return `${positional.join("\n")}\n`
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

  // A container's execs end with it.
  #endExecs(container: FakeContainer): void {
    for (const exec of this.execs.values()) {
      if (exec.running && exec.containerId === container.id) {
        this.exitExec(exec.id)
      }
    }
  }

  async #remove(arguments_: Array<string>): Promise<string> {
    const { flags, positional } = parseFlags(arguments_, [])
    const force = flags.has("--force") || flags.has("-f")
    for (const reference of positional) {
      await this.#checkpoint("rm", reference)
      const container = this.#requiredContainer(reference)
      if (container.state.running && !force) {
        throw new DockerFailure(
          `cannot remove container "/${container.name}": container is running`
        )
      }
      this.containers.delete(container.id)
    }
    return `${positional.join("\n")}\n`
  }

  async #rename(arguments_: Array<string>): Promise<string> {
    const [from = "", to = ""] = arguments_
    await this.#checkpoint("rename", from)
    const container = this.#requiredContainer(from)
    if (this.container(to)) {
      throw new DockerFailure(
        `Conflict. The container name "/${to}" is already in use`
      )
    }
    container.name = to
    return ""
  }

  async #update(arguments_: Array<string>): Promise<string> {
    const { positional, values } = parseFlags(arguments_, ["--restart"])
    const [reference = ""] = positional
    await this.#checkpoint("update", reference)
    const container = this.#requiredContainer(reference)
    const restart = values.get("--restart")?.[0]
    if (restart === undefined) {
      return this.#unsupported(`docker update ${arguments_.join(" ")}`)
    }
    container.restartPolicy = restart
    return `${reference}\n`
  }

  // ---------------------------------------------------------- logs and exec

  #logs(arguments_: Array<string>): string {
    const { positional, values } = parseFlags(arguments_, [
      "--since",
      "--tail",
      "--until",
    ])
    const container = this.#requiredContainer(positional[0] ?? "")
    const since = values.get("--since")?.[0]
    const until = values.get("--until")?.[0]
    const tail = values.get("--tail")?.[0]
    const lines = container.logs.filter(
      ({ time }) =>
        (since === undefined || Date.parse(time) >= Date.parse(since)) &&
        (until === undefined || Date.parse(time) < Date.parse(until))
    )
    const selected =
      tail === undefined || tail === "all" ? lines : lines.slice(-Number(tail))
    return selected.map(({ text, time }) => `${time} ${text}\n`).join("")
  }

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
      throw new DockerFailure(`container ${reference} is not running`)
    }
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
    if (subcommand === "inspect") {
      const { positional, values } = parseFlags(rest, ["--format"])
      const format = values.get("--format")?.[0]
      for (const reference of positional) {
        await this.#checkpoint("network inspect", reference)
      }
      const found = positional.flatMap((reference) => {
        const network = this.network(reference)
        return network ? [this.#networkObject(network)] : []
      })
      if (found.length === 0) {
        throw new DockerFailure(`network ${positional.join(" ")} not found`)
      }
      return format
        ? found.map((object) => `${renderTemplate(format, object)}\n`).join("")
        : `${JSON.stringify(found, null, 2)}\n`
    }
    if (subcommand === "ls") {
      await this.#checkpoint("network ls")
      const { values } = parseFlags(rest, ["--filter", "--format"])
      const filters = values.get("--filter") ?? []
      return [...this.networks.values()]
        .filter((network) =>
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
        .map((network) => `${network.id.slice(0, 12)}\n`)
        .join("")
    }
    if (subcommand === "create") {
      const { flags, positional, values } = parseFlags(rest, [
        "--driver",
        "--label",
        "--subnet",
      ])
      const [name = ""] = positional
      await this.#checkpoint("network create", name)
      if (this.networks.has(name)) {
        throw new DockerFailure(`network with name ${name} already exists`)
      }
      const network = this.addNetwork({
        internal: flags.has("--internal"),
        labels: labelsFrom(values.get("--label") ?? []),
        name,
        subnet: values.get("--subnet")?.[0],
      })
      return `${network.id}\n`
    }
    if (subcommand === "connect") {
      const { positional, values } = parseFlags(rest, ["--alias", "--ip"])
      const [networkName = "", containerName = ""] = positional
      await this.#checkpoint("network connect", networkName)
      const network = this.network(networkName)
      if (!network) throw new DockerFailure(`network ${networkName} not found`)
      const container = this.#requiredContainer(containerName)
      if (container.networks.has(network.name)) {
        throw new DockerFailure(
          `endpoint with name ${container.name} already exists in network ${network.name}`
        )
      }
      container.networks.set(network.name, {
        aliases: [...(values.get("--alias") ?? []), container.name],
        ipAddress: values.get("--ip")?.[0] ?? "",
      })
      return ""
    }
    if (subcommand === "disconnect") {
      const { positional } = parseFlags(rest, [])
      const [networkName = "", containerName = ""] = positional
      await this.#checkpoint("network disconnect", networkName)
      const network = this.network(networkName)
      if (!network) throw new DockerFailure(`network ${networkName} not found`)
      const container = this.#requiredContainer(containerName)
      if (!container.networks.delete(network.name)) {
        throw new DockerFailure(
          `container ${container.name} is not connected to network ${network.name}`
        )
      }
      return ""
    }
    if (subcommand === "rm") {
      for (const reference of rest) {
        await this.#checkpoint("network rm", reference)
        const network = this.network(reference)
        if (!network) throw new DockerFailure(`network ${reference} not found`)
        const attached = [...this.containers.values()].filter((container) =>
          container.networks.has(network.name)
        )
        if (attached.length > 0) {
          throw new DockerFailure(
            `error while removing network: network ${network.name} has active endpoints (${attached.map(({ name }) => name).join(", ")})`
          )
        }
        this.networks.delete(network.name)
      }
      return ""
    }
    return this.#unsupported(`docker network ${arguments_.join(" ")}`)
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
    if (subcommand === "inspect") {
      const { positional, values } = parseFlags(rest, ["--format"])
      const format = values.get("--format")?.[0]
      const found = positional.flatMap((name) => {
        const volume = this.volumes.get(name)
        return volume
          ? [{ Driver: "local", Labels: volume.labels, Name: volume.name }]
          : []
      })
      if (found.length === 0) {
        throw new DockerFailure(`get ${positional.join(" ")}: no such volume`)
      }
      return format
        ? found.map((object) => `${renderTemplate(format, object)}\n`).join("")
        : `${JSON.stringify(found, null, 2)}\n`
    }
    if (subcommand === "rm") {
      for (const name of rest) {
        await this.#checkpoint("volume rm", name)
        if (!this.volumes.has(name)) {
          throw new DockerFailure(`get ${name}: no such volume`)
        }
        const user = [...this.containers.values()].find((container) =>
          container.mounts.some(
            (mount) => mount.type === "volume" && mount.source === name
          )
        )
        if (user) {
          throw new DockerFailure(
            `remove ${name}: volume is in use - [${user.id}]`
          )
        }
        this.volumes.delete(name)
      }
      return ""
    }
    return this.#unsupported(`docker volume ${arguments_.join(" ")}`)
  }

  // ------------------------------------------------------------- Engine API

  async #api(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://docker")
    const body = await readBody(request)
    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" })
      response.end(JSON.stringify(payload))
    }
    const match = /^\/containers\/([^/]+)\/(resize|stats)$/u.exec(url.pathname)
    const execCreate = /^\/containers\/([^/]+)\/exec$/u.exec(url.pathname)
    if (request.method === "POST" && execCreate) {
      const target = this.container(decodeURIComponent(execCreate[1] ?? ""))
      if (!target?.state.running) {
        send(target ? 409 : 404, { message: "Container is not running" })
        return
      }
      const input = JSON.parse(body) as {
        Cmd?: Array<string>
        Env?: Array<string>
        Tty?: boolean
      }
      const exec: FakeExec = {
        cmd: input.Cmd ?? [],
        containerId: target.id,
        env: Object.fromEntries(
          (input.Env ?? []).map(
            (entry) => splitOnce(entry, "=") as [string, string]
          )
        ),
        id: randomBytes(32).toString("hex"),
        running: false,
        size: null,
        tty: input.Tty ?? false,
      }
      this.execs.set(exec.id, exec)
      send(201, { Id: exec.id })
      return
    }
    const execStart = /^\/exec\/([^/]+)\/start$/u.exec(url.pathname)
    if (request.method === "POST" && execStart) {
      const exec = this.execs.get(decodeURIComponent(execStart[1] ?? ""))
      if (!exec) {
        send(404, { message: "No such exec instance" })
        return
      }
      this.#runDetachedExec(exec)
      send(200, {})
      return
    }
    const execResize = /^\/exec\/([^/]+)\/resize$/u.exec(url.pathname)
    if (request.method === "POST" && execResize) {
      const exec = this.execs.get(decodeURIComponent(execResize[1] ?? ""))
      if (!exec?.running) {
        send(404, { message: "No such exec instance" })
        return
      }
      exec.size = {
        cols: Number(url.searchParams.get("w")),
        rows: Number(url.searchParams.get("h")),
      }
      send(200, {})
      return
    }
    if (request.method === "POST" && url.pathname === "/containers/create") {
      try {
        const name = url.searchParams.get("name") ?? undefined
        await this.#checkpoint("create", name)
        const container = this.#createFromApi(name, JSON.parse(body))
        send(201, { Id: container.id, Warnings: [] })
      } catch (cause) {
        send(cause instanceof DockerFailure ? 409 : 500, {
          message: cause instanceof Error ? cause.message : String(cause),
        })
      }
      return
    }
    const inspect = /^\/containers\/([^/]+)\/json$/u.exec(url.pathname)
    if (request.method === "GET" && inspect) {
      const target = this.container(decodeURIComponent(inspect[1] ?? ""))
      if (!target) {
        send(404, { message: `No such container: ${inspect[1]}` })
        return
      }
      await this.#checkpoint("inspect", target.name)
      send(200, {
        Id: target.id,
        Name: `/${target.name}`,
        State: {
          ExitCode: target.state.exitCode,
          Running: target.state.running,
          StartedAt: target.state.startedAt,
        },
      })
      return
    }
    const container = match
      ? this.container(decodeURIComponent(match[1] ?? ""))
      : undefined
    if (!container) {
      send(404, { message: `No such container: ${url.pathname}` })
      return
    }
    if (match?.[2] === "resize") {
      send(200, {})
      return
    }
    send(200, {
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
    if (!container) throw new DockerFailure(`No such container: ${reference}`)
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

function portsSummary(container: FakeContainer): string {
  if (!container.state.running) return ""
  return Object.entries(container.portBindings)
    .flatMap(([port, hosts]) =>
      hosts.flatMap((host) =>
        host.HostIp
          ? [`${host.HostIp}:${host.HostPort}->${port}`]
          : [
              `0.0.0.0:${host.HostPort}->${port}`,
              `[::]:${host.HostPort}->${port}`,
            ]
      )
    )
    .join(", ")
}

/**
 * The subset of Go templates Relay passes to `--format`: field paths,
 * `json`, `index`, and `range … println … end`.
 */
function renderTemplate(template: string, root: unknown): string {
  const withRanges = template.replace(
    /\{\{\s*range\s+(\.[\w.]*)\s*\}\}(.*?)\{\{\s*end\s*\}\}/gu,
    (_match, path: string, body: string) => {
      const value = lookup(root, path)
      const items =
        value && typeof value === "object" ? Object.values(value) : []
      return items
        .map((item) =>
          body.replace(
            /\{\{\s*println\s+(\.[\w.]*)\s*\}\}/gu,
            (_inner, itemPath: string) =>
              `${goString(lookup(item, itemPath))}\n`
          )
        )
        .join("")
    }
  )
  return withRanges.replace(
    /\{\{\s*(?:(json)\s+(\.[\w.]*)|index\s+(\.[\w.]*)\s+"([^"]*)"|(\.[\w.]*))\s*\}\}/gu,
    (
      _match,
      json: string | undefined,
      jsonPath: string | undefined,
      indexPath: string | undefined,
      key: string | undefined,
      path: string | undefined
    ) => {
      if (json && jsonPath)
        return JSON.stringify(lookup(root, jsonPath) ?? null)
      if (indexPath && key !== undefined) {
        const map = lookup(root, indexPath) as
          | Record<string, unknown>
          | undefined
        return map && Object.hasOwn(map, key)
          ? goString(map[key])
          : "<no value>"
      }
      return goString(lookup(root, path ?? "."))
    }
  )
}

function lookup(root: unknown, path: string): unknown {
  return path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>(
      (value, key) =>
        value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined,
      root
    )
}

function goString(value: unknown): string {
  if (value === undefined || value === null) return "<no value>"
  return typeof value === "object" ? JSON.stringify(value) : String(value)
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

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", reject)
  })
}
