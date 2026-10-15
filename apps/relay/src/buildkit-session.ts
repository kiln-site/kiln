/**
 * A BuildKit session for a build, as the docker CLI opened one: the daemon
 * calls back into the Relay over a connection opened with `POST /session`
 * (gRPC over HTTP/2) for the build context and the Dockerfile's directory,
 * registry credentials for base images, and health checks.
 *
 * BuildKit reads `.dockerignore` (or `<Dockerfile>.dockerignore`) itself
 * through the session, then asks for the context with those patterns. They
 * are applied here exactly as fsutil applies them for the CLI, and BuildKit
 * only asks for files it doesn't already have from an earlier build. The
 * Dockerfile is never part of the context.
 */
import { createHash, randomBytes } from "node:crypto"
import type { BigIntStats } from "node:fs"
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises"
import { createServer, type ServerHttp2Stream } from "node:http2"
import { basename, join } from "node:path"
import type { Duplex } from "node:stream"

import { Data, Effect, Fiber, Predicate, Result } from "effect"

import { type DockerEngine, DockerEngineError } from "./docker-engine.js"
import { cleanPath, type MatchInfo, PatternMatcher } from "./docker-patterns.js"
import { protobufFields, protobufMessage } from "./protobuf.js"
import { registryCredentials } from "./registry-auth.js"

const HEALTH_CHECK = "/grpc.health.v1.Health/Check"
const CREDENTIALS = "/moby.filesync.v1.Auth/Credentials"
const DIFF_COPY = "/moby.filesync.v1.FileSync/DiffCopy"

// fsutil's packet types.
const PACKET_STAT = 0
const PACKET_REQ = 1
const PACKET_DATA = 2
const PACKET_FIN = 3
const PACKET_ERR = 4

// Go's os.FileMode bits.
const MODE_DIR = 2 ** 31
const MODE_SYMLINK = 2 ** 27
const MODE_DEVICE = 2 ** 26
const MODE_NAMED_PIPE = 2 ** 25
const MODE_SOCKET = 2 ** 24
const MODE_SETUID = 2 ** 23
const MODE_SETGID = 2 ** 22
const MODE_CHAR_DEVICE = 2 ** 21
const MODE_STICKY = 2 ** 20
const MODE_IRREGULAR = 2 ** 19
const MODE_TYPE =
  MODE_DIR +
  MODE_SYMLINK +
  MODE_NAMED_PIPE +
  MODE_SOCKET +
  MODE_DEVICE +
  MODE_CHAR_DEVICE +
  MODE_IRREGULAR

// fsutil sends files in packets of up to 32 KiB.
const CHUNK_BYTES = 32 * 1024

export interface BuildSessionDirectories {
  /** The build context. */
  readonly context: string
  /** The directory the Dockerfile is in. */
  readonly dockerfile: string
}

/**
 * Runs `use` with a session open on the daemon (passing its ID, for the
 * build's `session` parameter), and closes it after.
 */
export function withBuildSession<A, E, R>(
  engine: DockerEngine,
  directories: BuildSessionDirectories,
  use: (session: string) => Effect.Effect<A, E, R>
): Effect.Effect<A, DockerEngineError | E, R> {
  return Effect.acquireUseRelease(
    openSession(engine, directories),
    (session) => use(session.id),
    (session) => Effect.sync(() => session.close())
  )
}

function openSession(
  engine: DockerEngine,
  directories: BuildSessionDirectories
) {
  return Effect.gen(function* () {
    const resolve = (path: string) =>
      Effect.tryPromise({
        try: () => realpath(path),
        catch: (cause) =>
          new DockerEngineError({
            cause,
            operation: "POST /session",
            reason: `Relay could not open the build directory ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      })
    const roots = {
      context: yield* resolve(directories.context),
      dockerfile: yield* resolve(directories.dockerfile),
    }
    const id = randomBytes(16).toString("hex")
    const socket = yield* engine.hijack("/session", undefined, {
      headers: {
        "X-Docker-Expose-Session-Grpc-Method": [
          CREDENTIALS,
          DIFF_COPY,
          HEALTH_CHECK,
        ],
        "X-Docker-Expose-Session-Name":
          basename(roots.context).replace(/[^\w.-]/gu, "_") || "context",
        // Lets BuildKit reuse what it has of this context from earlier
        // builds, and only ask for what changed.
        "X-Docker-Expose-Session-Sharedkey": createHash("sha256")
          .update(roots.context)
          .digest("hex"),
        "X-Docker-Expose-Session-Uuid": id,
      },
      protocol: "h2c",
    })
    return serve(id, socket, roots)
  })
}

function serve(
  id: string,
  socket: Duplex,
  roots: { readonly context: string; readonly dockerfile: string }
) {
  const server = createServer()
  const running = new Set<Fiber.Fiber<void>>()
  server.on("sessionError", () => undefined)
  server.on("stream", (stream, headers, _flags, rawHeaders) => {
    stream.on("error", () => undefined)
    const method = headers[":path"]
    const metadata = grpcMetadata(rawHeaders)
    const reader = new GrpcReader(stream)
    const handled =
      method === DIFF_COPY
        ? diffCopy(stream, reader, metadata, roots)
        : method === HEALTH_CHECK
          ? unary(stream, reader, () =>
              // grpc.health.v1.HealthCheckResponse: SERVING.
              Effect.succeed(protobufMessage([[1, 1]]))
            )
          : method === CREDENTIALS
            ? unary(stream, reader, (request) => credentials(request))
            : Effect.fail(
                new GrpcFailure({
                  code: 12,
                  message: `unknown method ${String(method)}`,
                })
              )
    stream.respond(
      { ":status": 200, "content-type": "application/grpc" },
      { waitForTrailers: true }
    )
    let trailers: Record<string, string> = { "grpc-status": "0" }
    stream.on("wantTrailers", () => stream.sendTrailers(trailers))
    const fiber = Effect.runFork(
      handled.pipe(
        Effect.catch((failure: unknown) =>
          Effect.sync(() => {
            const { code, message } =
              failure instanceof GrpcFailure
                ? failure
                : { code: 2, message: errorText(failure) }
            trailers = {
              "grpc-message": encodeURIComponent(message),
              "grpc-status": String(code),
            }
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (!stream.destroyed && !stream.writableEnded) stream.end()
          })
        )
      )
    )
    running.add(fiber)
    fiber.addObserver(() => running.delete(fiber))
    stream.once("close", () => {
      Effect.runFork(Fiber.interrupt(fiber))
    })
  })
  socket.on("error", () => undefined)
  server.emit("connection", socket)
  return {
    close() {
      for (const fiber of running) Effect.runFork(Fiber.interrupt(fiber))
      socket.destroy()
      server.close()
    },
    id,
  }
}

// ---------------------------------------------------------------- gRPC

class GrpcFailure extends Data.TaggedError("GrpcFailure")<{
  readonly code: number
  readonly message: string
}> {}

function errorText(cause: unknown): string {
  if (cause instanceof GrpcFailure) return cause.message
  if (cause instanceof Error) return cause.message
  if (Predicate.hasProperty(cause, "cause")) return errorText(cause.cause)
  return String(cause)
}

/** Request metadata, every value of each key, as filesync decodes it. */
function grpcMetadata(
  rawHeaders: ReadonlyArray<string>
): ReadonlyMap<string, ReadonlyArray<string>> {
  const values = new Map<string, Array<string>>()
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!.toLowerCase()
    if (name.startsWith(":")) continue
    values.set(name, [...(values.get(name) ?? []), rawHeaders[index + 1]!])
  }
  const decoded = new Map<string, ReadonlyArray<string>>()
  for (const [name, list] of values) {
    // Values with characters a header can't hold are sent query-escaped.
    const encoded = values.get(`${name}-encoded`)?.[0]
    decoded.set(
      name,
      encoded === "1" || encoded === "true"
        ? list.map((value) =>
            Result.getOrElse(
              Result.try(() => decodeURIComponent(value.replaceAll("+", " "))),
              () => value
            )
          )
        : list
    )
  }
  return decoded
}

/** Reads a stream's gRPC messages, each a 5-byte prefix and its bytes. */
class GrpcReader {
  #buffered: Buffer = Buffer.alloc(0)
  readonly #messages: Array<Buffer> = []
  #ended = false
  #failure: GrpcFailure | undefined
  #wake: (() => void) | undefined

  constructor(readonly stream: ServerHttp2Stream) {
    stream.on("data", (chunk: Buffer) => {
      this.#buffered =
        this.#buffered.length === 0
          ? chunk
          : Buffer.concat([this.#buffered, chunk])
      while (this.#buffered.length >= 5) {
        const length = this.#buffered.readUInt32BE(1)
        if (this.#buffered.length < 5 + length) break
        if (this.#buffered[0] !== 0) {
          this.#failure = new GrpcFailure({
            code: 12,
            message: "compressed messages aren't supported",
          })
        }
        this.#messages.push(this.#buffered.subarray(5, 5 + length))
        this.#buffered = this.#buffered.subarray(5 + length)
      }
      // Holds the sender back until the messages so far are read.
      if (this.#messages.length > 64) stream.pause()
      this.#wake?.()
    })
    const end = () => {
      this.#ended = true
      this.#wake?.()
    }
    stream.once("end", end)
    stream.once("close", end)
  }

  /** The next message, or undefined once the caller ends its stream. */
  get next(): Effect.Effect<Buffer | undefined, GrpcFailure> {
    return Effect.callback<Buffer | undefined, GrpcFailure>((resume) => {
      const take = () => {
        if (this.#failure) {
          resume(Effect.fail(this.#failure))
          return true
        }
        const message = this.#messages.shift()
        if (message) {
          if (this.#messages.length <= 64) this.stream.resume()
          resume(Effect.succeed(message))
          return true
        }
        if (this.#ended) {
          resume(Effect.succeed(undefined))
          return true
        }
        return false
      }
      if (take()) return
      this.#wake = () => {
        if (take()) this.#wake = undefined
      }
      return Effect.sync(() => {
        this.#wake = undefined
      })
    })
  }
}

/** Writes one gRPC message, waiting while the stream is full. */
function send(
  stream: ServerHttp2Stream,
  message: Buffer
): Effect.Effect<void, GrpcFailure> {
  return Effect.callback<void, GrpcFailure>((resume) => {
    if (stream.destroyed || stream.writableEnded) {
      resume(
        Effect.fail(
          new GrpcFailure({ code: 1, message: "the session stream closed" })
        )
      )
      return
    }
    const prefix = Buffer.alloc(5)
    prefix.writeUInt32BE(message.length, 1)
    if (stream.write(Buffer.concat([prefix, message]))) {
      resume(Effect.void)
      return
    }
    const drained = () => {
      stream.off("close", closed)
      resume(Effect.void)
    }
    const closed = () => {
      stream.off("drain", drained)
      resume(
        Effect.fail(
          new GrpcFailure({ code: 1, message: "the session stream closed" })
        )
      )
    }
    stream.once("drain", drained)
    stream.once("close", closed)
    return Effect.sync(() => {
      stream.off("drain", drained)
      stream.off("close", closed)
    })
  })
}

function unary(
  stream: ServerHttp2Stream,
  reader: GrpcReader,
  answer: (request: Buffer) => Effect.Effect<Buffer, GrpcFailure>
): Effect.Effect<void, GrpcFailure> {
  return Effect.gen(function* () {
    const request = yield* reader.next
    yield* send(stream, yield* answer(request ?? Buffer.alloc(0)))
  })
}

// moby.filesync.v1.Auth/Credentials: CredentialsRequest { Host = 1 }, and
// CredentialsResponse { Username = 1, Secret = 2 }.
function credentials(request: Buffer): Effect.Effect<Buffer, GrpcFailure> {
  return Effect.gen(function* () {
    const fields = yield* Effect.try({
      try: () => [...protobufFields(request)],
      catch: () =>
        new GrpcFailure({ code: 3, message: "invalid credentials request" }),
    })
    const host = fields.find(([field]) => field === 1)?.[1]
    const found = yield* registryCredentials(
      Buffer.isBuffer(host) ? host.toString("utf8") : ""
    )
    return protobufMessage([
      [1, found.username],
      [2, found.secret],
    ])
  })
}

// ------------------------------------------------------------ file sync

interface Filter {
  readonly include: PatternMatcher | undefined
  readonly exclude: PatternMatcher | undefined
  readonly onlyPrefixIncludes: boolean
  readonly onlyPrefixExcludeExceptions: boolean
}

/**
 * moby.filesync.v1.FileSync/DiffCopy, as fsutil's sender: the directory's
 * entries as stat packets, in walk order, then the contents of each file
 * BuildKit asks for, until it finishes.
 */
function diffCopy(
  stream: ServerHttp2Stream,
  reader: GrpcReader,
  metadata: ReadonlyMap<string, ReadonlyArray<string>>,
  roots: { readonly context: string; readonly dockerfile: string }
): Effect.Effect<void, GrpcFailure> {
  return Effect.gen(function* () {
    const name = metadata.get("dir-name")?.[0] ?? ""
    const root =
      name === "context"
        ? roots.context
        : name === "dockerfile"
          ? roots.dockerfile
          : undefined
    if (root === undefined) {
      return yield* new GrpcFailure({
        code: 5,
        message: `no access allowed to dir "${name}"`,
      })
    }
    const filter = yield* contextFilter(root, {
      excludes: metadata.get("exclude-patterns"),
      followPaths: metadata.get("followpaths"),
      includes: metadata.get("include-patterns"),
    })
    const files = new Map<number, string>()
    const walk = Effect.gen(function* () {
      let id = 0
      yield* walkContext(root, filter, (entry) => {
        if ((entry.mode & MODE_TYPE) === 0) files.set(id, entry.absolute)
        id += 1
        return send(stream, packet(PACKET_STAT, { stat: statMessage(entry) }))
      })
      yield* send(stream, packet(PACKET_STAT, {}))
    }).pipe(
      // The receiver hears why, as fsutil's sender tells it.
      Effect.tapError((failure) =>
        send(
          stream,
          packet(PACKET_ERR, { data: Buffer.from(errorText(failure)) })
        ).pipe(Effect.ignore)
      )
    )
    const answer = Effect.gen(function* () {
      for (;;) {
        const message = yield* reader.next
        if (message === undefined) {
          return yield* new GrpcFailure({
            code: 1,
            message: "BuildKit stopped reading the context",
          })
        }
        const received = yield* Effect.try({
          try: () => decodePacket(message),
          catch: () =>
            new GrpcFailure({ code: 3, message: "invalid file sync packet" }),
        })
        if (received.type === PACKET_ERR) {
          return yield* new GrpcFailure({
            code: 2,
            message: `error from receiver: ${received.data.toString("utf8")}`,
          })
        }
        if (received.type === PACKET_REQ) {
          const path = files.get(received.id)
          if (path === undefined) {
            return yield* new GrpcFailure({
              code: 2,
              message: `invalid file id ${received.id}`,
            })
          }
          files.delete(received.id)
          yield* sendFile(stream, received.id, path)
        } else if (received.type === PACKET_FIN) {
          yield* send(stream, packet(PACKET_FIN, {}))
          return
        }
      }
    })
    yield* Effect.all([walk, answer], { concurrency: 2, discard: true })
  })
}

// A file's contents as data packets, then an empty one; a file that can't
// be opened is sent empty, as fsutil does.
function sendFile(
  stream: ServerHttp2Stream,
  id: number,
  path: string
): Effect.Effect<void, GrpcFailure> {
  const contents = Effect.acquireUseRelease(
    Effect.result(Effect.tryPromise(() => open(path, "r"))),
    (opened) =>
      Effect.gen(function* () {
        if (Result.isFailure(opened)) return
        const handle = opened.success
        for (;;) {
          const chunk = Buffer.allocUnsafe(CHUNK_BYTES)
          const { bytesRead } = yield* Effect.tryPromise({
            try: () => handle.read(chunk, 0, CHUNK_BYTES, null),
            catch: (cause) =>
              new GrpcFailure({
                code: 2,
                message: `read ${path}: ${errorText(cause)}`,
              }),
          })
          if (bytesRead === 0) return
          yield* send(
            stream,
            packet(PACKET_DATA, { data: chunk.subarray(0, bytesRead), id })
          )
        }
      }),
    (opened) =>
      Result.isSuccess(opened)
        ? Effect.promise(() => opened.success.close())
        : Effect.void
  )
  return contents.pipe(
    Effect.andThen(send(stream, packet(PACKET_DATA, { id })))
  )
}

interface Entry {
  readonly absolute: string
  readonly devmajor: number
  readonly devminor: number
  readonly linkname: string
  readonly mode: number
  readonly modTime: bigint
  readonly path: string
  readonly size: bigint
}

function packet(
  type: number,
  fields: {
    readonly data?: Buffer
    readonly id?: number
    readonly stat?: Buffer
  }
): Buffer {
  return protobufMessage([
    [1, type],
    [2, fields.stat],
    [3, fields.id],
    [4, fields.data],
  ])
}

// fsutil.types.Stat. Owners are root's, as BuildKit's client resets them.
function statMessage(entry: Entry): Buffer {
  return protobufMessage([
    [1, entry.path],
    [2, entry.mode],
    [5, entry.size],
    [6, entry.modTime],
    [7, entry.linkname],
    [8, entry.devmajor],
    [9, entry.devminor],
  ])
}

function decodePacket(message: Buffer) {
  let type = 0
  let id = 0
  let data: Buffer = Buffer.alloc(0)
  for (const [field, value] of protobufFields(message)) {
    if (field === 1 && typeof value === "number") type = value
    else if (field === 3 && typeof value === "number") id = value
    else if (field === 4 && Buffer.isBuffer(value)) data = value
  }
  return { data, id, type }
}

// fsutil's NewFilterFS: the patterns, with the paths `followpaths` names
// (through any symlinks) added to the includes.
function contextFilter(
  root: string,
  options: {
    readonly excludes: ReadonlyArray<string> | undefined
    readonly followPaths: ReadonlyArray<string> | undefined
    readonly includes: ReadonlyArray<string> | undefined
  }
): Effect.Effect<Filter, GrpcFailure> {
  return Effect.gen(function* () {
    let includes = options.includes ? [...options.includes] : undefined
    if (options.followPaths) {
      const targets = yield* followLinks(root, options.followPaths)
      if (targets !== undefined) {
        includes = dedupePaths([...(includes ?? []), ...targets])
      }
    }
    const matcher = (patterns: ReadonlyArray<string>, kind: string) =>
      Effect.try({
        try: () => new PatternMatcher(patterns),
        catch: (cause) =>
          new GrpcFailure({
            code: 2,
            message: `invalid ${kind}patterns: ${patterns.join(" ")}: ${errorText(cause)}`,
          }),
      })
    const include = includes?.length
      ? yield* matcher(includes, "include")
      : undefined
    const exclude = options.excludes?.length
      ? yield* matcher(options.excludes, "exclude")
      : undefined
    const wildcard = (text: string) => /[*[\]?^\\]/u.test(text)
    return {
      exclude,
      include,
      onlyPrefixExcludeExceptions: !exclude?.patterns.some(
        (pattern) =>
          pattern.exclusion && wildcard(withoutTrailingGlob(pattern.text))
      ),
      onlyPrefixIncludes: !include?.patterns.some(
        (pattern) =>
          !pattern.exclusion && wildcard(withoutTrailingGlob(pattern.text))
      ),
    }
  })
}

function withoutTrailingGlob(pattern: string): string {
  let text = pattern
  if (text.endsWith("/**")) text = text.slice(0, -3)
  if (text.endsWith("/*")) text = text.slice(0, -2)
  return text
}

// Expects sorted paths; one path holding another keeps only the outer.
function dedupePaths(paths: ReadonlyArray<string>): Array<string> | undefined {
  const kept: Array<string> = []
  let last: string | undefined
  for (const path of paths) {
    if (path === ".") return undefined
    if (last !== undefined && path.startsWith(`${last}/`)) continue
    kept.push(path)
    last = path
  }
  return kept
}

const byteOrder = (left: string, right: string) =>
  Buffer.compare(Buffer.from(left), Buffer.from(right))

const isMissing = (cause: unknown) =>
  Predicate.hasProperty(cause, "code") &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR")

// The path's entry, without following a symlink, or undefined when missing.
function entryAt(root: string, path: string) {
  return Effect.tryPromise({
    try: () => lstat(join(root, path), { bigint: true }),
    catch: (cause) => cause,
  }).pipe(
    Effect.map((stats): BigIntStats | undefined => stats),
    Effect.catchIf(isMissing, () => Effect.succeed(undefined)),
    Effect.mapError(
      (cause) => new GrpcFailure({ code: 2, message: errorText(cause) })
    )
  )
}

/**
 * fsutil's FollowLinks: each path, with every symlink on the way resolved
 * (inside the root, as BuildKit sees it), so following a Dockerfile that's
 * a symlink also sends what it points to.
 */
function followLinks(
  root: string,
  paths: ReadonlyArray<string>
): Effect.Effect<Array<string> | undefined, GrpcFailure> {
  return Effect.gen(function* () {
    const resolved = new Set<string>()
    const readSymlink = (
      path: string,
      allowWildcard: boolean
    ): Effect.Effect<Array<string> | undefined, GrpcFailure> =>
      Effect.gen(function* () {
        const base = path.split("/").at(-1) ?? path
        if (allowWildcard && containsWildcards(base)) {
          const directory = parentOf(path)
          const names = yield* Effect.tryPromise({
            try: () => readdir(join(root, directory)),
            catch: (cause) => cause,
          }).pipe(
            Effect.map((found): Array<string> | undefined => found),
            Effect.catchIf(isMissing, () => Effect.succeed(undefined)),
            Effect.mapError(
              (cause) =>
                new GrpcFailure({
                  code: 2,
                  message: `readdir: ${errorText(cause)}`,
                })
            )
          )
          if (names === undefined) return undefined
          const matcher = Result.getOrUndefined(
            Result.try(() => new PatternMatcher([base]))
          )
          let found: Array<string> | undefined
          for (const name of names.sort(byteOrder)) {
            if (!matcher?.matchesOrParentMatches(name)) continue
            const targets = yield* readSymlink(
              cleanPath(`${directory}/${name}`),
              false
            )
            if (targets?.length) found = [...(found ?? []), ...targets]
          }
          return found
        }
        if (path === "." || path === "/") return undefined
        const stats = yield* entryAt(root, path)
        if (!stats?.isSymbolicLink()) return undefined
        const link = cleanPath(
          yield* Effect.tryPromise({
            try: () => readlink(join(root, path)),
            catch: (cause) =>
              new GrpcFailure({ code: 2, message: errorText(cause) }),
          })
        )
        if (link.startsWith("/")) return [link]
        return [cleanPath(`/${parentOf(path)}/${link}`)]
      })
    const append = (start: string): Effect.Effect<void, GrpcFailure> =>
      Effect.gen(function* () {
        let remaining = cleanPath(`./${start}`)
        let current = "."
        for (;;) {
          const separator = remaining.indexOf("/")
          const part =
            separator === -1 ? remaining : remaining.slice(0, separator)
          current = cleanPath(`${current}/${part}`)
          const targets = yield* readSymlink(current, true)
          remaining = separator === -1 ? "" : remaining.slice(separator + 1)
          if (
            (remaining === "" || targets !== undefined) &&
            resolved.has(current)
          ) {
            return
          }
          if (targets !== undefined) {
            resolved.add(current)
            for (const target of targets) {
              yield* append(cleanPath(`${target}/${remaining}`))
            }
            return
          }
          if (remaining === "") {
            resolved.add(current)
            return
          }
        }
      })
    for (const path of paths) yield* append(path)
    return dedupePaths([...resolved].sort(byteOrder))
  })
}

function parentOf(path: string): string {
  const index = path.lastIndexOf("/")
  return index === -1 ? "." : index === 0 ? "/" : path.slice(0, index)
}

function containsWildcards(name: string): boolean {
  for (let index = 0; index < name.length; index += 1) {
    const character = name[index]
    if (character === "\\") index += 1
    else if (character === "*" || character === "?" || character === "[") {
      return true
    }
  }
  return false
}

interface VisitedDirectory {
  readonly path: string
  readonly absolute: string
  includeInfo: MatchInfo | undefined
  excludeInfo: MatchInfo | undefined
  emitted: boolean
}

/**
 * fsutil's filtered walk: the root's entries in Go's `WalkDir` order, each
 * included one passed to `emit` (after any parent directory not yet sent),
 * skipping excluded directories whole unless an exception could include
 * something in them.
 */
function walkContext(
  root: string,
  filter: Filter,
  emit: (entry: Entry) => Effect.Effect<void, GrpcFailure>
): Effect.Effect<void, GrpcFailure> {
  const filtered = filter.include !== undefined || filter.exclude !== undefined
  const parents: Array<VisitedDirectory> = []
  // Hard-linked files after the first are sent as links to it, by inode.
  const seen = new Map<bigint, string>()
  const fail = (cause: unknown) =>
    new GrpcFailure({ code: 2, message: errorText(cause) })
  const match = <A>(run: () => A) => Effect.try({ try: run, catch: fail })

  const statOf = (path: string, absolute: string) =>
    Effect.gen(function* () {
      const stats = yield* entryAt(root, path)
      if (stats === undefined) return undefined
      return yield* entryFor(path, absolute, stats, seen)
    })

  // "skip" is Go's SkipDir: don't walk into a directory, or (for a file)
  // skip the rest of its directory.
  const visit = (
    path: string,
    absolute: string,
    isDirectory: boolean,
    walkError: unknown
  ): Effect.Effect<"skip" | undefined, GrpcFailure> =>
    Effect.gen(function* () {
      let directory: VisitedDirectory | undefined
      if (filtered) {
        while (
          parents.length > 0 &&
          !path.startsWith(`${parents.at(-1)!.path}/`)
        ) {
          parents.pop()
        }
        if (isDirectory) {
          directory = {
            absolute,
            emitted: false,
            excludeInfo: undefined,
            includeInfo: undefined,
            path,
          }
        }
      }
      let skip = false
      if (filter.include) {
        const include = filter.include
        const [matched, info] = yield* match(() =>
          include.matchesUsingParentResults(path, parents.at(-1)?.includeInfo)
        )
        if (directory) directory.includeInfo = info
        if (!matched) {
          if (isDirectory && filter.onlyPrefixIncludes) {
            const couldMatch = include.patterns.some(
              (pattern) =>
                !pattern.exclusion &&
                `${withoutTrailingGlob(pattern.text)}/`.startsWith(`${path}/`)
            )
            if (!couldMatch) return "skip"
          }
          skip = true
        }
      }
      if (filter.exclude) {
        const exclude = filter.exclude
        const [matched, info] = yield* match(() =>
          exclude.matchesUsingParentResults(path, parents.at(-1)?.excludeInfo)
        )
        if (directory) directory.excludeInfo = info
        if (matched) {
          if (isDirectory && filter.onlyPrefixExcludeExceptions) {
            if (!exclude.exclusions) return "skip"
            const couldInclude = exclude.patterns.some(
              (pattern) =>
                pattern.exclusion &&
                `${withoutTrailingGlob(pattern.text)}/`.startsWith(`${path}/`)
            )
            if (!couldInclude) return "skip"
          }
          skip = true
        }
      }
      if (walkError !== undefined) {
        if (isMissing(walkError)) return "skip"
        if (
          skip &&
          Predicate.hasProperty(walkError, "code") &&
          (walkError.code === "EACCES" || walkError.code === "EPERM")
        ) {
          return undefined
        }
        return yield* fail(walkError)
      }
      const result = yield* Effect.gen(function* () {
        if (skip) return undefined
        if (directory) directory.emitted = true
        const entry = yield* statOf(path, absolute)
        if (entry === undefined) return "skip" as const
        for (const parent of parents) {
          if (parent.emitted) continue
          const parentEntry = yield* statOf(parent.path, parent.absolute)
          if (parentEntry === undefined) return "skip" as const
          parent.emitted = true
          yield* emit(parentEntry)
        }
        yield* emit(entry)
        return undefined
      })
      if (filtered && directory) parents.push(directory)
      return result
    })

  // Go's filepath.WalkDir below the root, in byte order.
  const walk = (
    relative: string,
    absolute: string
  ): Effect.Effect<void, GrpcFailure> =>
    Effect.gen(function* () {
      const listed = yield* Effect.result(
        Effect.tryPromise({
          try: () => readdir(absolute, { withFileTypes: true }),
          catch: (cause) => cause,
        })
      )
      if (Result.isFailure(listed)) {
        // A directory that can't be read is visited again with the error;
        // fsutil leaves a root it can't read empty.
        if (relative !== "") {
          yield* visit(relative, absolute, true, listed.failure)
        }
        return
      }
      const entries = listed.success.sort((left, right) =>
        byteOrder(left.name, right.name)
      )
      for (const entry of entries) {
        const path = relative ? `${relative}/${entry.name}` : entry.name
        const childAbsolute = join(absolute, entry.name)
        const isDirectory = entry.isDirectory()
        const result = yield* visit(path, childAbsolute, isDirectory, undefined)
        if (result === "skip") {
          if (isDirectory) continue
          return
        }
        if (isDirectory) yield* walk(path, childAbsolute)
      }
    })

  return walk("", root)
}

// fsutil's `mkstat`, with Go's FileMode bits.
function entryFor(
  path: string,
  absolute: string,
  stats: BigIntStats,
  seen: Map<bigint, string>
): Effect.Effect<Entry, GrpcFailure> {
  return Effect.gen(function* () {
    const unixMode = Number(stats.mode)
    let mode = unixMode & 0o777
    switch (unixMode & 0o170000) {
      case 0o060000:
        mode += MODE_DEVICE
        break
      case 0o020000:
        mode += MODE_DEVICE + MODE_CHAR_DEVICE
        break
      case 0o040000:
        mode += MODE_DIR
        break
      case 0o010000:
        mode += MODE_NAMED_PIPE
        break
      case 0o120000:
        mode += MODE_SYMLINK
        break
      // Sockets keep no type bit, as fsutil clears it.
    }
    if (unixMode & 0o4000) mode += MODE_SETUID
    if (unixMode & 0o2000) mode += MODE_SETGID
    if (unixMode & 0o1000) mode += MODE_STICKY
    const isDirectory = stats.isDirectory()
    let linkname = ""
    let size = 0n
    let devmajor = 0
    let devminor = 0
    if (!isDirectory) {
      const device = stats.rdev
      devmajor = Number((device >> 8n) & 0xfffn)
      devminor = Number((device & 0xffn) | ((device >> 12n) & 0xfff00n))
      size = stats.size
      const first = stats.nlink > 1n ? seen.get(stats.ino) : undefined
      if (first !== undefined) {
        linkname = first
        size = 0n
      } else {
        seen.set(stats.ino, path)
      }
      if (stats.isSymbolicLink()) {
        linkname = yield* Effect.tryPromise({
          try: () => readlink(absolute),
          catch: (cause) =>
            new GrpcFailure({ code: 2, message: errorText(cause) }),
        })
      }
    }
    return {
      absolute,
      devmajor,
      devminor,
      linkname,
      mode,
      modTime: stats.mtimeNs,
      path,
      size,
    }
  })
}
