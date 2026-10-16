/**
 * Containers Relay creates, in Relay's own terms, and the
 * `POST /containers/create` body for each. What a spec leaves unset is left
 * out of the body, for Docker's defaults.
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
  readonly aliases?: ReadonlyArray<string>
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
  /** Run with the image's shell. */
  readonly command: string
  readonly intervalMs: number
  readonly timeoutMs: number
  readonly startPeriodMs: number
  readonly retries: number
}

export interface ContainerSpec {
  readonly name: string
  readonly image: string
  /** Arguments after the entrypoint. */
  readonly command?: ReadonlyArray<string>
  readonly entrypoint?: string
  readonly hostname?: string
  readonly user?: string
  readonly workdir?: string
  readonly stopSignal?: string
  readonly env?: Readonly<Record<string, string>>
  readonly labels?: Readonly<Record<string, string>>
  /**
   * A network to join, with its aliases and address, or `host`, `none`, or
   * `container:<name>` instead.
   */
  readonly network?: ContainerNetwork | "host" | "none" | `container:${string}`
  readonly restart?: string
  readonly ports?: ReadonlyArray<ContainerPort>
  /** As `source:target[:options]`. */
  readonly binds?: ReadonlyArray<string>
  readonly mounts?: ReadonlyArray<ContainerMount>
  /** Options by path, such as `rw,size=128m`. */
  readonly tmpfs?: Readonly<Record<string, string>>
  /** As Docker stores them, such as `CAP_NET_ADMIN`, or `ALL`. */
  readonly capAdd?: ReadonlyArray<string>
  readonly capDrop?: ReadonlyArray<string>
  readonly securityOpt?: ReadonlyArray<string>
  /** Host devices, each at the same path in the container. */
  readonly devices?: ReadonlyArray<string>
  readonly sysctls?: Readonly<Record<string, string>>
  readonly pidsLimit?: number
  /** Sizes in Docker's notation, such as `64m`, which recipes use. */
  readonly memory?: string
  readonly memoryReservation?: string
  readonly memorySwap?: string
  readonly readOnly?: boolean
  /** Keeps stdin open for the first attach: consoles and one-off runs. */
  readonly interactive?: boolean
  readonly tty?: boolean
  readonly healthcheck?: ContainerHealthcheck | "none"
  readonly volumesFrom?: ReadonlyArray<string>
  /** Docker removes the container once it exits. */
  readonly autoRemove?: boolean
}

function containerCreateBody(spec: ContainerSpec): unknown {
  const network = spec.network
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
  const healthcheck = spec.healthcheck
  return {
    Image: spec.image,
    Labels: { ...spec.labels },
    ...(spec.command?.length && { Cmd: [...spec.command] }),
    ...(spec.entrypoint !== undefined && { Entrypoint: [spec.entrypoint] }),
    ...(spec.env && {
      Env: Object.entries(spec.env).map(([name, value]) => `${name}=${value}`),
    }),
    ...(spec.ports?.length && { ExposedPorts: exposed }),
    ...(healthcheck && {
      Healthcheck:
        healthcheck === "none"
          ? { Test: ["NONE"] }
          : {
              Interval: healthcheck.intervalMs * 1e6,
              Retries: healthcheck.retries,
              StartPeriod: healthcheck.startPeriodMs * 1e6,
              Test: ["CMD-SHELL", healthcheck.command],
              Timeout: healthcheck.timeoutMs * 1e6,
            },
    }),
    ...(spec.hostname && { Hostname: spec.hostname }),
    ...(spec.interactive && {
      AttachStdin: true,
      OpenStdin: true,
      StdinOnce: true,
    }),
    ...(spec.stopSignal && { StopSignal: spec.stopSignal }),
    ...(spec.tty && { Tty: true }),
    ...(spec.user && { User: spec.user }),
    ...(spec.workdir && { WorkingDir: spec.workdir }),
    HostConfig: {
      ...(spec.autoRemove && { AutoRemove: true }),
      ...(spec.binds?.length && { Binds: [...spec.binds] }),
      ...(spec.capAdd?.length && { CapAdd: [...spec.capAdd] }),
      ...(spec.capDrop?.length && { CapDrop: [...spec.capDrop] }),
      ...(spec.devices?.length && {
        Devices: spec.devices.map((path) => ({
          CgroupPermissions: "rwm",
          PathInContainer: path,
          PathOnHost: path,
        })),
      }),
      ...(spec.memory && { Memory: ramInBytes(spec.memory) }),
      ...(spec.memoryReservation && {
        MemoryReservation: ramInBytes(spec.memoryReservation),
      }),
      ...(spec.memorySwap && { MemorySwap: ramInBytes(spec.memorySwap) }),
      ...(spec.mounts?.length && {
        Mounts: spec.mounts.map((mount) => ({
          ReadOnly: mount.readOnly ?? false,
          Source: mount.source,
          Target: mount.target,
          Type: mount.type,
        })),
      }),
      ...(network && {
        NetworkMode: typeof network === "string" ? network : network.name,
      }),
      ...(spec.pidsLimit && { PidsLimit: spec.pidsLimit }),
      ...(spec.ports?.length && { PortBindings: bindings }),
      ...(spec.readOnly && { ReadonlyRootfs: true }),
      ...(spec.restart && { RestartPolicy: { Name: spec.restart } }),
      ...(spec.securityOpt?.length && { SecurityOpt: [...spec.securityOpt] }),
      ...(spec.sysctls && { Sysctls: { ...spec.sysctls } }),
      ...(spec.tmpfs && { Tmpfs: { ...spec.tmpfs } }),
      ...(spec.volumesFrom?.length && { VolumesFrom: [...spec.volumesFrom] }),
    },
    ...(typeof network === "object" && {
      NetworkingConfig: {
        EndpointsConfig: {
          [network.name]: {
            ...(network.aliases?.length && { Aliases: [...network.aliases] }),
            ...(network.ipv4Address && {
              IPAMConfig: { IPv4Address: network.ipv4Address },
            }),
          },
        },
      },
    }),
  }
}

/**
 * Creates the container, pulling its image first when Docker doesn't have
 * it.
 */
export function createContainer(
  engine: DockerEngine,
  spec: ContainerSpec,
  options: { readonly pullTimeout?: number } = {}
): Effect.Effect<{ readonly Id: string }, DockerEngineError> {
  // An invalid size fails the create instead of throwing past the caller's
  // cleanup.
  const body = Effect.try({
    try: () => containerCreateBody(spec),
    catch: (cause) =>
      new DockerEngineError({
        cause,
        operation: "POST /containers/create",
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  })
  return body.pipe(
    Effect.flatMap((created) => {
      const create = engine.createContainer(spec.name, created)
      return create.pipe(
        Effect.catchIf(
          (cause) =>
            isDockerNotFound(cause) && /no such image/iu.test(cause.reason),
          () =>
            engine
              .pullImage(spec.image, { timeout: options.pullTimeout })
              .pipe(Effect.andThen(create))
        )
      )
    })
  )
}

/** Creates and starts the container. */
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
 * Runs a one-off container to completion with `input` on its
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
      // Waiting starts first, so a fast exit isn't missed.
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
 * A size in Docker's notation (go-units `RAMInBytes`): a number with an
 * optional binary unit, `b`, `k`, `m`, `g`, `t`, or `p`, case-insensitive,
 * optionally followed by `b` or `ib`.
 */
function ramInBytes(value: string): number {
  const match = /^(\d+(?:\.\d+)?) ?([kmgtp])?(?:i?b)?$/iu.exec(value.trim())
  const amount = Number(match?.[1])
  if (!match || !Number.isFinite(amount)) {
    throw new Error(`invalid size: '${value}'`)
  }
  const exponent = "kmgtp".indexOf((match[2] ?? "").toLowerCase()) + 1
  return Math.trunc(amount * 1024 ** exponent)
}
