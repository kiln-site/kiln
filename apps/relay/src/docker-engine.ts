/**
 * Relay's client for the Docker Engine API on its Docker socket.
 *
 * Each `docker` CLI call starts a Go process that, in turn, makes these same
 * requests; Relay's snapshot loop alone made two of them every two seconds.
 * Talking to the socket directly answers the same questions without a process.
 *
 * Paths are unversioned, so the daemon answers in its own API version: what
 * the bundled CLI negotiates with any daemon that is not newer than it.
 *
 * Creating containers, networks, and volumes, pulling images, Compose, and
 * execs that read stdin stay on the CLI (see `./command.js`): their flags and
 * credential handling are what other Kiln versions depend on.
 */
import { Agent, request } from "node:http"
import { StringDecoder } from "node:string_decoder"
import { Effect, Predicate, Result } from "effect"

import { DockerEngineError } from "./effect/errors.js"

export { DockerEngineError }

// The same defaults `command()` gave each CLI call.
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024
const MAX_ERROR_BYTES = 64 * 1024
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
  readonly Mounts?: ReadonlyArray<{
    readonly Destination: string
    readonly RW: boolean
    readonly Source: string
  }>
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
  readonly Labels: Readonly<Record<string, string>> | null
  readonly Name: string
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
      path: `/containers/create${query({ name })}`,
      timeout: 60_000,
    })
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
    options: { readonly force?: boolean; readonly timeout?: number } = {}
  ): Effect.Effect<void, DockerEngineError> {
    const removal = this.#empty({
      method: "DELETE",
      path: `/containers/${segment(reference)}${query({ force: options.force })}`,
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

  // The output ends as the process exits; its code can be recorded just after.
  #execExitCode(id: string): Effect.Effect<number, DockerEngineError> {
    const inspect = this.#json<{
      readonly ExitCode: number | null
      readonly Running: boolean
    }>({ method: "GET", path: `/exec/${segment(id)}/json` })
    return Effect.gen(function* () {
      for (let attempt = 0; ; attempt += 1) {
        const exec = yield* inspect
        if (!exec.Running || attempt >= 20) return exec.ExitCode ?? -1
        yield* Effect.sleep(25)
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

  /** `docker image rm --force`. */
  removeImage(reference: string): Effect.Effect<void, DockerEngineError> {
    return this.#empty({
      method: "DELETE",
      path: `/images/${imageSegment(reference)}${query({ force: true })}`,
      timeout: 90_000,
    })
  }

  inspectImage(image: string): Effect.Effect<DockerImage, DockerEngineError> {
    return this.#json({
      method: "GET",
      path: `/images/${imageSegment(image)}/json`,
    })
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
        headers: body
          ? {
              "Content-Length": String(body.byteLength),
              "Content-Type": "application/json",
            }
          : undefined,
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
