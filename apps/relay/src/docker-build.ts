/**
 * Image builds over the Engine API: `POST /build` with BuildKit, the way the
 * docker CLI ran them, with a session (see `./buildkit-session.js`) serving
 * the build context and the Dockerfile's directory. BuildKit applies
 * `.dockerignore` (or `<Dockerfile>.dockerignore`) and keeps the Dockerfile
 * out of the context, as for the CLI. Progress arrives as BuildKit status
 * protobufs and is printed the way `docker build --progress plain` printed
 * it.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join } from "node:path"

import { Effect, Predicate, Result } from "effect"

import { withBuildSession } from "./buildkit-session.js"
import { withProxyEnvironment } from "./docker-client-config.js"
import {
  defaultPlatform,
  type DockerEngine,
  DockerEngineError,
} from "./docker-engine.js"
import { protobufFields } from "./protobuf.js"

export interface BuildOptions {
  /** The build context directory, as Relay sees it. */
  readonly context: string
  /**
   * The Dockerfile: its path (absolute, or relative to the context), or its
   * contents.
   */
  readonly dockerfile: { readonly path: string } | { readonly content: string }
  readonly tag: string
  readonly labels?: Readonly<Record<string, string>>
  readonly buildArgs?: Readonly<Record<string, string>>
  readonly target?: string
  /** `--platform`; DOCKER_DEFAULT_PLATFORM, as the CLI's default, if unset. */
  readonly platform?: string
  readonly noCache?: boolean
  /** Always pulls base images, as `--pull`. */
  readonly pull?: boolean
  readonly onLine?: (line: string) => void
  readonly timeout?: number | null
}

/** Builds and tags an image, as `docker build --progress plain`. */
export function buildImage(
  engine: DockerEngine,
  options: BuildOptions
): Effect.Effect<void, DockerEngineError> {
  const progress = buildProgress(options.onLine)
  return withDockerfile(options.dockerfile, options.context, (dockerfile) =>
    Effect.gen(function* () {
      // The client config's proxies, as the CLI added them, under any
      // argument the build sets itself.
      const buildArgs = yield* withProxyEnvironment(options.buildArgs)
      yield* withBuildSession(
        engine,
        { context: options.context, dockerfile: dirname(dockerfile) },
        (session) =>
          engine.build({
            onMessage: progress.message,
            parameters: {
              buildargs: JSON.stringify(buildArgs ?? {}),
              dockerfile: basename(dockerfile),
              labels: JSON.stringify(options.labels ?? {}),
              nocache: options.noCache ?? false,
              platform: options.platform || defaultPlatform(),
              pull: options.pull ?? false,
              remote: "client-session",
              rm: true,
              session,
              t: options.tag,
              target: options.target,
              version: "2",
            },
            timeout: options.timeout,
          })
      )
    })
  )
}

// Runs `use` with the Dockerfile's path. Contents are written to a
// directory of their own for the build, so the session serves nothing else
// from it.
function withDockerfile<A>(
  dockerfile: BuildOptions["dockerfile"],
  context: string,
  use: (path: string) => Effect.Effect<A, DockerEngineError>
): Effect.Effect<A, DockerEngineError> {
  if ("path" in dockerfile) {
    return use(
      isAbsolute(dockerfile.path)
        ? dockerfile.path
        : join(context, dockerfile.path)
    )
  }
  const failed = (cause: unknown) =>
    new DockerEngineError({
      cause,
      operation: "POST /build",
      reason: `Relay could not write the Dockerfile: ${cause instanceof Error ? cause.message : String(cause)}`,
    })
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "kiln-build-")),
      catch: failed,
    }),
    (directory) =>
      Effect.tryPromise({
        try: () =>
          writeFile(join(directory, "Dockerfile"), dockerfile.content, {
            mode: 0o600,
          }),
        catch: failed,
      }).pipe(Effect.andThen(use(join(directory, "Dockerfile")))),
    (directory) =>
      Effect.promise(() => rm(directory, { force: true, recursive: true }))
  )
}

// -------------------------------------------------------------- progress

interface Vertex {
  readonly digest: string
  number: number | null
  name: string
  started: number | null
  completed: boolean
}

/**
 * Turns the JSON messages of a build into `--progress plain` lines: BuildKit
 * status updates (base64 protobufs in `aux`), and plain `stream` text.
 */
function buildProgress(onLine: ((line: string) => void) | undefined) {
  const vertices = new Map<string, Vertex>()
  let numbered = 0
  const print = (line: string) => onLine?.(line)
  const vertexFor = (digest: string) => {
    let vertex = vertices.get(digest)
    if (!vertex) {
      vertex = {
        completed: false,
        digest,
        name: "",
        number: null,
        started: null,
      }
      vertices.set(digest, vertex)
    }
    return vertex
  }
  const announce = (vertex: Vertex) => {
    if (vertex.number !== null) return vertex.number
    vertex.number = numbered += 1
    print(`#${vertex.number} ${vertex.name}`)
    return vertex.number
  }
  return {
    message: (message: Record<string, unknown>) => {
      if (Predicate.isString(message.stream)) {
        for (const line of message.stream.split("\n")) {
          if (line.trim()) print(line.replace(/\r$/u, ""))
        }
        return
      }
      if (
        message.id !== "moby.buildkit.trace" ||
        !Predicate.isString(message.aux)
      ) {
        return
      }
      const status = Result.getOrUndefined(
        Result.try(() =>
          decodeStatus(Buffer.from(message.aux as string, "base64"))
        )
      )
      if (!status) return
      for (const update of status.vertexes) {
        const vertex = vertexFor(update.digest)
        if (update.name) vertex.name = update.name
        if (update.started !== null && vertex.started === null) {
          vertex.started = update.started
          announce(vertex)
        }
        if (vertex.completed || update.completed === null) continue
        vertex.completed = true
        const number = announce(vertex)
        if (update.error) print(`#${number} ERROR: ${update.error}`)
        else if (update.cached) print(`#${number} CACHED`)
        else {
          const seconds =
            (update.completed - (vertex.started ?? update.completed)) / 1_000
          print(`#${number} DONE ${seconds.toFixed(1)}s`)
        }
      }
      for (const update of status.statuses) {
        if (update.completed === null) continue
        const number = announce(vertexFor(update.vertex))
        const amount = update.total
          ? `${formatBytes(update.current)} / ${formatBytes(update.total)}`
          : update.current
            ? formatBytes(update.current)
            : ""
        print(`#${number} ${update.id}${amount ? ` ${amount}` : ""} done`)
      }
      for (const log of status.logs) {
        const vertex = vertexFor(log.vertex)
        const number = announce(vertex)
        const offset =
          vertex.started === null
            ? ""
            : ` ${((log.timestamp - vertex.started) / 1_000).toFixed(3)}`
        for (const line of log.message.split("\n")) {
          if (line) print(`#${number}${offset} ${line.replace(/\r$/u, "")}`)
        }
      }
      for (const warning of status.warnings) {
        const number = announce(vertexFor(warning.vertex))
        print(`#${number} WARN: ${warning.short}`)
      }
    },
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes}B`
  const units = ["kB", "MB", "GB", "TB"]
  let value = bytes
  let unit = -1
  while (value >= 1_000 && unit < units.length - 1) {
    value /= 1_000
    unit += 1
  }
  return `${value.toFixed(2)}${units[unit]}`
}

// ------------------------------------------------------------- protobuf

// moby.buildkit.v1.StatusResponse, the parts of it printed.
interface Status {
  readonly vertexes: ReadonlyArray<{
    readonly cached: boolean
    readonly completed: number | null
    readonly digest: string
    readonly error: string
    readonly name: string
    readonly started: number | null
  }>
  readonly statuses: ReadonlyArray<{
    readonly completed: number | null
    readonly current: number
    readonly id: string
    readonly total: number
    readonly vertex: string
  }>
  readonly logs: ReadonlyArray<{
    readonly message: string
    readonly timestamp: number
    readonly vertex: string
  }>
  readonly warnings: ReadonlyArray<{
    readonly short: string
    readonly vertex: string
  }>
}

function decodeStatus(buffer: Buffer): Status {
  const status = {
    logs: [] as Array<Status["logs"][number]>,
    statuses: [] as Array<Status["statuses"][number]>,
    vertexes: [] as Array<Status["vertexes"][number]>,
    warnings: [] as Array<Status["warnings"][number]>,
  }
  for (const [field, value] of protobufFields(buffer)) {
    if (!Buffer.isBuffer(value)) continue
    if (field === 1) {
      const vertex = {
        cached: false,
        completed: null as number | null,
        digest: "",
        error: "",
        name: "",
        started: null as number | null,
      }
      for (const [inner, part] of protobufFields(value)) {
        if (inner === 1 && Buffer.isBuffer(part))
          vertex.digest = part.toString("utf8")
        else if (inner === 3 && Buffer.isBuffer(part))
          vertex.name = part.toString("utf8")
        else if (inner === 4) vertex.cached = part === 1
        else if (inner === 5 && Buffer.isBuffer(part))
          vertex.started = timestamp(part)
        else if (inner === 6 && Buffer.isBuffer(part))
          vertex.completed = timestamp(part)
        else if (inner === 7 && Buffer.isBuffer(part))
          vertex.error = part.toString("utf8")
      }
      status.vertexes.push(vertex)
    } else if (field === 2) {
      const update = {
        completed: null as number | null,
        current: 0,
        id: "",
        total: 0,
        vertex: "",
      }
      for (const [inner, part] of protobufFields(value)) {
        if (inner === 1 && Buffer.isBuffer(part))
          update.id = part.toString("utf8")
        else if (inner === 2 && Buffer.isBuffer(part))
          update.vertex = part.toString("utf8")
        else if (inner === 4 && typeof part === "number") update.current = part
        else if (inner === 5 && typeof part === "number") update.total = part
        else if (inner === 8 && Buffer.isBuffer(part))
          update.completed = timestamp(part)
      }
      status.statuses.push(update)
    } else if (field === 3) {
      const log = { message: "", timestamp: 0, vertex: "" }
      for (const [inner, part] of protobufFields(value)) {
        if (inner === 1 && Buffer.isBuffer(part))
          log.vertex = part.toString("utf8")
        else if (inner === 2 && Buffer.isBuffer(part))
          log.timestamp = timestamp(part)
        else if (inner === 4 && Buffer.isBuffer(part))
          log.message = part.toString("utf8")
      }
      status.logs.push(log)
    } else if (field === 4) {
      const warning = { short: "", vertex: "" }
      for (const [inner, part] of protobufFields(value)) {
        if (inner === 1 && Buffer.isBuffer(part))
          warning.vertex = part.toString("utf8")
        else if (inner === 3 && Buffer.isBuffer(part))
          warning.short = part.toString("utf8")
      }
      status.warnings.push(warning)
    }
  }
  return status
}

// google.protobuf.Timestamp, in milliseconds.
function timestamp(buffer: Buffer): number {
  let seconds = 0
  let nanos = 0
  for (const [field, value] of protobufFields(buffer)) {
    if (field === 1 && typeof value === "number") seconds = value
    if (field === 2 && typeof value === "number") nanos = value
  }
  return seconds * 1_000 + nanos / 1_000_000
}
