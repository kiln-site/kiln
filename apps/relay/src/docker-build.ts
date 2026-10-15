/**
 * Image builds over the Engine API: `POST /build` with BuildKit, the build
 * context sent as a tar.
 *
 * Without a BuildKit session (the gRPC channel buildx keeps with the daemon),
 * the daemon reads the context and the Dockerfile from the uploaded tar and
 * applies no `.dockerignore`. So the context is filtered here, with the same
 * pattern rules, and a Dockerfile that isn't in the context is added to the
 * tar. Progress arrives as BuildKit status protobufs and is printed the way
 * `docker build --progress plain` printed it.
 */
import { createReadStream } from "node:fs"
import { lstat, readdir, readFile, readlink } from "node:fs/promises"
import { join, posix } from "node:path"
import { Readable } from "node:stream"

import { Effect, Predicate, Result } from "effect"
import { pack as createTarPack, type Pack } from "tar-stream"

import { type DockerEngine, DockerEngineError } from "./docker-engine.js"

// Where a Dockerfile from outside the context goes in it.
export const INJECTED_DOCKERFILE = ".kiln.Dockerfile"

export interface BuildOptions {
  /** The build context directory, as Relay sees it. */
  readonly context: string
  /**
   * The Dockerfile: a path relative to the context, or its contents when it
   * isn't in the context.
   */
  readonly dockerfile: { readonly path: string } | { readonly content: string }
  readonly tag: string
  readonly labels?: Readonly<Record<string, string>>
  readonly buildArgs?: Readonly<Record<string, string>>
  readonly target?: string
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
  const operation = "POST /build"
  return Effect.gen(function* () {
    const dockerfile =
      "path" in options.dockerfile
        ? posix.normalize(options.dockerfile.path)
        : INJECTED_DOCKERFILE
    if (dockerfile.startsWith("../") || posix.isAbsolute(dockerfile)) {
      return yield* new DockerEngineError({
        operation,
        reason: `The Dockerfile ${dockerfile} is outside the build context`,
      })
    }
    const ignore = yield* Effect.tryPromise({
      try: () => readIgnoreFile(options.context),
      catch: (cause) =>
        new DockerEngineError({
          cause,
          operation,
          reason: `Docker could not read the build context's .dockerignore: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    })
    const progress = buildProgress(options.onLine)
    yield* engine.build({
      context: contextArchive(options.context, {
        ignore,
        injected:
          "content" in options.dockerfile
            ? { content: options.dockerfile.content, name: INJECTED_DOCKERFILE }
            : undefined,
        keep: [dockerfile, ".dockerignore"],
      }),
      onMessage: progress.message,
      parameters: {
        buildargs: JSON.stringify(options.buildArgs ?? {}),
        dockerfile,
        labels: JSON.stringify(options.labels ?? {}),
        nocache: options.noCache ?? false,
        pull: options.pull ?? false,
        rm: true,
        t: options.tag,
        target: options.target,
        version: "2",
      },
      timeout: options.timeout,
    })
  })
}

// ----------------------------------------------------------- .dockerignore

interface IgnorePattern {
  readonly exclusion: boolean
  readonly regex: RegExp
  readonly text: string
}

/** The context's `.dockerignore` patterns, read as BuildKit reads them. */
async function readIgnoreFile(
  context: string
): Promise<ReadonlyArray<IgnorePattern>> {
  const text = await Effect.runPromise(
    Effect.tryPromise(() => readFile(join(context, ".dockerignore"), "utf8")).pipe(
      Effect.catch((cause) =>
        Predicate.hasProperty(cause, "cause") &&
        Predicate.hasProperty(cause.cause, "code") &&
        cause.cause.code === "ENOENT"
          ? Effect.succeed("")
          : Effect.fail(cause)
      )
    )
  )
  return ignorePatterns(text)
}

function ignorePatterns(text: string): Array<IgnorePattern> {
  const patterns: Array<IgnorePattern> = []
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    let line = index === 0 ? raw.replace(/^﻿/u, "") : raw
    if (line.startsWith("#")) continue
    line = line.trim()
    if (!line) continue
    const exclusion = line.startsWith("!")
    if (exclusion) line = line.slice(1).trim()
    if (line) {
      line = posix.normalize(line).replace(/\/+$/u, "") || "/"
      if (line.length > 1 && line.startsWith("/")) line = line.slice(1)
    }
    if (!line) continue
    patterns.push({ exclusion, regex: patternRegex(line), text: line })
  }
  return patterns
}

// moby/patternmatcher's translation of a pattern to a regular expression.
function patternRegex(pattern: string): RegExp {
  let source = "^"
  const characters = [...pattern]
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!
    if (character === "*") {
      if (characters[index + 1] === "*") {
        index += 1
        // `**/` is `**`.
        if (characters[index + 1] === "/") index += 1
        source += index + 1 >= characters.length ? ".*" : "(.*/)?"
      } else {
        source += "[^/]*"
      }
    } else if (character === "?") {
      source += "[^/]"
    } else if (character === "\\") {
      const next = characters[index + 1]
      if (next === undefined) source += "\\\\"
      else {
        source += escapeRegex(next)
        index += 1
      }
    } else if (character === "[" || character === "]") {
      source += character
    } else {
      source += escapeRegex(character)
    }
  }
  return new RegExp(`${source}$`, "u")
}

function escapeRegex(character: string): string {
  return /[.+()|{}$^\\]/u.test(character) ? `\\${character}` : character
}

/**
 * Whether `path` (relative, with `/`) is ignored: by the last pattern that
 * matches it or one of its parent directories, as patternmatcher's
 * `MatchesOrParentMatches`.
 */
function isIgnored(
  patterns: ReadonlyArray<IgnorePattern>,
  path: string
): boolean {
  let ignored = false
  const parents = path.split("/").slice(0, -1)
  for (const pattern of patterns) {
    if (pattern.exclusion !== ignored) continue
    let match = pattern.regex.test(path)
    for (let depth = 1; !match && depth <= parents.length; depth += 1) {
      match = pattern.regex.test(parents.slice(0, depth).join("/"))
    }
    if (match) ignored = !pattern.exclusion
  }
  return ignored
}

// --------------------------------------------------------------- context

/**
 * The context as a tar, written as it is read: regular files, directories,
 * and symlinks, owned by root as the CLI sends them, without ignored paths.
 * An ignored directory is skipped whole unless an exception could include
 * something in it.
 */
function contextArchive(
  directory: string,
  options: {
    readonly ignore: ReadonlyArray<IgnorePattern>
    readonly injected?: { readonly content: string; readonly name: string }
    /** Paths sent even when ignored, as the CLI does for its build files. */
    readonly keep: ReadonlyArray<string>
  }
): Readable {
  const archive = createTarPack()
  const exceptions = options.ignore.filter((pattern) => pattern.exclusion)
  const write = async () => {
    const walk = async (relative: string): Promise<void> => {
      const entries = await readdir(join(directory, relative), {
        withFileTypes: true,
      })
      entries.sort((left, right) => (left.name < right.name ? -1 : 1))
      for (const entry of entries) {
        const path = relative ? `${relative}/${entry.name}` : entry.name
        if (options.injected && path === options.injected.name) continue
        const ignored =
          isIgnored(options.ignore, path) && !options.keep.includes(path)
        if (ignored && !entry.isDirectory()) continue
        if (
          ignored &&
          !exceptions.some((pattern) =>
            `${pattern.text}/`.startsWith(`${path}/`)
          )
        ) {
          continue
        }
        await addEntry(archive, directory, path, !ignored)
        if (entry.isDirectory()) await walk(path)
      }
    }
    await walk("")
    if (options.injected) {
      await entryWritten(archive, {
        content: Buffer.from(options.injected.content),
        header: {
          gid: 0,
          mode: 0o644,
          mtime: new Date(0),
          name: options.injected.name,
          type: "file",
          uid: 0,
        },
      })
    }
    archive.finalize()
  }
  void Effect.runPromise(
    Effect.tryPromise(write).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          archive.destroy(
            cause.cause instanceof Error ? cause.cause : new Error(String(cause))
          )
        })
      )
    )
  )
  // A Node.js stream, which pipes into a request; it reads the archive as
  // the request takes it.
  return Readable.from(archive)
}

async function addEntry(
  archive: Pack,
  directory: string,
  path: string,
  included: boolean
): Promise<void> {
  const absolute = join(directory, path)
  const stats = await lstat(absolute)
  const header = {
    gid: 0,
    mode: stats.mode & 0o7777,
    mtime: stats.mtime,
    name: path,
    uid: 0,
  }
  if (stats.isDirectory()) {
    if (included) {
      await entryWritten(archive, { header: { ...header, type: "directory" } })
    }
  } else if (stats.isSymbolicLink()) {
    await entryWritten(archive, {
      header: {
        ...header,
        linkname: await readlink(absolute),
        type: "symlink",
      },
    })
  } else if (stats.isFile()) {
    await entryWritten(archive, {
      header: { ...header, size: stats.size, type: "file" },
      source: createReadStream(absolute),
    })
  }
  // Sockets, pipes, and devices aren't part of a build context.
}

function entryWritten(
  archive: Pack,
  entry: {
    readonly content?: Buffer
    readonly header: Parameters<Pack["entry"]>[0]
    readonly source?: Readable
  }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (error?: Error | null) => (error ? reject(error) : resolve())
    const sink = entry.content
      ? archive.entry(entry.header, entry.content, done)
      : archive.entry(entry.header, done)
    if (entry.source) {
      entry.source.once("error", reject)
      entry.source.pipe(sink)
    }
  })
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
      vertex = { completed: false, digest, name: "", number: null, started: null }
      vertices.set(digest, vertex)
    }
    return vertex
  }
  const announce = (vertex: Vertex) => {
    if (vertex.number !== null) return vertex.number
    vertex.number = (numbered += 1)
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
      if (message.id !== "moby.buildkit.trace" || !Predicate.isString(message.aux)) {
        return
      }
      const status = Result.getOrUndefined(
        Result.try(() => decodeStatus(Buffer.from(message.aux as string, "base64")))
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
          const seconds = (update.completed - (vertex.started ?? update.completed)) / 1_000
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
        if (inner === 1 && Buffer.isBuffer(part)) vertex.digest = part.toString("utf8")
        else if (inner === 3 && Buffer.isBuffer(part)) vertex.name = part.toString("utf8")
        else if (inner === 4) vertex.cached = part === 1
        else if (inner === 5 && Buffer.isBuffer(part)) vertex.started = timestamp(part)
        else if (inner === 6 && Buffer.isBuffer(part)) vertex.completed = timestamp(part)
        else if (inner === 7 && Buffer.isBuffer(part)) vertex.error = part.toString("utf8")
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
        if (inner === 1 && Buffer.isBuffer(part)) update.id = part.toString("utf8")
        else if (inner === 2 && Buffer.isBuffer(part)) update.vertex = part.toString("utf8")
        else if (inner === 4 && typeof part === "number") update.current = part
        else if (inner === 5 && typeof part === "number") update.total = part
        else if (inner === 8 && Buffer.isBuffer(part)) update.completed = timestamp(part)
      }
      status.statuses.push(update)
    } else if (field === 3) {
      const log = { message: "", timestamp: 0, vertex: "" }
      for (const [inner, part] of protobufFields(value)) {
        if (inner === 1 && Buffer.isBuffer(part)) log.vertex = part.toString("utf8")
        else if (inner === 2 && Buffer.isBuffer(part)) log.timestamp = timestamp(part)
        else if (inner === 4 && Buffer.isBuffer(part)) log.message = part.toString("utf8")
      }
      status.logs.push(log)
    } else if (field === 4) {
      const warning = { short: "", vertex: "" }
      for (const [inner, part] of protobufFields(value)) {
        if (inner === 1 && Buffer.isBuffer(part)) warning.vertex = part.toString("utf8")
        else if (inner === 3 && Buffer.isBuffer(part)) warning.short = part.toString("utf8")
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

/** A message's fields: varints as numbers, length-delimited as buffers. */
function* protobufFields(
  buffer: Buffer
): Generator<readonly [number, number | Buffer]> {
  let offset = 0
  const varint = () => {
    let value = 0
    let scale = 1
    for (;;) {
      const byte = buffer[offset]
      if (byte === undefined) throw new Error("Truncated protobuf varint")
      offset += 1
      value += (byte & 0x7f) * scale
      if ((byte & 0x80) === 0) return value
      scale *= 128
    }
  }
  while (offset < buffer.length) {
    const key = varint()
    const field = Math.floor(key / 8)
    const wire = key % 8
    if (wire === 0) yield [field, varint()]
    else if (wire === 2) {
      const length = varint()
      const value = buffer.subarray(offset, offset + length)
      if (value.length !== length) throw new Error("Truncated protobuf field")
      offset += length
      yield [field, value]
    } else if (wire === 1) offset += 8
    else if (wire === 5) offset += 4
    else throw new Error(`Unsupported protobuf wire type ${wire}`)
  }
}
