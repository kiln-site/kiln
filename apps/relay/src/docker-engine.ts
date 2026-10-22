/**
 * Relay's client for the Docker Engine API on its Docker socket.
 *
 * Each `docker` CLI call starts a Go process that, in turn, makes these same
 * requests; Relay's snapshot loop alone made two of them every two seconds.
 * Talking to the socket directly answers the same questions without a process.
 *
 * Paths are unversioned and the client doesn't negotiate a version, so the
 * daemon answers every request in its own current API version.
 *
 * Execs that stream stdio (database clients, backups, terminals) run over
 * connections Docker upgrades, as `docker exec` does.
 *
 * Pulls read registry credentials from the Docker config file (see
 * `./registry-auth.js`).
 *
 * Containers Relay creates are described in its own terms (see
 * `./docker-container-spec.js`).
 *
 * Dockerfile builds and Compose projects run the standalone `docker-buildx`
 * and `docker-compose` binaries instead (see `./apps.js`).
 */
import { Agent, request } from "node:http"
import { type Duplex, PassThrough, Writable } from "node:stream"
import { StringDecoder } from "node:string_decoder"
import { Effect, Predicate, Result } from "effect"

import {
  normalizedReference,
  parseImageReference,
  repositoryName,
} from "./docker-reference.js"
import { DockerEngineError } from "./effect/errors.js"
import { registryAuthHeader } from "./registry-auth.js"

export { DockerEngineError }

// The same defaults `command()` gave each CLI call.
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024
const MAX_ERROR_BYTES = 64 * 1024
// How long an exec that has closed its output may take to report its code.
const EXIT_CODE_WAIT_MS = 10_000
// Longer lines are cut, so one line without an end can't grow without limit.
const MAX_LINE_CHARACTERS = 1024 * 1024

// Reuses connections between requests; idle ones don't keep Relay running.
const agent = new Agent({ keepAlive: true })

export type DockerFilters = Readonly<Record<string, ReadonlyArray<string>>>

export type DockerPortBinding = { HostIp?: string; HostPort?: string }

export interface DockerContainerSummary {
  readonly Id: string
  readonly Image: string
  readonly Labels: Readonly<Record<string, string>> | null
  readonly Names: ReadonlyArray<string>
  readonly Ports: ReadonlyArray<{
    readonly IP?: string
    readonly PrivatePort: number
    readonly PublicPort?: number
    readonly Type: string
  }> | null
  readonly State: string
  readonly Mounts?: ReadonlyArray<DockerMount>
}

/** A container's mount, as both container listing and inspection report it. */
export interface DockerMount {
  readonly Destination: string
  // A volume's name; binds and tmpfs have none.
  readonly Name?: string
  readonly RW: boolean
  readonly Source: string
  readonly Type?: string
}

/** The parts of `GET /containers/{id}/json` Relay reads. */
export interface DockerContainerInspect {
  readonly Config: {
    readonly AttachStdin?: boolean
    readonly AttachStdout?: boolean
    readonly Hostname?: string
    readonly Image: string
    readonly Labels: Readonly<Record<string, string>> | null
    readonly OpenStdin?: boolean
    readonly Tty?: boolean
  }
  readonly HostConfig?: {
    readonly Memory?: number
    readonly NetworkMode?: string
    readonly PortBindings?: Readonly<
      Record<string, ReadonlyArray<DockerPortBinding> | null>
    > | null
    readonly RestartPolicy?: { readonly Name?: string }
  }
  readonly Id: string
  readonly Mounts?: ReadonlyArray<DockerMount>
  readonly Name: string
  readonly NetworkSettings?: {
    readonly Networks?: Readonly<
      Record<
        string,
        {
          readonly Aliases?: ReadonlyArray<string> | null
          readonly IPAddress?: string
        }
      >
    > | null
  }
  readonly State: {
    readonly Error?: string
    readonly ExitCode: number
    readonly FinishedAt: string
    readonly Health?: { readonly Status: string }
    readonly OOMKilled: boolean
    readonly Restarting: boolean
    readonly Running: boolean
    readonly StartedAt: string
    readonly Status: string
  }
}

export interface DockerNetwork {
  readonly Containers?: Readonly<
    Record<string, { readonly IPv4Address?: string; readonly Name: string }>
  > | null
  readonly Id: string
  readonly Labels: Readonly<Record<string, string>> | null
  readonly Name: string
}

export interface DockerVolume {
  readonly CreatedAt?: string
  readonly Labels: Readonly<Record<string, string>> | null
  // The volume's folder on the host, as the daemon sees it.
  readonly Mountpoint?: string
  readonly Name: string
}

export interface DockerVolumeUsage {
  readonly Name: string
  // Size is -1 when Docker can't measure the volume.
  readonly UsageData?: { readonly Size: number } | null
}

export interface DockerImage {
  readonly Config?: {
    readonly Labels?: Readonly<Record<string, string>> | null
  } | null
  readonly Id: string
}

export interface DockerOutput {
  readonly stderr: string
  readonly stdout: string
}

export interface DockerLogOptions {
  /** Whether the container has a TTY, whose output is not multiplexed. */
  readonly tty: boolean
  /** RFC 3339 times, as the CLI's `--since` and `--until` take them. */
  readonly since?: string
  readonly until?: string
  readonly tail?: number
}

interface Exchange {
  readonly method: "DELETE" | "GET" | "POST"
  readonly path: string
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
  /** For the whole exchange; `null` waits as long as the answer lasts. */
  readonly timeout?: number | null
  readonly maxBytes?: number
  /**
   * Receives a successful body as it arrives instead of buffering it. A
   * returned reason fails the exchange, as when Docker reports an error
   * within the stream.
   */
  readonly onData?: (chunk: Buffer) => string | undefined
}

export class DockerEngine {
  constructor(readonly socketPath: string) {}

  version(): Effect.Effect<{ readonly Version: string }, DockerEngineError> {
    return this.#json({ method: "GET", path: "/version" })
  }

  info(options: { readonly timeout?: number } = {}): Effect.Effect<
    {
      readonly OperatingSystem?: string
      readonly SecurityOptions?: ReadonlyArray<string> | null
    },
    DockerEngineError
  > {
    return this.#json({
      method: "GET",
      path: "/info",
      timeout: options.timeout,
    })
  }

  // ------------------------------------------------------------- containers

  listContainers(
    options: { readonly all?: boolean; readonly filters?: DockerFilters } = {}
  ): Effect.Effect<ReadonlyArray<DockerContainerSummary>, DockerEngineError> {
    return this.#json({
      method: "GET",
      path: `/containers/json${query({
        all: options.all,
        filters: options.filters && JSON.stringify(options.filters),
      })}`,
    })
  }

  /** `A` is how the caller reads Docker's answer; nothing checks it. */
  inspectContainer<A = DockerContainerInspect>(
    reference: string,
    options: { readonly timeout?: number } = {}
  ): Effect.Effect<A, DockerEngineError> {
    return this.#json({
      method: "GET",
      path: `/containers/${segment(reference)}/json`,
      timeout: options.timeout,
    })
  }

  /** Inspects each container, in order, dropping ones removed meanwhile. */
  inspectContainers<A = DockerContainerInspect>(
    references: ReadonlyArray<string>
  ): Effect.Effect<Array<A>, DockerEngineError> {
    return Effect.forEach(
      references,
      (reference) =>
        this.inspectContainer<A>(reference).pipe(
          Effect.map((container) => [container]),
          Effect.catchIf(isDockerNotFound, () => Effect.succeed([]))
        ),
      { concurrency: 8 }
    ).pipe(Effect.map((containers) => containers.flat()))
  }

  createContainer(
    name: string,
    body: unknown
  ): Effect.Effect<{ readonly Id: string }, DockerEngineError> {
    return this.#json({
      body,
      method: "POST",
      path: `/containers/create${query({ name: name || undefined })}`,
      timeout: 60_000,
    })
  }

  /**
   * Waits for a container to reach `condition` and returns its exit code, as
   * `docker wait`. The request holds until then, so start it before the
   * container can exit.
   */
  waitContainer(
    reference: string,
    condition: "next-exit" | "not-running" | "removed"
  ): Effect.Effect<number, DockerEngineError> {
    return this.#json<{
      readonly Error?: { readonly Message?: string } | null
      readonly StatusCode: number
    }>({
      method: "POST",
      path: `/containers/${segment(reference)}/wait${query({ condition })}`,
      timeout: null,
    }).pipe(
      Effect.flatMap((answer) =>
        answer.Error?.Message
          ? Effect.fail(
              new DockerEngineError({
                operation: "POST /containers/{id}/wait",
                reason: answer.Error.Message,
              })
            )
          : Effect.succeed(answer.StatusCode)
      )
    )
  }

  /**
   * Attaches to a container's stdio, as `docker attach` (or `docker run`
   * before it starts the container), and returns the raw connection.
   */
  attachContainer(reference: string): Effect.Effect<Duplex, DockerEngineError> {
    return this.hijack(
      `/containers/${segment(reference)}/attach${query({
        stderr: true,
        stdin: true,
        stdout: true,
        stream: true,
      })}`
    )
  }

  /** Succeeds when the container is already running, as `docker start`. */
  startContainer(
    reference: string,
    options: { readonly timeout?: number } = {}
  ): Effect.Effect<void, DockerEngineError> {
    return this.#empty({
      method: "POST",
      path: `/containers/${segment(reference)}/start`,
      timeout: options.timeout,
    })
  }

  /** Succeeds when the container is already stopped, as `docker stop`. */
  stopContainer(
    reference: string,
    options: { readonly seconds?: number; readonly timeout?: number } = {}
  ): Effect.Effect<void, DockerEngineError> {
    return this.#empty({
      method: "POST",
      path: `/containers/${segment(reference)}/stop${query({ t: options.seconds })}`,
      timeout: options.timeout,
    })
  }

  restartContainer(
    reference: string,
    options: { readonly seconds?: number; readonly timeout?: number } = {}
  ): Effect.Effect<void, DockerEngineError> {
    return this.#empty({
      method: "POST",
      path: `/containers/${segment(reference)}/restart${query({ t: options.seconds })}`,
      timeout: options.timeout,
    })
  }

  /** Fails when the container is not running, as `docker kill`. */
  killContainer(
    reference: string,
    options: { readonly timeout?: number } = {}
  ): Effect.Effect<void, DockerEngineError> {
    return this.#empty({
      method: "POST",
      path: `/containers/${segment(reference)}/kill`,
      timeout: options.timeout,
    })
  }

  /**
   * Removes a container. Forced removal of one that no longer exists
   * succeeds, as `docker rm --force` does.
   */
  removeContainer(
    reference: string,
    options: {
      readonly force?: boolean
      readonly timeout?: number
      /** Its anonymous volumes too, as `docker rm --volumes`. */
      readonly volumes?: boolean
    } = {}
  ): Effect.Effect<void, DockerEngineError> {
    const removal = this.#empty({
      method: "DELETE",
      path: `/containers/${segment(reference)}${query({ force: options.force, v: options.volumes })}`,
      timeout: options.timeout,
    })
    return options.force
      ? removal.pipe(Effect.catchIf(isDockerNotFound, () => Effect.void))
      : removal
  }

  renameContainer(
    reference: string,
    name: string
  ): Effect.Effect<void, DockerEngineError> {
    return this.#empty({
      method: "POST",
      path: `/containers/${segment(reference)}/rename${query({ name })}`,
    })
  }

  /** `docker update --restart=<policy>`. */
  setRestartPolicy(
    reference: string,
    policy: string
  ): Effect.Effect<void, DockerEngineError> {
    return this.#empty({
      body: { RestartPolicy: { Name: policy } },
      method: "POST",
      path: `/containers/${segment(reference)}/update`,
    })
  }

  /**
   * `docker update --memory --memory-swap --cpus`, without restarting the
   * container. Docker can't remove a limit this way: 0 leaves it unchanged.
   */
  updateContainerResources(
    reference: string,
    resources: { readonly memoryBytes?: number; readonly nanoCpus?: number }
  ): Effect.Effect<void, DockerEngineError> {
    return this.#empty({
      body: {
        ...(resources.memoryBytes !== undefined && {
          Memory: resources.memoryBytes,
          MemorySwap: resources.memoryBytes,
        }),
        ...(resources.nanoCpus !== undefined && {
          NanoCpus: resources.nanoCpus,
        }),
      },
      method: "POST",
      path: `/containers/${segment(reference)}/update`,
    })
  }

  containerStats(reference: string): Effect.Effect<unknown, DockerEngineError> {
    return this.#json({
      maxBytes: 1024 * 1024,
      method: "GET",
      path: `/containers/${segment(reference)}/stats${query({ stream: false })}`,
      timeout: 2_500,
    })
  }

  resizeContainer(
    reference: string,
    size: { readonly columns: number; readonly rows: number }
  ): Effect.Effect<void, DockerEngineError> {
    return this.#empty({
      method: "POST",
      path: `/containers/${segment(reference)}/resize${query({
        h: size.rows,
        w: size.columns,
      })}`,
      timeout: 5_000,
    })
  }

  /** `docker logs --timestamps`, read whole into stdout and stderr. */
  containerLogs(
    reference: string,
    options: DockerLogOptions & {
      readonly maxBytes?: number
      readonly timeout?: number
    }
  ): Effect.Effect<DockerOutput, DockerEngineError> {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    const output = outputCollector(
      maxBytes,
      `Docker's logs for ${reference} exceeded ${maxBytes} bytes`
    )
    return this.#exchange({
      method: "GET",
      onData: demultiplexer(options.tty, output.add),
      path: logsPath(reference, options, false),
      timeout: options.timeout,
    }).pipe(Effect.map(output.read))
  }

  /**
   * Hands each line of a container's logs to `onLine` as it arrives, so logs
   * of any size are read without holding all of them. With `follow`, lines
   * keep arriving until the container stops or the effect is interrupted.
   */
  containerLogLines(
    reference: string,
    options: DockerLogOptions & {
      readonly follow?: boolean
      readonly timeout?: number | null
    },
    onLine: (line: string) => void
  ): Effect.Effect<void, DockerEngineError> {
    const stdout = lineReader(onLine)
    const stderr = lineReader(onLine)
    return this.#exchange({
      method: "GET",
      onData: demultiplexer(options.tty, (stream, payload) =>
        (stream === "stderr" ? stderr : stdout).read(payload)
      ),
      path: logsPath(reference, options, options.follow ?? false),
      timeout: options.timeout,
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          stdout.flush()
          stderr.flush()
        })
      ),
      Effect.asVoid
    )
  }

  /**
   * Runs a process in a running container and returns its output, failing
   * when it exits with a non-zero code, as `docker exec` (without `-i`).
   */
  exec(
    reference: string,
    command: ReadonlyArray<string>,
    options: { readonly timeout?: number } = {}
  ): Effect.Effect<DockerOutput, DockerEngineError> {
    const operation = `exec ${command[0] ?? ""} in ${reference}`
    const run = Effect.gen({ self: this }, function* () {
      const created = yield* this.createExec(reference, {
        AttachStderr: true,
        AttachStdin: false,
        AttachStdout: true,
        Cmd: command,
        Tty: false,
      })
      const collected = outputCollector(
        DEFAULT_MAX_BYTES,
        `The output of ${command[0] ?? "exec"} exceeded ${DEFAULT_MAX_BYTES} bytes`
      )
      yield* this.#exchange({
        body: { Detach: false, Tty: false },
        method: "POST",
        onData: demultiplexer(false, collected.add),
        path: `/exec/${segment(created.Id)}/start`,
        timeout: null,
      })
      const output = collected.read()
      const exitCode = yield* this.#execExitCode(created.Id)
      if (exitCode !== 0) {
        const detail = output.stderr.trim() || output.stdout.trim()
        return yield* new DockerEngineError({
          operation,
          reason: `${command[0] ?? "exec"} exited with code ${exitCode}${detail ? `: ${detail}` : ""}`,
        })
      }
      return output
    })
    return withTimeout(run, options.timeout ?? DEFAULT_TIMEOUT_MS, operation)
  }

  /** Creates a process to start later; `body` is Docker's exec config. */
  createExec(
    reference: string,
    body: unknown
  ): Effect.Effect<{ readonly Id: string }, DockerEngineError> {
    return this.#json({
      body,
      method: "POST",
      path: `/containers/${segment(reference)}/exec`,
      timeout: 10_000,
    })
  }

  /** Starts a created process without waiting for or reading it. */
  startDetachedExec(id: string): Effect.Effect<void, DockerEngineError> {
    return this.#empty({
      body: { Detach: true },
      method: "POST",
      path: `/exec/${segment(id)}/start`,
      timeout: 10_000,
    })
  }

  /**
   * Starts a process in a running container and streams its stdio, as
   * `docker exec [-i]`: stdout and stderr arrive as they are written, and
   * ending `stdin` closes the process's input. Closing the connection with
   * `kill()` is what stopping the CLI did; the process sees its input and
   * output close.
   */
  execProcess(
    reference: string,
    command: ReadonlyArray<string>,
    options: {
      readonly env?: ReadonlyArray<string>
      /** Attaches stdin, as `-i`. */
      readonly stdin?: boolean
      readonly user?: string
    } = {}
  ): Effect.Effect<DockerExecProcess, DockerEngineError> {
    return Effect.gen({ self: this }, function* () {
      const created = yield* this.createExec(reference, {
        AttachStderr: true,
        AttachStdin: options.stdin ?? false,
        AttachStdout: true,
        Cmd: command,
        ...(options.env?.length && { Env: options.env }),
        Tty: false,
        ...(options.user && { User: options.user }),
      })
      const socket = yield* this.hijack(`/exec/${segment(created.Id)}/start`, {
        Detach: false,
        Tty: false,
      })
      return new DockerExecProcess(
        socket,
        options.stdin ?? false,
        this.#execExitCode(created.Id),
        command[0] ?? "exec"
      )
    })
  }

  /**
   * Runs a process with `input` on its stdin and returns its output, failing
   * with its stderr when it exits with a non-zero code, as
   * `docker exec -i … <<< input`.
   */
  execWithInput(
    reference: string,
    command: ReadonlyArray<string>,
    options: {
      readonly env?: ReadonlyArray<string>
      readonly input?: string | Uint8Array
      readonly maxOutputBytes: number
      /** Why output past `maxOutputBytes` failed. */
      readonly overflow: string
      readonly timeout: number
      readonly user?: string
    }
  ): Effect.Effect<DockerOutput, DockerEngineError> {
    const program = command[0] ?? "exec"
    const operation = `exec ${program} in ${reference}`
    const run = Effect.acquireUseRelease(
      this.execProcess(reference, command, {
        env: options.env,
        stdin: true,
        user: options.user,
      }),
      (process) =>
        completeWithInput(process, {
          input: options.input,
          maxOutputBytes: options.maxOutputBytes,
          operation,
          overflow: options.overflow,
        }),
      (process) => Effect.sync(() => process.kill())
    )
    return withTimeout(run, options.timeout, operation)
  }

  /**
   * Sends `POST path` asking Docker to upgrade the connection, as attach and
   * exec start do, and returns the raw connection once it has.
   */
  hijack(
    path: string,
    body?: unknown,
    options: { readonly timeout?: number } = {}
  ): Effect.Effect<Duplex, DockerEngineError> {
    const operation = `POST ${path.split("?")[0] ?? path}`
    const socketPath = this.socketPath
    return Effect.callback<Duplex, DockerEngineError>((resume) => {
      const encoded =
        body === undefined ? undefined : Buffer.from(JSON.stringify(body))
      const call = request({
        headers: {
          Connection: "Upgrade",
          Upgrade: "tcp",
          ...(encoded && {
            "Content-Length": String(encoded.byteLength),
            "Content-Type": "application/json",
          }),
        },
        method: "POST",
        path,
        socketPath,
      })
      let settled = false
      const fail = (
        reason: string,
        details: { cause?: unknown; status?: number } = {}
      ) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        call.destroy()
        resume(
          Effect.fail(new DockerEngineError({ operation, reason, ...details }))
        )
      }
      const timeout = options.timeout ?? 10_000
      const timer = setTimeout(
        () => fail(`Docker did not start ${operation} within ${timeout} ms`),
        timeout
      )
      call.on("upgrade", (_response, socket, head) => {
        if (settled) {
          socket.destroy()
          return
        }
        settled = true
        clearTimeout(timer)
        // Output that came in the same packet as the upgrade response.
        if (head.length > 0) socket.unshift(head)
        resume(Effect.succeed(socket))
      })
      call.on("response", (response) => {
        const status = response.statusCode ?? 500
        const chunks: Array<Buffer> = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () =>
          fail(
            status >= 400
              ? `Error response from daemon: ${daemonMessage(Buffer.concat(chunks), status)}`
              : `Docker answered ${operation} without upgrading the connection`,
            { status }
          )
        )
      })
      call.on("error", (cause) =>
        fail(transportFailure(cause, socketPath, operation), { cause })
      )
      call.end(encoded)
      return Effect.sync(() => {
        settled = true
        clearTimeout(timer)
        call.destroy()
      })
    })
  }

  resizeExec(
    id: string,
    size: { readonly columns: number; readonly rows: number }
  ): Effect.Effect<void, DockerEngineError> {
    return this.#empty({
      method: "POST",
      path: `/exec/${segment(id)}/resize${query({ h: size.rows, w: size.columns })}`,
      timeout: 10_000,
    })
  }

  // `Pid` stays 0 for an exec Docker couldn't start, such as one whose
  // program the container doesn't have.
  inspectExec(id: string): Effect.Effect<
    {
      readonly ExitCode: number | null
      readonly Pid: number
      readonly Running: boolean
    },
    DockerEngineError
  > {
    return this.#json({
      method: "GET",
      path: `/exec/${segment(id)}/json`,
      timeout: 10_000,
    })
  }

  // The output ends as the process exits; Docker records its code just
  // after, which can take a while on a busy host.
  #execExitCode(id: string): Effect.Effect<number, DockerEngineError> {
    const inspect = this.#json<{
      readonly ExitCode: number | null
      readonly Running: boolean
    }>({ method: "GET", path: `/exec/${segment(id)}/json` })
    return Effect.gen(function* () {
      let waited = 0
      for (let delay = 25; ; delay = Math.min(delay * 2, 500)) {
        const exec = yield* inspect
        if (!exec.Running && exec.ExitCode !== null) return exec.ExitCode
        if (waited >= EXIT_CODE_WAIT_MS) {
          return yield* new DockerEngineError({
            operation: "GET /exec/{id}/json",
            reason: `Docker didn't report the exit code of exec ${id.slice(0, 12)} within ${EXIT_CODE_WAIT_MS} ms`,
          })
        }
        yield* Effect.sleep(delay)
        waited += delay
      }
    })
  }

  // --------------------------------------------------------------- networks

  listNetworks(
    options: { readonly filters?: DockerFilters } = {}
  ): Effect.Effect<ReadonlyArray<DockerNetwork>, DockerEngineError> {
    return this.#json({
      method: "GET",
      path: `/networks${query({
        filters: options.filters && JSON.stringify(options.filters),
      })}`,
    })
  }

  inspectNetwork(
    reference: string
  ): Effect.Effect<DockerNetwork, DockerEngineError> {
    return this.#json({
      method: "GET",
      path: `/networks/${segment(reference)}`,
    })
  }

  /** `docker network connect [--alias …] [--ip …] <network> <container>`. */
  connectNetwork(
    network: string,
    container: string,
    endpoint: {
      readonly aliases?: ReadonlyArray<string>
      readonly ipv4Address?: string
    } = {}
  ): Effect.Effect<void, DockerEngineError> {
    return this.#empty({
      body: {
        Container: container,
        EndpointConfig: {
          ...(endpoint.aliases?.length && { Aliases: endpoint.aliases }),
          ...(endpoint.ipv4Address && {
            IPAMConfig: { IPv4Address: endpoint.ipv4Address },
          }),
        },
      },
      method: "POST",
      path: `/networks/${segment(network)}/connect`,
    })
  }

  disconnectNetwork(
    network: string,
    container: string,
    options: { readonly force?: boolean } = {}
  ): Effect.Effect<void, DockerEngineError> {
    return this.#empty({
      body: { Container: container, Force: options.force ?? false },
      method: "POST",
      path: `/networks/${segment(network)}/disconnect`,
    })
  }

  /** A bridge network. */
  createNetwork(options: {
    readonly name: string
    readonly internal?: boolean
    readonly labels?: Readonly<Record<string, string>>
    readonly subnet?: string
  }): Effect.Effect<{ readonly Id: string }, DockerEngineError> {
    return this.#json({
      body: {
        Internal: options.internal ?? false,
        Labels: { ...options.labels },
        Name: options.name,
        ...(options.subnet && { IPAM: { Config: [{ Subnet: options.subnet }] } }),
      },
      method: "POST",
      path: "/networks/create",
    })
  }

  removeNetwork(reference: string): Effect.Effect<void, DockerEngineError> {
    return this.#empty({
      method: "DELETE",
      path: `/networks/${segment(reference)}`,
    })
  }

  // ------------------------------------------------------- volumes, images

  listVolumes(
    options: { readonly filters?: DockerFilters } = {}
  ): Effect.Effect<ReadonlyArray<DockerVolume>, DockerEngineError> {
    return this.#json<{
      readonly Volumes: ReadonlyArray<DockerVolume> | null
    }>({
      method: "GET",
      path: `/volumes${query({
        filters: options.filters && JSON.stringify(options.filters),
      })}`,
    }).pipe(Effect.map((answer) => answer.Volumes ?? []))
  }

  /**
   * A local volume. Docker answers with the existing volume when one has the
   * name.
   */
  createVolume(options: {
    readonly name: string
    readonly labels?: Readonly<Record<string, string>>
  }): Effect.Effect<DockerVolume, DockerEngineError> {
    return this.#json({
      body: {
        Labels: { ...options.labels },
        Name: options.name,
      },
      method: "POST",
      path: "/volumes/create",
    })
  }

  /**
   * How much each volume holds, as `docker system df -v`. Docker walks every
   * volume to answer, so ask only when someone wants the figure.
   */
  volumeUsage(
    options: { readonly timeout?: number } = {}
  ): Effect.Effect<ReadonlyArray<DockerVolumeUsage>, DockerEngineError> {
    return this.#json<{
      readonly Volumes?: ReadonlyArray<DockerVolumeUsage> | null
    }>({
      method: "GET",
      path: `/system/df${query({ type: "volume" })}`,
      timeout: options.timeout,
    }).pipe(Effect.map((answer) => answer.Volumes ?? []))
  }

  inspectVolume(name: string): Effect.Effect<DockerVolume, DockerEngineError> {
    return this.#json({ method: "GET", path: `/volumes/${segment(name)}` })
  }

  removeVolume(name: string): Effect.Effect<void, DockerEngineError> {
    return this.#empty({ method: "DELETE", path: `/volumes/${segment(name)}` })
  }

  listImages(
    options: { readonly filters?: DockerFilters } = {}
  ): Effect.Effect<ReadonlyArray<{ readonly Id: string }>, DockerEngineError> {
    return this.#json({
      method: "GET",
      path: `/images/json${query({
        filters: options.filters && JSON.stringify(options.filters),
      })}`,
    })
  }

  /**
   * Pulls an image, as `docker pull`, with credentials for its registry from
   * the Docker config file (see `./registry-auth.js`). Each progress
   * message goes to `onLine` the way the CLI printed it without a terminal,
   * ending with the image's full reference.
   */
  pullImage(
    image: string,
    options: {
      readonly onLine?: (line: string) => void
      readonly timeout?: number
    } = {}
  ): Effect.Effect<void, DockerEngineError> {
    return Effect.gen({ self: this }, function* () {
      const reference = yield* Effect.try({
        try: () => parseImageReference(image),
        catch: (cause) =>
          new DockerEngineError({
            cause,
            operation: "POST /images/create",
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
      })
      const auth = yield* registryAuthHeader(reference)
      const progress = progressReader(options.onLine)
      yield* this.#exchange({
        ...(auth && { headers: { "X-Registry-Auth": auth } }),
        method: "POST",
        onData: progress.read,
        path: `/images/create${query({
          fromImage: repositoryName(reference),
          tag: reference.digest ?? reference.tag ?? "latest",
        })}`,
        timeout: options.timeout ?? 300_000,
      })
      const problem = progress.end()
      if (problem !== undefined) {
        return yield* new DockerEngineError({
          operation: "POST /images/create",
          reason: problem,
        })
      }
      options.onLine?.(normalizedReference(reference))
    })
  }

  /**
   * What `image`'s tag names in its registry now, without pulling it: the
   * digest of its manifest, or its index's for a multi-platform image, as
   * the daemon reads it from the registry with the same credentials a pull
   * sends. Docker Hub doesn't count this against its pull limits.
   */
  distributionDigest(image: string): Effect.Effect<string, DockerEngineError> {
    const operation = "GET /distribution/{name}/json"
    return Effect.gen({ self: this }, function* () {
      const reference = yield* Effect.try({
        try: () => parseImageReference(image),
        catch: (cause) =>
          new DockerEngineError({
            cause,
            operation,
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
      })
      const auth = yield* registryAuthHeader(reference)
      const answer = yield* this.#json<{
        Descriptor?: { digest?: unknown }
      } | null>({
        ...(auth && { headers: { "X-Registry-Auth": auth } }),
        method: "GET",
        path: `/distribution/${imageSegment(normalizedReference(reference))}/json`,
        timeout: 20_000,
      })
      const digest = answer?.Descriptor?.digest
      if (!Predicate.isString(digest) || !IMAGE_DIGEST.test(digest)) {
        return yield* new DockerEngineError({
          operation,
          reason: `The registry didn't name a digest for ${image}`,
        })
      }
      return digest
    })
  }

  /** `docker image rm --force`. */
  removeImage(reference: string): Effect.Effect<void, DockerEngineError> {
    return this.#empty({
      method: "DELETE",
      path: `/images/${imageSegment(reference)}${query({ force: true })}`,
      timeout: 90_000,
    })
  }

  /** `A` is how the caller reads Docker's answer; nothing checks it. */
  inspectImage<A = DockerImage>(
    image: string
  ): Effect.Effect<A, DockerEngineError> {
    return this.#json({
      method: "GET",
      path: `/images/${imageSegment(image)}/json`,
    })
  }

  /**
   * `docker image tag <source> <reference>`: points `reference`, a name
   * with an optional tag, at the image `source` names.
   */
  tagImage(
    source: string,
    reference: string
  ): Effect.Effect<void, DockerEngineError> {
    const operation = "POST /images/{name}/tag"
    return Effect.try({
      try: () => parseImageReference(reference),
      catch: (cause) =>
        new DockerEngineError({
          cause,
          operation,
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(
      Effect.flatMap((target) =>
        target.digest === undefined
          ? this.#empty({
              method: "POST",
              path: `/images/${imageSegment(source)}/tag${query({
                repo: repositoryName(target),
                tag: target.tag ?? "latest",
              })}`,
            })
          : Effect.fail(
              new DockerEngineError({
                operation,
                reason: `refusing to create a tag with a digest reference: ${reference}`,
              })
            )
      )
    )
  }

  // ---------------------------------------------------------------- transport

  #empty(exchange: Exchange): Effect.Effect<void, DockerEngineError> {
    return this.#exchange(exchange).pipe(Effect.asVoid)
  }

  #json<A>(exchange: Exchange): Effect.Effect<A, DockerEngineError> {
    return this.#exchange(exchange).pipe(
      Effect.flatMap((body) =>
        Effect.try({
          try: () =>
            (body.length === 0 ? null : JSON.parse(body.toString("utf8"))) as A,
          catch: (cause) =>
            new DockerEngineError({
              cause,
              operation: operationName(exchange),
              reason: `Docker returned an invalid answer to ${operationName(exchange)}`,
            }),
        })
      )
    )
  }

  #exchange(exchange: Exchange): Effect.Effect<Buffer, DockerEngineError> {
    const operation = operationName(exchange)
    const socketPath = this.socketPath
    return Effect.callback<Buffer, DockerEngineError>((resume) => {
      const body =
        exchange.body === undefined
          ? undefined
          : Buffer.from(JSON.stringify(exchange.body))
      const call = request({
        agent,
        headers: {
          ...exchange.headers,
          ...(body && {
            "Content-Length": String(body.byteLength),
            "Content-Type": "application/json",
          }),
        },
        method: exchange.method,
        path: exchange.path,
        socketPath,
      })
      let settled = false
      const settle = (result: Effect.Effect<Buffer, DockerEngineError>) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resume(result)
      }
      const reject = (
        reason: string,
        details: { cause?: unknown; status?: number } = {}
      ) =>
        settle(
          Effect.fail(new DockerEngineError({ operation, reason, ...details }))
        )
      // Abandons the exchange midway, so its connection is not reused.
      const fail = (reason: string, details?: { cause?: unknown }) => {
        reject(reason, details)
        call.destroy()
      }
      const timeout =
        exchange.timeout === undefined ? DEFAULT_TIMEOUT_MS : exchange.timeout
      const timer =
        timeout === null
          ? undefined
          : setTimeout(
              () =>
                fail(`Docker did not finish ${operation} within ${timeout} ms`),
              timeout
            )

      call.on("response", (response) => {
        const status = response.statusCode ?? 500
        const failed = status >= 400
        const stream = failed ? undefined : exchange.onData
        const limit = failed
          ? MAX_ERROR_BYTES
          : (exchange.maxBytes ?? DEFAULT_MAX_BYTES)
        const chunks: Array<Buffer> = []
        let size = 0
        response.on("data", (chunk: Buffer) => {
          if (settled) return
          if (stream) {
            const problem = stream(chunk)
            if (problem !== undefined) fail(problem)
            return
          }
          size += chunk.length
          if (size <= limit) chunks.push(chunk)
          else if (!failed)
            fail(`Docker's answer to ${operation} exceeded ${limit} bytes`)
        })
        response.on("end", () => {
          const text = Buffer.concat(chunks)
          if (failed) {
            reject(
              `Error response from daemon: ${daemonMessage(text, status)}`,
              { status }
            )
          } else {
            settle(Effect.succeed(text))
          }
        })
        response.on("error", (cause) =>
          fail(`Docker closed ${operation} early: ${cause.message}`, { cause })
        )
      })
      call.on("error", (cause) =>
        fail(transportFailure(cause, socketPath, operation), { cause })
      )
      call.end(body)
      return Effect.sync(() => {
        settled = true
        if (timer) clearTimeout(timer)
        call.destroy()
      })
    })
  }
}

/**
 * A process started with `execProcess`, or a container attached to before
 * it starts: its stdio over the upgraded connection, multiplexed as Docker
 * sends it without a TTY.
 */
export class DockerExecProcess {
  readonly stdin: Writable
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly #socket: Duplex
  readonly #ended: Promise<Error | null>
  readonly #exitCode: Effect.Effect<number, DockerEngineError>
  /** What runs, for messages. */
  readonly program: string
  #killed = false

  constructor(
    socket: Duplex,
    attachStdin: boolean,
    exitCode: Effect.Effect<number, DockerEngineError>,
    program: string
  ) {
    this.#socket = socket
    this.#exitCode = exitCode
    this.program = program
    this.stdin = new Writable({
      // Input the process can no longer read (it exited, or its connection
      // closed) is dropped: what happened to the process is reported by its
      // output and exit code, not as a write error.
      write: (chunk: Buffer, _encoding, callback) => {
        if (!attachStdin || socket.destroyed || !socket.writable) callback()
        else socket.write(chunk, () => callback())
      },
      // Half-closes the connection: Docker closes the process's stdin and
      // keeps sending its output.
      final: (callback) => {
        if (!socket.destroyed) socket.end()
        callback()
      },
    })
    // How the process failed reaches callers through `exitCode`, and through
    // the streams to those that pipe or write them; a stream nobody listens
    // to failing must not become an uncaught error that stops the Relay.
    for (const stream of [this.stdin, this.stdout, this.stderr]) {
      stream.on("error", ignoreStreamError)
    }
    // Reading waits for whichever reader is behind.
    const behind = new Set<PassThrough>()
    const demultiplex = demultiplexer(false, (stream, payload) => {
      const target = stream === "stderr" ? this.stderr : this.stdout
      if (target.write(payload) || behind.has(target)) return
      behind.add(target)
      socket.pause()
      target.once("drain", () => {
        behind.delete(target)
        if (behind.size === 0) socket.resume()
      })
    })
    this.#ended = new Promise((resolve) => {
      let failure: Error | null = null
      socket.on("data", (chunk: Buffer) => {
        const problem = demultiplex(chunk)
        if (problem !== undefined) {
          failure = new Error(problem)
          socket.destroy()
        }
      })
      socket.on("error", (cause: Error) => {
        failure ??= cause
      })
      socket.once("close", () => {
        // A process that stops before reading all of its input stops its
        // writer too, instead of having the rest read for nothing.
        if (attachStdin && !this.stdin.writableFinished) {
          this.stdin.destroy(
            new Error(`${program} stopped before reading all of its input`)
          )
        }
        const error = this.#killed ? null : failure
        if (error) {
          this.stdout.destroy(error)
          this.stderr.destroy(error)
        } else {
          this.stdout.end()
          this.stderr.end()
        }
        resolve(error)
      })
    })
  }

  /**
   * The process's exit code, once its output has ended; -1 after `kill()`,
   * which leaves the process to notice its closed stdio.
   */
  get exitCode(): Effect.Effect<number, DockerEngineError> {
    const operation = `exec ${this.program}`
    return Effect.promise(() => this.#ended).pipe(
      Effect.flatMap((failure) =>
        this.#killed
          ? Effect.succeed(-1)
          : failure
            ? Effect.fail(
                new DockerEngineError({
                  cause: failure,
                  operation,
                  reason: `Docker closed ${operation} early: ${failure.message}`,
                })
              )
            : this.#exitCode
      )
    )
  }

  /**
   * Waits for `exitCode`, for stream-based callers, killing the process when
   * it takes longer than `timeout` or `signal` aborts (failing with its
   * reason).
   */
  async waitFor(options: {
    readonly signal?: AbortSignal
    readonly timeout: number
    readonly timedOut: string
  }): Promise<number> {
    const { signal } = options
    const exited = this.exitCode.pipe(
      Effect.mapError((cause): unknown => cause),
      Effect.timeoutOrElse({
        duration: options.timeout,
        orElse: () => Effect.fail<unknown>(new Error(options.timedOut)),
      })
    )
    const outcome = await Effect.runPromise(
      Effect.result(
        (signal ? Effect.raceFirst(exited, aborted(signal)) : exited).pipe(
          Effect.tapError(() => Effect.sync(() => this.kill()))
        )
      )
    )
    if (Result.isFailure(outcome)) throw outcome.failure
    return outcome.success
  }

  /**
   * Closes the connection, as stopping a `docker exec` client did. Returns
   * whether that stopped the process, rather than it having ended already.
   */
  kill(): boolean {
    if (this.#socket.destroyed) return false
    this.#killed = true
    this.#socket.destroy()
    return true
  }
}

/**
 * Streams input into a process (`input` pipes into its stdin) and waits for
 * it to exit (`exited`). A process that fails on its own, such as a database
 * client rejecting the input, reports its error rather than the input's
 * stream; input that fails first stops the process and reports its own.
 */
export async function streamIntoProcess(
  process: DockerExecProcess,
  input: () => Promise<void>,
  exited: () => Promise<void>
): Promise<void> {
  const settle = (run: () => Promise<void>) =>
    Effect.runPromise(
      Effect.result(Effect.tryPromise({ try: run, catch: (cause) => cause }))
    )
  const finished = settle(exited)
  const piped = await settle(input)
  const stopped = Result.isFailure(piped) && process.kill()
  const outcome = await finished
  if (Result.isFailure(piped) && stopped) throw piped.failure
  if (Result.isFailure(outcome)) throw outcome.failure
  if (Result.isFailure(piped)) throw piped.failure
}

/**
 * Writes `input` to a process's stdin, closes it, and returns the process's
 * output once it exits, failing with its stderr when it exits with a
 * non-zero code, as a CLI client run with `-i` reported it.
 */
export function completeWithInput(
  process: DockerExecProcess,
  options: {
    readonly input?: string | Uint8Array
    readonly maxOutputBytes: number
    readonly operation: string
    /** Why output past `maxOutputBytes` failed. */
    readonly overflow: string
  }
): Effect.Effect<DockerOutput, DockerEngineError> {
  const { operation } = options
  return Effect.gen(function* () {
    const output = outputCollector(options.maxOutputBytes, options.overflow)
    let overflow: string | undefined
    const collect = (stream: "stderr" | "stdout") => (chunk: Buffer) => {
      if (overflow !== undefined) return
      overflow = output.add(stream, chunk)
      if (overflow !== undefined) process.kill()
    }
    process.stdout.on("data", collect("stdout"))
    process.stderr.on("data", collect("stderr"))
    // A process that exits without reading its input isn't an error.
    process.stdin.on("error", () => undefined)
    process.stdin.end(options.input ?? "")
    const exitCode = yield* process.exitCode
    if (overflow !== undefined) {
      return yield* new DockerEngineError({ operation, reason: overflow })
    }
    const result = output.read()
    if (exitCode !== 0) {
      return yield* new DockerEngineError({
        operation,
        reason:
          result.stderr.trim() ||
          `${process.program} exited with code ${exitCode}`,
      })
    }
    return result
  })
}

// Fails with the signal's reason once it aborts.
function aborted(signal: AbortSignal): Effect.Effect<never, unknown> {
  return Effect.callback<never, unknown>((resume) => {
    const abort = () => resume(Effect.fail(signal.reason))
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener("abort", abort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", abort))
  })
}

export function isDockerNotFound(cause: unknown): boolean {
  return cause instanceof DockerEngineError && cause.status === 404
}

/** Container names as `docker ps` prints them, without the leading slash. */
export function containerName(container: {
  readonly Names: ReadonlyArray<string>
}): string {
  return (container.Names[0] ?? "").replace(/^\//u, "")
}

/**
 * `docker logs --since` converts RFC 3339 times to Unix seconds with
 * nanoseconds; the API only takes the latter.
 */
export function dockerTimestamp(value: string): string {
  const match = /^(.+T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u.exec(
    value
  )
  const seconds = match ? Date.parse(`${match[1]}${match[3]}`) : Number.NaN
  if (match && Number.isFinite(seconds)) {
    const nanoseconds = (match[2] ?? "").slice(0, 9).padEnd(9, "0")
    return `${Math.floor(seconds / 1_000)}.${nanoseconds}`
  }
  // Any other form JavaScript reads, to the millisecond.
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Invalid Docker timestamp ${value}`)
  }
  const remainder = ((milliseconds % 1_000) + 1_000) % 1_000
  return `${Math.floor(milliseconds / 1_000)}.${String(remainder * 1_000_000).padStart(9, "0")}`
}

/**
 * Reads Docker's JSON progress stream (pulls, builds, pushes) a line at a
 * time, handing each message to `onLine` as the CLI printed it without a
 * terminal. Repeated progress updates for one layer are printed once. An
 * error Docker reports within the stream ends it with its message.
 */
function progressReader(onLine: ((line: string) => void) | undefined) {
  let problem: string | undefined
  const printed = new Set<string>()
  const lines = lineReader((line) => {
    if (problem !== undefined || !line.trim()) return
    const parsed = Result.getOrUndefined(
      Result.try((): unknown => JSON.parse(line))
    )
    if (!Predicate.isObject(parsed)) return
    const message = parsed as Record<string, unknown>
    const text = (value: unknown) =>
      Predicate.isString(value) ? value : undefined
    const detail = Predicate.isObject(message.errorDetail)
      ? (message.errorDetail as Record<string, unknown>)
      : undefined
    const error = text(detail?.message) ?? text(message.error)
    if (error !== undefined) {
      problem = error
      return
    }
    const stream = text(message.stream)
    if (stream !== undefined) {
      for (const part of stream.split("\n")) {
        if (part.trim()) onLine?.(part.replace(/\r$/u, ""))
      }
      return
    }
    const status = text(message.status)
    if (status === undefined) return
    const id = text(message.id)
    const progress = message.progressDetail
    if (Predicate.isObject(progress) && Object.keys(progress).length > 0) {
      const key = `${id ?? ""}\u0000${status}`
      if (printed.has(key)) return
      printed.add(key)
    }
    onLine?.(id ? `${id}: ${status}` : status)
  })
  return {
    end: (): string | undefined => {
      lines.flush()
      return problem
    },
    read: (chunk: Buffer): string | undefined => {
      lines.read(chunk)
      return problem
    },
  }
}

function logsPath(
  reference: string,
  options: DockerLogOptions,
  follow: boolean
): string {
  return `/containers/${segment(reference)}/logs${query({
    follow,
    since: options.since && dockerTimestamp(options.since),
    stderr: true,
    stdout: true,
    tail: options.tail ?? "all",
    timestamps: true,
    until: options.until && dockerTimestamp(options.until),
  })}`
}

function withTimeout<A>(
  effect: Effect.Effect<A, DockerEngineError>,
  timeout: number,
  operation: string
): Effect.Effect<A, DockerEngineError> {
  return effect.pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(
          new DockerEngineError({
            operation,
            reason: `Docker did not finish ${operation} within ${timeout} ms`,
          })
        ),
    })
  )
}

function ignoreStreamError() {}

/**
 * Splits a non-TTY stream into stdout and stderr: each frame is a stream byte,
 * three zero bytes, a big-endian payload length, then the payload. A reason
 * returned by `onFrame`, or an error frame, abandons the stream.
 */
function demultiplexer(
  tty: boolean,
  onFrame: (
    stream: "stderr" | "stdout",
    payload: Buffer
  ) => string | undefined | void
): (chunk: Buffer) => string | undefined {
  if (tty) return (chunk) => onFrame("stdout", chunk) ?? undefined
  let pending: Buffer = Buffer.alloc(0)
  return (chunk) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
    while (pending.length >= 8) {
      const length = pending.readUInt32BE(4)
      if (pending.length < 8 + length) break
      const type = pending[0]
      const payload = pending.subarray(8, 8 + length)
      pending = pending.subarray(8 + length)
      // As moby's stdcopy: 0 (stdin) and 1 go to stdout, 2 to stderr, and 3
      // is an error Docker hit after it had already answered 200.
      const problem =
        type === 0 || type === 1
          ? onFrame("stdout", payload)
          : type === 2
            ? onFrame("stderr", payload)
            : type === 3
              ? `Error from daemon in stream: ${payload.toString("utf8").trim()}`
              : `Docker sent an unrecognized stream type ${type}`
      if (problem) return problem
    }
    return undefined
  }
}

/**
 * Holds stdout and stderr up to `maxBytes` together; past it, `add` returns
 * `overflow` so the request stops instead of reading the rest.
 */
function outputCollector(maxBytes: number, overflow: string) {
  const stdout: Array<Buffer> = []
  const stderr: Array<Buffer> = []
  let size = 0
  return {
    add: (stream: "stderr" | "stdout", payload: Buffer) => {
      size += payload.length
      if (size > maxBytes) return overflow
      ;(stream === "stderr" ? stderr : stdout).push(payload)
      return undefined
    },
    read: (): DockerOutput => ({
      stderr: Buffer.concat(stderr).toString("utf8"),
      stdout: Buffer.concat(stdout).toString("utf8"),
    }),
  }
}

function lineReader(onLine: (line: string) => void) {
  // Decoded across chunks, so characters split between them stay whole.
  const decoder = new StringDecoder("utf8")
  let pending = ""
  return {
    flush: () => {
      pending += decoder.end()
      if (pending) onLine(pending)
      pending = ""
    },
    read: (chunk: Buffer) => {
      const lines = (pending + decoder.write(chunk)).split("\n")
      pending = (lines.pop() ?? "").slice(0, MAX_LINE_CHARACTERS)
      for (const line of lines) onLine(line.slice(0, MAX_LINE_CHARACTERS))
    },
  }
}

function operationName(exchange: Exchange): string {
  return `${exchange.method} ${exchange.path.split("?")[0] ?? exchange.path}`
}

function daemonMessage(body: Buffer, status: number): string {
  const text = body.toString("utf8").trim()
  // Docker occasionally answers with plain text, such as from a proxy.
  const parsed = Result.getOrUndefined(
    Result.try((): unknown => JSON.parse(text))
  )
  return Predicate.isObject(parsed) &&
    "message" in parsed &&
    Predicate.isString(parsed.message)
    ? parsed.message
    : text || `HTTP ${status}`
}

function transportFailure(
  cause: Error,
  socketPath: string,
  operation: string
): string {
  const code = "code" in cause ? cause.code : undefined
  if (code === "EACCES") {
    return `permission denied while trying to connect to the Docker daemon socket at unix://${socketPath}`
  }
  if (code === "ENOENT" || code === "ECONNREFUSED") {
    return `Cannot connect to the Docker daemon at unix://${socketPath}. Is the docker daemon running?`
  }
  return `Docker request ${operation} failed: ${cause.message}`
}

function segment(value: string): string {
  return encodeURIComponent(value)
}

// Image references keep their registry path, tag, and digest separators.
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/u

function imageSegment(value: string): string {
  return encodeURIComponent(value)
    .replaceAll("%2F", "/")
    .replaceAll("%3A", ":")
    .replaceAll("%40", "@")
}

function query(
  parameters: Record<string, boolean | number | string | undefined>
): string {
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(parameters)) {
    if (value === undefined) continue
    search.set(
      name,
      typeof value === "boolean" ? (value ? "1" : "0") : String(value)
    )
  }
  const encoded = search.toString()
  return encoded ? `?${encoded}` : ""
}

// Pulls an image Docker doesn't have yet.
export function ensureImage(
  engine: DockerEngine,
  image: string
): Effect.Effect<void, DockerEngineError> {
  return engine.inspectImage(image).pipe(
    Effect.catch(() => engine.pullImage(image, { timeout: 300_000 })),
    Effect.asVoid
  )
}
