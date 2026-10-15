/**
 * Containers Relay creates, described by the `docker create` flags it used to
 * pass, and turned into the same `POST /containers/create` body the CLI sent
 * for them. Container config and labels are a format other Kiln versions
 * read, so the body keeps the CLI's field values and defaults exactly.
 */
import { Effect, Fiber } from "effect"

import {
  completeWithInput,
  type DockerEngine,
  DockerEngineError,
  DockerExecProcess,
  type DockerOutput,
  isDockerNotFound,
} from "./docker-engine.js"

export interface ContainerNetwork {
  readonly name: string
  /** `--network-alias`. */
  readonly aliases?: ReadonlyArray<string>
  /** `--ip`. */
  readonly ipv4Address?: string
}

export interface ContainerPort {
  readonly containerPort: number
  readonly hostPort: number | string
  readonly protocol: "tcp" | "udp"
  readonly hostIp?: string
}

export interface ContainerMount {
  readonly type: "bind" | "volume"
  readonly source: string
  readonly target: string
  readonly readOnly?: boolean
}

export interface ContainerHealthcheck {
  /** `--health-cmd`, run with the image's shell. */
  readonly command: string
  /** Durations as the CLI takes them, such as `5s`. */
  readonly interval?: string
  readonly timeout?: string
  readonly startPeriod?: string
  readonly retries?: number
}

export interface ContainerSpec {
  readonly name: string
  readonly image: string
  /** Arguments after the image. */
  readonly command?: ReadonlyArray<string>
  /** `--entrypoint`. */
  readonly entrypoint?: string
  readonly hostname?: string
  readonly user?: string
  readonly workdir?: string
  readonly stopSignal?: string
  /** `--env`, in order. */
  readonly env?: Readonly<Record<string, string>>
  readonly labels?: Readonly<Record<string, string>>
  /**
   * `--network` with its aliases and address; the container joins the
   * first. `host`, `none`, or `container:<name>` instead of a network.
   */
  readonly network?: ContainerNetwork | "host" | "none" | `container:${string}`
  readonly restart?: string
  readonly ports?: ReadonlyArray<ContainerPort>
  /** `--volume` strings, as `source:target[:options]`. */
  readonly binds?: ReadonlyArray<string>
  /** `--mount`. */
  readonly mounts?: ReadonlyArray<ContainerMount>
  /** `--tmpfs`, by path, with its options. */
  readonly tmpfs?: Readonly<Record<string, string>>
  readonly capAdd?: ReadonlyArray<string>
  readonly capDrop?: ReadonlyArray<string>
  readonly securityOpt?: ReadonlyArray<string>
  /** `--device` strings, as `host[:container[:permissions]]`. */
  readonly devices?: ReadonlyArray<string>
  readonly sysctls?: Readonly<Record<string, string>>
  readonly pidsLimit?: number
  /** Sizes as the CLI takes them, such as `64m` or `1.5g`. */
  readonly memory?: string
  readonly memoryReservation?: string
  readonly memorySwap?: string
  readonly readOnly?: boolean
  /** `--interactive`. */
  readonly interactive?: boolean
  readonly tty?: boolean
  readonly healthcheck?: ContainerHealthcheck | "none"
  readonly volumesFrom?: ReadonlyArray<string>
  /** `--rm`. */
  readonly autoRemove?: boolean
}

/** The body `docker create` sends for `spec`. */
export function containerCreateBody(spec: ContainerSpec): unknown {
  const network = spec.network ?? "default"
  const mode = typeof network === "string" ? network : network.name
  const endpoint = {
    Aliases:
      typeof network !== "string" && network.aliases?.length
        ? [...network.aliases]
        : null,
    DriverOpts: null,
    IPAMConfig:
      typeof network !== "string" && network.ipv4Address
        ? { IPv4Address: network.ipv4Address }
        : null,
    Links: null,
  }
  const exposed: Record<string, object> = {}
  const bindings: Record<string, Array<{ HostIp: string; HostPort: string }>> =
    {}
  for (const port of spec.ports ?? []) {
    const key = `${port.containerPort}/${port.protocol}`
    exposed[key] = {}
    bindings[key] = [
      ...(bindings[key] ?? []),
      { HostIp: port.hostIp ?? "", HostPort: String(port.hostPort) },
    ]
  }
  const env = Object.entries(spec.env ?? {}).map(
    ([name, value]) => `${name}=${value}`
  )
  const memory = (value: string | undefined) =>
    value === undefined ? 0 : ramInBytes(value)
  return {
    AttachStderr: true,
    AttachStdin: spec.interactive ?? false,
    AttachStdout: true,
    Cmd: spec.command?.length ? [...spec.command] : null,
    Domainname: "",
    Entrypoint: spec.entrypoint === undefined ? null : [spec.entrypoint],
    Env: env.length > 0 ? env : null,
    ...(Object.keys(exposed).length > 0 && { ExposedPorts: exposed }),
    ...(spec.healthcheck !== undefined && {
      Healthcheck:
        spec.healthcheck === "none"
          ? { Test: ["NONE"] }
          : {
              Interval: durationNanoseconds(spec.healthcheck.interval),
              Retries: spec.healthcheck.retries ?? 0,
              StartPeriod: durationNanoseconds(spec.healthcheck.startPeriod),
              Test: ["CMD-SHELL", spec.healthcheck.command],
              Timeout: durationNanoseconds(spec.healthcheck.timeout),
            },
    }),
    Hostname: spec.hostname ?? "",
    Image: spec.image,
    Labels: { ...spec.labels },
    OpenStdin: spec.interactive ?? false,
    ...(spec.stopSignal && { StopSignal: spec.stopSignal }),
    // `docker create -i` keeps stdin open for one attach, as `run -i` does.
    StdinOnce: spec.interactive ?? false,
    Tty: spec.tty ?? false,
    User: spec.user ?? "",
    Volumes: {},
    WorkingDir: spec.workdir ?? "",
    HostConfig: {
      AutoRemove: spec.autoRemove ?? false,
      Binds: spec.binds?.length ? [...spec.binds] : null,
      BlkioDeviceReadBps: [],
      BlkioDeviceReadIOps: [],
      BlkioDeviceWriteBps: [],
      BlkioDeviceWriteIOps: [],
      BlkioWeight: 0,
      BlkioWeightDevice: [],
      CapAdd: spec.capAdd?.length ? spec.capAdd.map(capability) : null,
      CapDrop: spec.capDrop?.length ? spec.capDrop.map(capability) : null,
      Cgroup: "",
      CgroupParent: "",
      CgroupnsMode: "",
      ConsoleSize: [0, 0],
      ContainerIDFile: "",
      CpuCount: 0,
      CpuPercent: 0,
      CpuPeriod: 0,
      CpuQuota: 0,
      CpuRealtimePeriod: 0,
      CpuRealtimeRuntime: 0,
      CpuShares: 0,
      CpusetCpus: "",
      CpusetMems: "",
      DeviceCgroupRules: null,
      DeviceRequests: null,
      Devices: (spec.devices ?? []).map(device),
      Dns: null,
      DnsOptions: [],
      DnsSearch: [],
      ExtraHosts: null,
      GroupAdd: null,
      IOMaximumBandwidth: 0,
      IOMaximumIOps: 0,
      IpcMode: "",
      Isolation: "",
      Links: null,
      LogConfig: { Config: {}, Type: "" },
      MaskedPaths: null,
      Memory: memory(spec.memory),
      MemoryReservation: memory(spec.memoryReservation),
      MemorySwap: memory(spec.memorySwap),
      MemorySwappiness: -1,
      ...(spec.mounts?.length && {
        Mounts: spec.mounts.map((mount) => ({
          ...(mount.readOnly && { ReadOnly: true }),
          Source: mount.source,
          Target: mount.target,
          Type: mount.type,
        })),
      }),
      NanoCpus: 0,
      NetworkMode: mode,
      OomKillDisable: false,
      OomScoreAdj: 0,
      PidMode: "",
      PidsLimit: spec.pidsLimit ?? 0,
      PortBindings: bindings,
      Privileged: false,
      PublishAllPorts: false,
      ReadonlyPaths: null,
      ReadonlyRootfs: spec.readOnly ?? false,
      RestartPolicy: { MaximumRetryCount: 0, Name: spec.restart ?? "no" },
      SecurityOpt: spec.securityOpt?.length ? [...spec.securityOpt] : null,
      ShmSize: 0,
      ...(spec.sysctls && { Sysctls: { ...spec.sysctls } }),
      ...(spec.tmpfs && { Tmpfs: { ...spec.tmpfs } }),
      UTSMode: "",
      Ulimits: null,
      UsernsMode: "",
      VolumeDriver: "",
      VolumesFrom: spec.volumesFrom?.length ? [...spec.volumesFrom] : null,
    },
    NetworkingConfig: {
      EndpointsConfig:
        mode === "host" || mode === "none" || mode.startsWith("container:")
          ? {}
          : { [mode]: endpoint },
    },
  }
}

/**
 * `docker create`: creates the container, pulling its image first when
 * Docker doesn't have it, as the CLI's default `--pull missing` did.
 */
export function createContainer(
  engine: DockerEngine,
  spec: ContainerSpec,
  options: { readonly pullTimeout?: number } = {}
): Effect.Effect<{ readonly Id: string }, DockerEngineError> {
  const create = engine.createContainer(spec.name, containerCreateBody(spec))
  return create.pipe(
    Effect.catchIf(
      (cause) => isDockerNotFound(cause) && /no such image/iu.test(cause.reason),
      () =>
        engine
          .pullImage(spec.image, { timeout: options.pullTimeout })
          .pipe(Effect.andThen(create))
    )
  )
}

/** `docker run --detach`: creates and starts the container. */
export function runContainer(
  engine: DockerEngine,
  spec: ContainerSpec,
  options: { readonly pullTimeout?: number; readonly timeout?: number } = {}
): Effect.Effect<{ readonly Id: string }, DockerEngineError> {
  return createContainer(engine, spec, options).pipe(
    Effect.tap((created) =>
      engine.startContainer(created.Id, { timeout: options.timeout })
    )
  )
}

/**
 * `docker run --rm -i`: runs the container to completion with `input` on its
 * stdin and returns its output, failing with its stderr when it exits with a
 * non-zero code. Docker removes the container once it exits; one that fails
 * to start or runs past `timeout` is removed here.
 */
export function runWithInput(
  engine: DockerEngine,
  spec: ContainerSpec,
  input: string,
  options: { readonly maxOutputBytes?: number; readonly timeout: number }
): Effect.Effect<DockerOutput, DockerEngineError> {
  const operation = `run ${spec.image}`
  const run = Effect.gen(function* () {
    const created = yield* createContainer(engine, {
      ...spec,
      autoRemove: true,
      interactive: true,
    })
    return yield* Effect.gen(function* () {
      // Waiting starts first, as the CLI's does, so a fast exit isn't missed.
      const exited = yield* Effect.forkChild(
        engine.waitContainer(created.Id, "removed")
      )
      const socket = yield* engine.attachContainer(created.Id)
      const process = new DockerExecProcess(
        socket,
        true,
        Fiber.join(exited),
        spec.entrypoint ?? spec.command?.[0] ?? spec.image
      )
      yield* engine
        .startContainer(created.Id)
        .pipe(Effect.onError(() => Effect.sync(() => process.kill())))
      return yield* completeWithInput(process, {
        input,
        maxOutputBytes: options.maxOutputBytes ?? 4 * 1024 * 1024,
        operation,
        overflow: `The output of ${spec.image} exceeded its limit`,
      })
    }).pipe(
      Effect.onError(() =>
        engine.removeContainer(created.Id, { force: true }).pipe(Effect.ignore)
      )
    )
  })
  return run.pipe(
    Effect.timeoutOrElse({
      duration: options.timeout,
      orElse: () =>
        Effect.fail(
          new DockerEngineError({
            operation,
            reason: `Docker did not finish ${operation} within ${options.timeout} ms`,
          })
        ),
    })
  )
}

/**
 * Sizes as the CLI parses them (go-units `RAMInBytes`): a number with an
 * optional binary unit, `b`, `k`, `m`, `g`, `t`, or `p`, case-insensitive,
 * optionally followed by `b` or `ib`.
 */
export function ramInBytes(value: string): number {
  const match = /^(\d+(?:\.\d+)*) ?([kmgtp])?(?:i?b)?$/iu.exec(value.trim())
  const amount = Number(match?.[1])
  if (!match || !Number.isFinite(amount)) {
    throw new Error(`invalid size: '${value}'`)
  }
  const exponent = "kmgtp".indexOf((match[2] ?? "").toLowerCase()) + 1
  return Math.trunc(amount * 1024 ** exponent)
}

// Durations as Go's time.ParseDuration reads the CLI's health flags.
function durationNanoseconds(value: string | undefined): number {
  if (value === undefined) return 0
  const units: Record<string, number> = {
    h: 3_600e9,
    m: 60e9,
    ms: 1e6,
    ns: 1,
    s: 1e9,
    us: 1e3,
    µs: 1e3,
  }
  let total = 0
  const pattern = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/gu
  let consumed = 0
  for (const match of value.matchAll(pattern)) {
    if (match.index !== consumed) break
    total += Number(match[1]) * (units[match[2]!] ?? 0)
    consumed += match[0].length
  }
  if (consumed !== value.length || value.length === 0) {
    throw new Error(`invalid duration: ${value}`)
  }
  return Math.round(total)
}

// The CLI adds the CAP_ prefix Docker stores capabilities with; ALL stays.
function capability(name: string): string {
  const upper = name.toUpperCase()
  return upper === "ALL" || upper.startsWith("CAP_") ? upper : `CAP_${upper}`
}

function device(value: string) {
  const [host = "", container = host, permissions = "rwm"] = value.split(":")
  return {
    CgroupPermissions: permissions,
    PathInContainer: container,
    PathOnHost: host,
  }
}
